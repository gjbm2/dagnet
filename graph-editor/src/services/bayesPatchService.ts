/**
 * Bayes Patch Service
 *
 * Detects and applies Bayes posterior patch files committed by the webhook.
 * The webhook writes `_bayes/patch-{job_id}.json` to git; this service
 * reads those files on pull, upserts posterior data into local parameter
 * and graph files, and marks them dirty for the normal commit flow.
 *
 * See: docs/current/project-bayes/4-async-roundtrip-infrastructure.md
 *      § "Return path re-architecture: patch file model"
 */

import type { ModelVarsEntry, ModelVarsQuality } from '../types';
import { fileRegistry } from '../contexts/TabContext';
import { sessionLogService } from './sessionLogService';
import { upsertModelVars, ukDateNow, applyPromotion } from './modelVarsResolution';
import { parseUKDate } from '../lib/dateFormat';
import { BAYES_FIT_HISTORY_MAX_DAYS, BAYES_FIT_HISTORY_INTERVAL_DAYS } from '../constants/latency';
import type { FitHistorySlice } from '../types';

console.log('[bayesPatchService] Module loaded');

// ── Quality gate for model_vars (doc 15 §3) ────────────────────────────────
// Same thresholds as bayesQualityTier 'failed' tier.
const RHAT_GATE = 1.1;
const ESS_GATE = 100;

function meetsQualityGate(
  prob: { ess: number; rhat: number | null; provenance: string },
  divergences: number,
  latency?: { ess?: number; rhat?: number | null } | null,
): boolean {
  if (prob.rhat != null && prob.rhat > RHAT_GATE) return false;
  if (divergences > 0 && prob.ess < ESS_GATE) return false;
  // Latency posterior must also pass if present — a converged probability
  // with a nonsensical latency (rhat=1.7, ess=6) is not usable.
  if (latency) {
    if (latency.rhat != null && latency.rhat > RHAT_GATE) return false;
    if (latency.ess != null && latency.ess < ESS_GATE) return false;
  }
  return true;
}

// --- Direct fetch + apply (happy path: browser is open) ---

/**
 * Fetch a single patch file from git by path and apply it locally.
 * Used by useBayesTrigger when the job completes while the browser is open.
 * No full pull needed — just reads one file via GitHub Contents API.
 *
 * Returns the number of edges updated.
 */
export async function fetchAndApplyPatch(args: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  patchPath: string;
  graphId: string;
}): Promise<number> {
  const { owner, repo, branch, token, patchPath, graphId } = args;

  // Fetch the patch file from GitHub
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${patchPath}?ref=${branch}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'dagnet-bayes-patch',
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      // Patch file not yet committed (webhook may still be in flight)
      throw new Error(`Patch file not found: ${patchPath} (webhook may not have committed yet)`);
    }
    throw new Error(`Failed to fetch patch: ${resp.status}`);
  }

  console.log(`[bayesPatchService] GitHub API responded, parsing...`);
  let data: any;
  try {
    data = await resp.json();
    console.log(`[bayesPatchService] Got response JSON, content length: ${data.content?.length ?? 'no content'}`);
  } catch (parseErr: any) {
    console.error(`[bayesPatchService] Failed to parse GitHub response:`, parseErr);
    throw parseErr;
  }
  // GitHub returns base64 with newlines — strip them before decoding
  const content = atob(data.content.replace(/\n/g, ''));
  console.log(`[bayesPatchService] Decoded patch, content length: ${content.length}`);
  const patch: BayesPatchFile = JSON.parse(content);
  console.log(`[bayesPatchService] Parsed patch: ${patch.edges.length} edges, job_id: ${patch.job_id}`);

  // Apply the patch
  const edgesUpdated = await applyPatch(patch);

  // Delete the patch file from git (cleanup)
  try {
    await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'dagnet-bayes-patch',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: `[bayes] Applied patch ${patch.job_id}`,
        sha: data.sha,
        branch,
      }),
    });
    sessionLogService.info('bayes', 'BAYES_PATCH_DELETED',
      `Deleted applied patch: ${patchPath}`);
  } catch {
    // Non-fatal — patch will be cleaned up on next pull or manually
    sessionLogService.warning('bayes', 'BAYES_PATCH_DELETE_FAILED',
      `Could not delete patch file: ${patchPath}`);
  }

  return edgesUpdated;
}

// --- Patch file types ---

