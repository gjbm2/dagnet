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

console.log('[bayesPatchService] Module loaded');

const FIT_HISTORY_MAX_ENTRIES = 20;

// ── Quality gate for model_vars (doc 15 §3) ────────────────────────────────
// Same thresholds as bayesQualityTier 'failed' tier.
const RHAT_GATE = 1.1;
const ESS_GATE = 100;

function meetsQualityGate(prob: { ess: number; rhat: number | null; provenance: string }, divergences: number): boolean {
  if (prob.rhat != null && prob.rhat > RHAT_GATE) return false;
  if (divergences > 0 && prob.ess < ESS_GATE) return false;
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

export interface BayesPatchEdge {
  param_id: string;
  file_path: string;
  probability?: {
    alpha: number;
    beta: number;
    mean: number;
    stdev: number;
    hdi_lower: number;
    hdi_upper: number;
    hdi_level: number;
    ess: number;
    rhat: number | null;
    provenance: string;
  };
  latency?: {
    mu_mean: number;
    mu_sd: number;
    sigma_mean: number;
    sigma_sd: number;
    hdi_t95_lower: number;
    hdi_t95_upper: number;
    hdi_level: number;
    ess: number;
    rhat: number | null;
    provenance: string;
    // Edge-level onset posterior (Phase D.O) — present when onset is latent
    onset_mean?: number;
    onset_sd?: number;
    onset_hdi_lower?: number;
    onset_hdi_upper?: number;
    onset_mu_corr?: number;
    // Path-level (cohort) latency — present when cohort latency is fitted
    path_onset_delta_days?: number;
    path_onset_sd?: number;
    path_onset_hdi_lower?: number;
    path_onset_hdi_upper?: number;
    path_mu_mean?: number;
    path_mu_sd?: number;
    path_sigma_mean?: number;
    path_sigma_sd?: number;
    path_provenance?: string;
  };
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
      `Updated ${edge.param_id}: posterior=${!!edge.probability} latency=${!!edge.latency}`);
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
    // per-edge posteriors in one update. Strips fit_history/slices/_model_state
    // (same as the cascade's transform in mappingConfigurations.ts).
    for (const patchEdge of patch.edges) {
      const graphEdge = graphDoc.edges?.find(
        (e: any) => e.p?.id === patchEdge.param_id
      );
      if (!graphEdge?.p) continue;

      if (patchEdge.probability) {
        const prob = patchEdge.probability;
        // NOTE (doc 15 §7, Option A): Do NOT overwrite p.mean/p.stdev from
        // the Bayesian posterior. Those stay as analytic pipeline output.
        // The Bayesian mean lives in the model_vars entry and is promoted
        // to p.mean only when the resolution function selects it.
        graphEdge.p.posterior = {
          distribution: 'beta',
          alpha: prob.alpha,
          beta: prob.beta,
          hdi_lower: prob.hdi_lower,
          hdi_upper: prob.hdi_upper,
          hdi_level: prob.hdi_level,
          ess: prob.ess,
          rhat: prob.rhat,
          evidence_grade: prob.ess >= 400 && (prob.rhat === null || prob.rhat < 1.05) ? 3 : 0,
          fitted_at: patch.fitted_at,
          fingerprint: patch.fingerprint,
          provenance: prob.provenance,
        };
      }

      if (patchEdge.latency && graphEdge.p.latency) {
        const lat = patchEdge.latency;
        graphEdge.p.latency.posterior = {
          distribution: 'lognormal',
          onset_delta_days: graphEdge.p.latency.onset_delta_days ?? 0,
          mu_mean: lat.mu_mean,
          mu_sd: lat.mu_sd,
          sigma_mean: lat.sigma_mean,
          sigma_sd: lat.sigma_sd,
          hdi_t95_lower: lat.hdi_t95_lower,
          hdi_t95_upper: lat.hdi_t95_upper,
          hdi_level: lat.hdi_level,
          ess: lat.ess,
          rhat: lat.rhat,
          fitted_at: patch.fitted_at,
          fingerprint: patch.fingerprint,
          provenance: lat.provenance,
          // Edge-level onset posterior (Phase D.O)
          ...(lat.onset_mean != null ? {
            onset_mean: lat.onset_mean,
            onset_sd: lat.onset_sd,
            onset_hdi_lower: lat.onset_hdi_lower,
            onset_hdi_upper: lat.onset_hdi_upper,
            ...(lat.onset_mu_corr != null ? { onset_mu_corr: lat.onset_mu_corr } : {}),
          } : {}),
          // Path-level (cohort) latency
          ...(lat.path_mu_mean != null ? {
            path_onset_delta_days: lat.path_onset_delta_days,
            path_onset_sd: lat.path_onset_sd,
            path_onset_hdi_lower: lat.path_onset_hdi_lower,
            path_onset_hdi_upper: lat.path_onset_hdi_upper,
            path_mu_mean: lat.path_mu_mean,
            path_mu_sd: lat.path_mu_sd,
            path_sigma_mean: lat.path_sigma_mean,
            path_sigma_sd: lat.path_sigma_sd,
            path_provenance: lat.path_provenance,
          } : {}),
        };
      }

      // ── Upsert Bayesian model_vars entry (doc 15 §5.2) ──────────────
      if (patchEdge.probability) {
        const prob = patchEdge.probability;
        const lat = patchEdge.latency;
        const divergences = 'divergences' in prob ? (prob as any).divergences ?? 0 : 0;
        const gated = meetsQualityGate(prob, divergences);

        const bayesEntry: ModelVarsEntry = {
          source: 'bayesian',
          source_at: patch.fitted_at,
          probability: {
            mean: prob.alpha / (prob.alpha + prob.beta),
            stdev: Math.sqrt(
              (prob.alpha * prob.beta) /
              ((prob.alpha + prob.beta) ** 2 * (prob.alpha + prob.beta + 1))
            ),
          },
          ...(lat ? {
            latency: {
              mu: lat.mu_mean,
              sigma: lat.sigma_mean,
              t95: Math.exp(lat.mu_mean + 1.645 * lat.sigma_mean) + (lat.onset_mean ?? graphEdge.p.latency?.onset_delta_days ?? 0),
              onset_delta_days: lat.onset_mean ?? graphEdge.p.latency?.onset_delta_days ?? 0,
              ...(lat.path_mu_mean != null ? {
                path_mu: lat.path_mu_mean,
                path_sigma: lat.path_sigma_mean,
                path_t95: Math.exp(lat.path_mu_mean + 1.645 * (lat.path_sigma_mean ?? 0)) + (lat.path_onset_delta_days ?? 0),
              } : {}),
            },
          } : {}),
          quality: {
            rhat: prob.rhat ?? 0,
            ess: prob.ess,
            divergences,
            evidence_grade: prob.ess >= 400 && (prob.rhat === null || prob.rhat < 1.05) ? 3 : 0,
            gate_passed: gated,
          },
        };

        upsertModelVars(graphEdge.p, bayesEntry);

        // Run resolution to update promoted scalars (doc 15 §8)
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

// --- Posterior merge logic (moved from webhook handler) ---

function mergePosteriorsIntoParam(
  paramDoc: any,
  edge: BayesPatchEdge,
  fittedAt: string,
  fingerprint: string,
): void {
  if (edge.probability) {
    const prob = edge.probability;

    // NOTE (doc 15 §7, Option A): Do NOT overwrite values[0].mean/stdev
    // from the Bayesian posterior. values[0].mean stays as the analytic
    // pipeline output (k/n from evidence or blend). The Bayesian mean
    // lives in posterior.alpha/beta and in model_vars.

    // Append to fit_history BEFORE overwriting posterior
    const existingPosterior = paramDoc.posterior;
    if (existingPosterior?.alpha != null && existingPosterior?.beta != null) {
      if (!Array.isArray(paramDoc.posterior.fit_history)) {
        paramDoc.posterior.fit_history = [];
      }
      paramDoc.posterior.fit_history.push({
        fitted_at: existingPosterior.fitted_at ?? fittedAt,
        alpha: existingPosterior.alpha,
        beta: existingPosterior.beta,
        hdi_lower: existingPosterior.hdi_lower ?? 0,
        hdi_upper: existingPosterior.hdi_upper ?? 1,
        rhat: existingPosterior.rhat ?? 0,
        divergences: existingPosterior.divergences ?? 0,
      });
      if (paramDoc.posterior.fit_history.length > FIT_HISTORY_MAX_ENTRIES) {
        paramDoc.posterior.fit_history = paramDoc.posterior.fit_history.slice(
          -FIT_HISTORY_MAX_ENTRIES,
        );
      }
    }

    const fitHistory = paramDoc.posterior?.fit_history ?? [];

    paramDoc.posterior = {
      distribution: 'beta',
      alpha: prob.alpha,
      beta: prob.beta,
      hdi_lower: prob.hdi_lower,
      hdi_upper: prob.hdi_upper,
      hdi_level: prob.hdi_level,
      ess: prob.ess,
      rhat: prob.rhat,
      evidence_grade: prob.ess >= 400 && (prob.rhat === null || prob.rhat < 1.05) ? 3 : 0,
      fitted_at: fittedAt,
      fingerprint,
      provenance: prob.provenance,
      ...(fitHistory.length > 0 ? { fit_history: fitHistory } : {}),
    };
  }

  if (edge.latency) {
    const lat = edge.latency;

    if (!paramDoc.latency) paramDoc.latency = {};

    const existingLatPosterior = paramDoc.latency.posterior;
    if (existingLatPosterior?.mu_mean != null) {
      if (!Array.isArray(paramDoc.latency.posterior.fit_history)) {
        paramDoc.latency.posterior.fit_history = [];
      }
      paramDoc.latency.posterior.fit_history.push({
        fitted_at: existingLatPosterior.fitted_at ?? fittedAt,
        mu_mean: existingLatPosterior.mu_mean,
        sigma_mean: existingLatPosterior.sigma_mean,
        onset_delta_days: existingLatPosterior.onset_delta_days ?? 0,
        rhat: existingLatPosterior.rhat ?? 0,
        divergences: existingLatPosterior.divergences ?? 0,
      });
      if (paramDoc.latency.posterior.fit_history.length > FIT_HISTORY_MAX_ENTRIES) {
        paramDoc.latency.posterior.fit_history = paramDoc.latency.posterior.fit_history.slice(
          -FIT_HISTORY_MAX_ENTRIES,
        );
      }
    }

    const latFitHistory = paramDoc.latency.posterior?.fit_history ?? [];

    // NOTE: Do NOT overwrite latency.mu/latency.sigma — those are analytic
    // LAG pass values. Bayesian values live in latency.posterior.
    paramDoc.latency.model_trained_at = fittedAt;

    paramDoc.latency.posterior = {
      distribution: 'lognormal',
      onset_delta_days: paramDoc.latency.onset_delta_days ?? 0,
      mu_mean: lat.mu_mean,
      mu_sd: lat.mu_sd,
      sigma_mean: lat.sigma_mean,
      sigma_sd: lat.sigma_sd,
      hdi_t95_lower: lat.hdi_t95_lower,
      hdi_t95_upper: lat.hdi_t95_upper,
      hdi_level: lat.hdi_level,
      ess: lat.ess,
      rhat: lat.rhat,
      fitted_at: fittedAt,
      fingerprint,
      provenance: lat.provenance,
      ...(latFitHistory.length > 0 ? { fit_history: latFitHistory } : {}),
      // Edge-level onset posterior (Phase D.O)
      ...(lat.onset_mean != null ? {
        onset_mean: lat.onset_mean,
        onset_sd: lat.onset_sd,
        onset_hdi_lower: lat.onset_hdi_lower,
        onset_hdi_upper: lat.onset_hdi_upper,
        ...(lat.onset_mu_corr != null ? { onset_mu_corr: lat.onset_mu_corr } : {}),
      } : {}),
      // Path-level (cohort) latency — present when cohort latency is fitted
      ...(lat.path_mu_mean != null ? {
        path_onset_delta_days: lat.path_onset_delta_days,
        path_onset_sd: lat.path_onset_sd,
        path_onset_hdi_lower: lat.path_onset_hdi_lower,
        path_onset_hdi_upper: lat.path_onset_hdi_upper,
        path_mu_mean: lat.path_mu_mean,
        path_mu_sd: lat.path_mu_sd,
        path_sigma_mean: lat.path_sigma_mean,
        path_sigma_sd: lat.path_sigma_sd,
        path_provenance: lat.path_provenance,
      } : {}),
    };
  }
}