/** Unified patch edge shape (doc 21) — per-slice entries carry both p and latency. */
export interface BayesPatchEdge {
  param_id: string;
  file_path: string;
  slices?: Record<string, {
    alpha: number;
    beta: number;
    p_hdi_lower: number;
    p_hdi_upper: number;
    mu_mean?: number;
    mu_sd?: number;
    sigma_mean?: number;
    sigma_sd?: number;
    onset_mean?: number;
    onset_sd?: number;
    hdi_t95_lower?: number;
    hdi_t95_upper?: number;
    onset_mu_corr?: number;
    ess: number;
    rhat: number | null;
    divergences: number;
    evidence_grade: number;
    provenance: string;
  }>;
  _model_state?: Record<string, number>;
  prior_tier?: string;
  evidence_grade?: number;
  divergences?: number;
}

export interface BayesPatchFile {
  job_id: string;
  graph_id: string;
  graph_file_path: string;
  fitted_at: string;
  fingerprint: string;
  model_version: number;
  quality: {
    max_rhat: number | null;
    min_ess: number | null;
    converged_pct: number;
  };
  edges: BayesPatchEdge[];
  skipped: Array<{ param_id: string; reason: string }>;
}

// --- Application ---

/**
 * Apply a Bayes patch: upsert posteriors into local parameter files
 * and _bayes metadata into the local graph file.
 *
 * Returns the number of edges updated.
 */
export async function applyPatch(patch: BayesPatchFile): Promise<number> {
  const logOpId = sessionLogService.startOperation(
    'info', 'bayes', 'BAYES_PATCH_APPLY',
    `Applying Bayes patch ${patch.job_id} (${patch.edges.length} edges)`,
  );

  let edgesUpdated = 0;

  // Log available file IDs for diagnostics
  const allFileIds = fileRegistry.getAllFiles().map((f: any) => f.fileId);
  console.log(`[bayesPatchService] FileRegistry has ${allFileIds.length} files. Param files:`,
    allFileIds.filter((id: string) => id.includes('parameter')).slice(0, 10));

  for (const edge of patch.edges) {
    const paramFileId = `parameter-${edge.param_id}`;
    const paramFile = fileRegistry.getFile(paramFileId);

    console.log(`[bayesPatchService] Looking for ${paramFileId}: found=${!!paramFile}`);

    if (!paramFile || !paramFile.data) {
      sessionLogService.addChild(logOpId, 'warning', 'PATCH_SKIP_PARAM',
        `Parameter file not found: ${edge.param_id} (tried ID: ${paramFileId})`);
      continue;
    }

    const paramDoc = paramFile.data as any;
    mergePosteriorsIntoParam(paramDoc, edge, patch.fitted_at, patch.fingerprint);

    // Mark dirty so normal commit flow picks it up
    await fileRegistry.updateFile(paramFileId, paramDoc);
    edgesUpdated++;

    sessionLogService.addChild(logOpId, 'info', 'PATCH_EDGE_APPLIED',
      `Updated ${edge.param_id}: slices=${Object.keys(edge.slices || {}).join(',')}`);
  }

  // Upsert _bayes and edge posteriors on the graph
  const graphFile = fileRegistry.getFile(patch.graph_id);
  if (graphFile && graphFile.data) {
    const graphDoc = graphFile.data as any;
    graphDoc._bayes = {
      fitted_at: patch.fitted_at,
      fingerprint: patch.fingerprint,
      model_version: patch.model_version,
      settings_signature: '',
      quality: {
        max_rhat: patch.quality.max_rhat,
        min_ess: patch.quality.min_ess,
        converged_pct: patch.quality.converged_pct,
      },
    };

    // Also upsert posterior summaries directly onto graph edges.
    // This mirrors what the UpdateManager cascade does (file → graph),
    // but done atomically here so the graph in IDB has both _bayes and
    // per-edge posteriors in one update. Projects from unified slices
    // (doc 21) onto the graph-edge shapes that UI components expect.
    for (const patchEdge of patch.edges) {
      const graphEdge = graphDoc.edges?.find(
        (e: any) => e.p?.id === patchEdge.param_id
      );
      if (!graphEdge?.p) continue;

      const slices = patchEdge.slices || {};
      const windowSlice = slices['window()'];
      const cohortSlice = slices['cohort()'];

      // Project probability posterior summary onto graph edge (ProbabilityPosterior shape)
      if (windowSlice) {
        graphEdge.p.posterior = {
          distribution: 'beta',
          alpha: windowSlice.alpha,
          beta: windowSlice.beta,
          hdi_lower: windowSlice.p_hdi_lower,
          hdi_upper: windowSlice.p_hdi_upper,
          hdi_level: 0.9,
          ess: windowSlice.ess,
          rhat: windowSlice.rhat,
          evidence_grade: windowSlice.evidence_grade,
          fitted_at: patch.fitted_at,
          fingerprint: patch.fingerprint,
          provenance: windowSlice.provenance,
          divergences: windowSlice.divergences,
          prior_tier: patchEdge.prior_tier || 'uninformative',
          // Path-level from cohort() slice
          ...(cohortSlice?.alpha != null ? {
            path_alpha: cohortSlice.alpha,
            path_beta: cohortSlice.beta,
            path_hdi_lower: cohortSlice.p_hdi_lower,
            path_hdi_upper: cohortSlice.p_hdi_upper,
            path_provenance: cohortSlice.provenance,
          } : {}),
        };
      }

      // Project latency posterior summary onto graph edge (LatencyPosterior shape)
      if (windowSlice?.mu_mean != null && graphEdge.p.latency) {
        graphEdge.p.latency.posterior = {
          distribution: 'lognormal',
          onset_delta_days: windowSlice.onset_mean ?? graphEdge.p.latency.onset_delta_days ?? 0,
          mu_mean: windowSlice.mu_mean,
          mu_sd: windowSlice.mu_sd,
          sigma_mean: windowSlice.sigma_mean,
          sigma_sd: windowSlice.sigma_sd,
          hdi_t95_lower: windowSlice.hdi_t95_lower,
          hdi_t95_upper: windowSlice.hdi_t95_upper,
          hdi_level: 0.9,
          ess: windowSlice.ess,
          rhat: windowSlice.rhat,
          fitted_at: patch.fitted_at,
          fingerprint: patch.fingerprint,
          provenance: windowSlice.provenance,
          ...(windowSlice.onset_mean != null ? {
            onset_mean: windowSlice.onset_mean,
            onset_sd: windowSlice.onset_sd,
          } : {}),
          ...(windowSlice.onset_mu_corr != null ? { onset_mu_corr: windowSlice.onset_mu_corr } : {}),
          // Path-level from cohort slice
          ...(cohortSlice?.mu_mean != null ? {
            path_onset_delta_days: cohortSlice.onset_mean,
            path_onset_sd: cohortSlice.onset_sd,
            path_mu_mean: cohortSlice.mu_mean,
            path_mu_sd: cohortSlice.mu_sd,
            path_sigma_mean: cohortSlice.sigma_mean,
            path_sigma_sd: cohortSlice.sigma_sd,
            ...(cohortSlice.hdi_t95_lower != null ? { path_hdi_t95_lower: cohortSlice.hdi_t95_lower, path_hdi_t95_upper: cohortSlice.hdi_t95_upper } : {}),
            ...(cohortSlice.onset_mu_corr != null ? { path_onset_mu_corr: cohortSlice.onset_mu_corr } : {}),
            path_provenance: cohortSlice.provenance,
          } : {}),
        };
      }

      // ── Upsert Bayesian model_vars entry (doc 15 §5.2) ──────────────
      if (windowSlice) {
        const divergences = windowSlice.divergences ?? 0;
        const gated = meetsQualityGate(
          { ess: windowSlice.ess, rhat: windowSlice.rhat, provenance: windowSlice.provenance },
          divergences,
          windowSlice.mu_mean != null ? { ess: windowSlice.ess, rhat: windowSlice.rhat } : undefined,
        );

        const bayesEntry: ModelVarsEntry = {
          source: 'bayesian',
          source_at: patch.fitted_at,
          probability: {
            mean: windowSlice.alpha / (windowSlice.alpha + windowSlice.beta),
            stdev: Math.sqrt(
              (windowSlice.alpha * windowSlice.beta) /
              ((windowSlice.alpha + windowSlice.beta) ** 2 * (windowSlice.alpha + windowSlice.beta + 1))
            ),
          },
          ...(windowSlice.mu_mean != null ? {
            latency: {
              mu: windowSlice.mu_mean,
              sigma: windowSlice.sigma_mean!,
              t95: Math.exp(windowSlice.mu_mean + 1.645 * windowSlice.sigma_mean!) + (windowSlice.onset_mean ?? graphEdge.p.latency?.onset_delta_days ?? 0),
              onset_delta_days: windowSlice.onset_mean ?? graphEdge.p.latency?.onset_delta_days ?? 0,
              ...(cohortSlice?.mu_mean != null ? {
                path_mu: cohortSlice.mu_mean,
                path_sigma: cohortSlice.sigma_mean,
                path_t95: Math.exp(cohortSlice.mu_mean + 1.645 * (cohortSlice.sigma_mean ?? 0)) + (cohortSlice.onset_mean ?? 0),
                path_onset_delta_days: cohortSlice.onset_mean ?? 0,
              } : {}),
            },
          } : {}),
          quality: {
            rhat: windowSlice.rhat ?? 0,
            ess: windowSlice.ess,
            divergences,
            evidence_grade: windowSlice.evidence_grade,
            gate_passed: gated,
          },
        };

        upsertModelVars(graphEdge.p, bayesEntry);
        applyPromotion(graphEdge.p, graphDoc.model_source_preference);
      }
    }

    await fileRegistry.updateFile(patch.graph_id, graphDoc);
    sessionLogService.addChild(logOpId, 'info', 'PATCH_GRAPH_UPDATED',
      `Updated _bayes + edge posteriors + model_vars on ${patch.graph_id}`);
  }

  sessionLogService.endOperation(logOpId, 'success',
    `Patch applied: ${edgesUpdated}/${patch.edges.length} edges updated`);

  return edgesUpdated;
}

// --- Posterior merge logic (doc 21: unified posterior schema) ---

function mergePosteriorsIntoParam(
  paramDoc: any,
  edge: BayesPatchEdge,
  fittedAt: string,
  fingerprint: string,
): void {
  const slices = edge.slices;
  if (!slices || Object.keys(slices).length === 0) return;

  // NOTE (doc 15 §7, Option A): Do NOT overwrite values[0].mean/stdev
  // from the Bayesian posterior. The Bayesian mean lives in posterior.slices
  // and in model_vars.

  // Append existing slices to fit_history BEFORE overwriting (doc 27 §3)
  const existingPosterior = paramDoc.posterior;
  const fitHistory: any[] = existingPosterior?.fit_history ?? [];
  if (existingPosterior?.slices && Object.keys(existingPosterior.slices).length > 0) {
    // Interval filtering: skip append if last entry is too recent (doc 27 §4.3)
    let shouldAppend = true;
    if (BAYES_FIT_HISTORY_INTERVAL_DAYS > 0 && fitHistory.length > 0) {
      const lastEntry = fitHistory[fitHistory.length - 1];
      try {
        const lastDate = parseUKDate(lastEntry.fitted_at);
        const existingDate = parseUKDate(existingPosterior.fitted_at ?? fittedAt);
        const daysDiff = (existingDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff < BAYES_FIT_HISTORY_INTERVAL_DAYS) shouldAppend = false;
      } catch { /* parse failure — append anyway */ }
    }

    if (shouldAppend) {
      // Full-fidelity: store complete SlicePosteriorEntry, not slim subset
      fitHistory.push({
        fitted_at: existingPosterior.fitted_at ?? fittedAt,
        fingerprint: existingPosterior.fingerprint ?? fingerprint,
        hdi_level: existingPosterior.hdi_level ?? 0.9,
        prior_tier: existingPosterior.prior_tier ?? 'uninformative',
        slices: { ...existingPosterior.slices },
      });

      // Date-based eviction: remove entries older than max_days (doc 27 §4.2)
      if (fitHistory.length > 1) {
        try {
          const newestDate = parseUKDate(fitHistory[fitHistory.length - 1].fitted_at);
          const cutoffMs = newestDate.getTime() - BAYES_FIT_HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
          const firstKeep = fitHistory.findIndex((e: any) => {
            try { return parseUKDate(e.fitted_at).getTime() >= cutoffMs; }
            catch { return true; }
          });
          if (firstKeep > 0) fitHistory.splice(0, firstKeep);
        } catch { /* parse failure — skip eviction */ }
      }
    }
  }

  // Write unified posterior (doc 21 §3.3)
  paramDoc.posterior = {
    fitted_at: fittedAt,
    fingerprint,
    hdi_level: 0.9,
    prior_tier: edge.prior_tier || 'uninformative',
    slices,
    ...(edge._model_state ? { _model_state: edge._model_state } : {}),
    ...(fitHistory.length > 0 ? { fit_history: fitHistory } : {}),
  };

  // Update latency.model_trained_at if latency data present
  const windowSlice = slices['window()'];
  if (windowSlice?.mu_mean != null) {
    if (!paramDoc.latency) paramDoc.latency = {};
    paramDoc.latency.model_trained_at = fittedAt;
  }

  // Remove legacy latency.posterior if it exists (doc 21: no longer used)
  if (paramDoc.latency?.posterior) {
    delete paramDoc.latency.posterior;
  }

  // Doc 19 §4.5: clear bayes_reset after successful posterior write.
  // The flag told the evidence binder to skip warm-start on this run;
  // now that a fresh posterior exists, the flag is no longer needed.
  if (paramDoc.latency?.bayes_reset) {
    delete paramDoc.latency.bayes_reset;
  }
}
