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

import type { ModelVarsEntry, ModelVarsQuality, Graph } from '../types';
import { fileRegistry } from '../contexts/TabContext';
import { getGraphStore } from '../contexts/GraphStoreContext';
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

// --- Direct fetch + apply + cascade (happy path: browser is open) ---

/**
 * Fetch a single patch file from git by path, apply it locally, and
 * cascade posteriors through the graph (if open in a tab).
 *
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

  // Apply the patch + cascade (shared two-tier function, doc 28 §8.2)
  const { edgesUpdated } = await applyPatchAndCascade(patch, graphId);

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
    // Predictive (kappa-inflated, doc 49 §A.6). Absent when kappa is absent.
    alpha_pred?: number;
    beta_pred?: number;
    hdi_lower_pred?: number;
    hdi_upper_pred?: number;
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
    // LOO-ELPD model adequacy scoring (doc 32)
    delta_elpd?: number | null;
    pareto_k_max?: number | null;
    n_loo_obs?: number | null;
    // PPC calibration (doc 38)
    ppc_coverage_90?: number | null;
    ppc_n_obs?: number | null;
    ppc_traj_coverage_90?: number | null;
    ppc_traj_n_obs?: number | null;
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

    sessionLogService.addChild(logOpId, 'debug', 'PATCH_EDGE_APPLIED',
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
          // Cohort-mode probability from cohort() slice
          ...(cohortSlice?.alpha != null ? {
            cohort_alpha: cohortSlice.alpha,
            cohort_beta: cohortSlice.beta,
            cohort_hdi_lower: cohortSlice.p_hdi_lower,
            cohort_hdi_upper: cohortSlice.p_hdi_upper,
            cohort_provenance: cohortSlice.provenance,
          } : {}),
          // LOO-ELPD model adequacy (doc 32)
          ...(windowSlice.delta_elpd != null ? {
            delta_elpd: windowSlice.delta_elpd,
            pareto_k_max: windowSlice.pareto_k_max,
            n_loo_obs: windowSlice.n_loo_obs,
          } : {}),
          // PPC calibration (doc 38)
          ...(windowSlice.ppc_coverage_90 != null ? {
            ppc_coverage_90: windowSlice.ppc_coverage_90,
            ppc_n_obs: windowSlice.ppc_n_obs,
          } : {}),
          ...(windowSlice.ppc_traj_coverage_90 != null ? {
            ppc_traj_coverage_90: windowSlice.ppc_traj_coverage_90,
            ppc_traj_n_obs: windowSlice.ppc_traj_n_obs,
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
          // LOO-ELPD model adequacy (doc 32)
          ...(windowSlice.delta_elpd != null ? {
            delta_elpd: windowSlice.delta_elpd,
            pareto_k_max: windowSlice.pareto_k_max,
            n_loo_obs: windowSlice.n_loo_obs,
          } : {}),
          // PPC calibration (doc 38)
          ...(windowSlice.ppc_traj_coverage_90 != null ? {
            ppc_traj_coverage_90: windowSlice.ppc_traj_coverage_90,
            ppc_traj_n_obs: windowSlice.ppc_traj_n_obs,
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

        // For model_vars display: use predictive alpha/beta when available
        // (gives the "how noisy are daily observations" stdev), fall back to
        // epistemic when kappa absent (doc 49 §A.9).
        const displayAlpha = windowSlice.alpha_pred ?? windowSlice.alpha;
        const displayBeta = windowSlice.beta_pred ?? windowSlice.beta;
        const displaySum = displayAlpha + displayBeta;

        const bayesEntry: ModelVarsEntry = {
          source: 'bayesian',
          source_at: patch.fitted_at,
          probability: {
            mean: windowSlice.alpha / (windowSlice.alpha + windowSlice.beta),
            stdev: displaySum > 0
              ? Math.sqrt((displayAlpha * displayBeta) / (displaySum ** 2 * (displaySum + 1)))
              : 0,
          },
          ...(windowSlice.mu_mean != null ? {
            latency: {
              mu: windowSlice.mu_mean,
              sigma: windowSlice.sigma_mean!,
              t95: Math.exp(windowSlice.mu_mean + 1.645 * windowSlice.sigma_mean!) + (windowSlice.onset_mean ?? graphEdge.p.latency?.onset_delta_days ?? 0),
              onset_delta_days: windowSlice.onset_mean ?? graphEdge.p.latency?.onset_delta_days ?? 0,
              // Dispersions from posterior (required for MC fan bands and completeness_sd)
              ...(windowSlice.mu_sd != null ? { mu_sd: windowSlice.mu_sd } : {}),
              ...(windowSlice.sigma_sd != null ? { sigma_sd: windowSlice.sigma_sd } : {}),
              ...(windowSlice.onset_sd != null ? { onset_sd: windowSlice.onset_sd } : {}),
              ...(windowSlice.onset_mu_corr != null ? { onset_mu_corr: windowSlice.onset_mu_corr } : {}),
              ...(cohortSlice?.mu_mean != null ? {
                path_mu: cohortSlice.mu_mean,
                path_sigma: cohortSlice.sigma_mean,
                path_t95: Math.exp(cohortSlice.mu_mean + 1.645 * (cohortSlice.sigma_mean ?? 0)) + (cohortSlice.onset_mean ?? 0),
                path_onset_delta_days: cohortSlice.onset_mean ?? 0,
                ...(cohortSlice.mu_sd != null ? { path_mu_sd: cohortSlice.mu_sd } : {}),
                ...(cohortSlice.sigma_sd != null ? { path_sigma_sd: cohortSlice.sigma_sd } : {}),
                ...(cohortSlice.onset_sd != null ? { path_onset_sd: cohortSlice.onset_sd } : {}),
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
    sessionLogService.addChild(logOpId, 'debug', 'PATCH_GRAPH_UPDATED',
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

// ── Per-graph mutex for applyPatchAndCascade (doc 28 §8.16 point 5) ──────
// Prevents concurrent application to the same graph (scanner + happy path race).
const _applyMutexes = new Map<string, Promise<void>>();

function withGraphMutex<T>(graphId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _applyMutexes.get(graphId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even if previous errored)
  _applyMutexes.set(graphId, next.then(() => {}, () => {})); // swallow result, keep chain
  return next;
}

// ── applyPatchAndCascade (doc 28 §8.2) ───────────────────────────────────
//
// Shared function used by both the happy path (useBayesTrigger, browser open)
// and the on-pull scanner (Phase 3). Two-tier cascade:
//
// Tier 1 (always): apply patch to param files + graph _bayes block via
//   applyPatch(). No React dependency.
// Tier 2 (only if GraphStore is mounted): sync FileRegistry → GraphStore,
//   run per-edge getParameterFromFile, run latency promotion, write back.
//   When the graph is not open in a tab, tier 2 is skipped — the cascade
//   happens naturally when the user opens the graph.

export interface ApplyPatchAndCascadeResult {
  edgesUpdated: number;
}

/**
 * Apply a Bayes patch and cascade posteriors through the graph.
 *
 * Tier 1 writes posteriors to param files + _bayes block (always runs).
 * Tier 2 cascades to GraphStore (only if the graph is open in a tab).
 *
 * Per-graph mutex prevents concurrent application.
 */
export function applyPatchAndCascade(
  patch: BayesPatchFile,
  graphId: string,
): Promise<ApplyPatchAndCascadeResult> {
  return withGraphMutex(graphId, () => _applyPatchAndCascadeInner(patch, graphId));
}

async function _applyPatchAndCascadeInner(
  patch: BayesPatchFile,
  graphId: string,
): Promise<ApplyPatchAndCascadeResult> {
  // ── Tier 1: apply to param files + graph (no React dependency) ──────
  const edgesUpdated = await applyPatch(patch);

  if (edgesUpdated === 0) {
    return { edgesUpdated };
  }

  // ── Tier 2: cascade to GraphStore (only if mounted) ─────────────────
  const store = getGraphStore(graphId);
  if (!store) {
    // Graph not open in a tab — tier 1 is sufficient. Posteriors are in
    // IDB via fileRegistry. When the user opens the graph, GraphStore
    // mounts and reads from fileRegistry — posteriors are already there.
    sessionLogService.info('bayes', 'BAYES_CASCADE_DEFERRED',
      `Graph ${graphId} not open — tier 2 cascade deferred to graph open`);
    return { edgesUpdated };
  }

  // Sync FileRegistry → GraphStore BEFORE cascading.
  // applyPatch wrote _bayes, posteriors, and model_vars to FileRegistry
  // but not GraphStore. Without this sync the cascade starts from stale
  // GraphStore data and the final writeBack overwrites applyPatch's work.
  const freshGraph = fileRegistry.getFile(graphId)?.data;
  if (freshGraph) store.getState().setGraph(freshGraph as Graph);

  const { getParameterFromFile } = await import('./dataOperations/fileToGraphSync');
  const currentDSL = store.getState().currentDSL || '';
  const setGraph = (g: Graph | null) => { if (g) store.getState().setGraph(g); };
  const graph = store.getState().graph;

  let cascaded = 0;
  for (const edge of (graph?.edges || [])) {
    const paramId = (edge as any).p?.id;
    if (!paramId) continue;
    await getParameterFromFile({
      paramId,
      edgeId: (edge as any).uuid || edge.id,
      graph: store.getState().graph,
      setGraph,
      targetSlice: currentDSL,
    });
    cascaded++;
  }

  // Copy promoted latency outputs → input fields (onset, t95, path_t95)
  // so the next model run reads the latest output as its input.
  const { persistGraphMasteredLatencyToParameterFiles } = await import('./fetchDataService');
  const graphForPersist = store.getState().graph;
  if (graphForPersist) {
    await persistGraphMasteredLatencyToParameterFiles({
      graph: graphForPersist,
      setGraph,
      edgeIds: graphForPersist.edges?.map((e: any) => e.uuid || e.id).filter(Boolean) || [],
    });
  }

  // Sync the cascaded graph back to FileRegistry/IDB.
  const updatedGraph = store.getState().graph;
  if (updatedGraph) {
    await fileRegistry.updateFile(graphId, updatedGraph);
  }

  sessionLogService.success('bayes', 'BAYES_CASCADE_COMPLETE',
    `Cascaded ${cascaded} params from files to graph`);

  return { edgesUpdated };
}

// ── scanForPendingPatches (doc 28 §4.4) ──────────────────────────────────
//
// Scans fileRegistry for _bayes/patch-*.json files. Groups by graph_id,
// applies staleness-discard (newest-only per graph), and calls
// applyPatchAndCascade for each surviving patch.
//
// Not wired to any caller yet — Phase 3 hooks this into
// repositoryOperationsService.pullLatest and the scheduler reconcile path.

/** Module-level mutex — prevents concurrent scanner invocations (doc 28 §8.4). */
let _scannerPromise: Promise<ScanResult> | null = null;

/** Poisoned patches that failed to parse — skip on subsequent scans (doc 28 §8.9). */
const _poisonedPatches = new Set<string>();

export interface PatchScanEntry {
  patch: BayesPatchFile;
  fileId: string;
  graphId: string;
}

export interface ScanResult {
  applied: Array<{ graphId: string; fileId: string; edgesUpdated: number }>;
  skipped: Array<{ fileId: string; reason: string }>;
  errors: Array<{ fileId: string; error: string }>;
}

/**
 * Scan fileRegistry for pending Bayes patch files and apply them.
 *
 * Applies staleness-discard: only the newest patch per graph is applied.
 * Stale patches are returned in `skipped` for the caller to delete.
 *
 * The caller is responsible for:
 * - Showing countdown banners (§4.8)
 * - Deleting applied/skipped patches from git
 * - Committing dirty files after apply
 */
export function scanForPendingPatches(currentBranch: string): Promise<ScanResult> {
  if (_scannerPromise) return _scannerPromise;
  _scannerPromise = _scanForPendingPatchesInner(currentBranch).finally(() => {
    _scannerPromise = null;
  });
  return _scannerPromise;
}

async function _scanForPendingPatchesInner(currentBranch: string): Promise<ScanResult> {
  const result: ScanResult = { applied: [], skipped: [], errors: [] };

  // Find all patch files in fileRegistry
  const allFiles = fileRegistry.getAllFiles();
  const patchFiles = allFiles.filter((f: any) =>
    f.fileId.startsWith('_bayes/patch-') ||
    f.fileId.includes('-_bayes/patch-') || // workspace-prefixed variant
    f.fileId.match(/patch-.*\.json$/)
  ).filter((f: any) => {
    // Extract a canonical patch identifier for poisoned-patch check
    const match = f.fileId.match(/patch-([^.]+)\.json/);
    const jobId = match?.[1];
    if (jobId && _poisonedPatches.has(jobId)) {
      result.skipped.push({ fileId: f.fileId, reason: 'poisoned (previous parse failure)' });
      return false;
    }
    return true;
  });

  if (patchFiles.length === 0) return result;

  sessionLogService.info('bayes', 'BAYES_SCAN_START',
    `Found ${patchFiles.length} pending patch file(s)`);

  // Parse and group by graph_id
  const byGraph = new Map<string, PatchScanEntry[]>();

  for (const file of patchFiles) {
    try {
      const patch = file.data as BayesPatchFile;
      if (!patch?.job_id || !patch?.graph_id || !patch?.edges) {
        throw new Error('Missing required fields (job_id, graph_id, edges)');
      }

      // Branch check (doc 28 §8.10): skip if patch was created for a different branch
      // The patch file doesn't carry an explicit branch field, but we can infer from
      // the workspace prefix or check the graph_file_path. For now, we log a note
      // and proceed — the caller can refine this check with additional context.

      const entries = byGraph.get(patch.graph_id) ?? [];
      entries.push({ patch, fileId: file.fileId, graphId: patch.graph_id });
      byGraph.set(patch.graph_id, entries);
    } catch (err: any) {
      const match = file.fileId.match(/patch-([^.]+)\.json/);
      const jobId = match?.[1];
      if (jobId) _poisonedPatches.add(jobId);
      result.errors.push({ fileId: file.fileId, error: `Parse failed: ${err.message}` });
      sessionLogService.warning('bayes', 'BAYES_SCAN_PARSE_FAIL',
        `Failed to parse patch file ${file.fileId}: ${err.message}`);
    }
  }

  // Per-graph: staleness-discard, apply newest only
  for (const [graphId, entries] of byGraph) {
    // Read current graph's fitted_at for staleness comparison
    const graphFile = fileRegistry.getFile(graphId);
    const currentFittedAt: string | undefined = (graphFile?.data as any)?._bayes?.fitted_at;

    // Sort by fitted_at descending (ISO strings sort lexicographically)
    entries.sort((a, b) => (b.patch.fitted_at ?? '').localeCompare(a.patch.fitted_at ?? ''));

    const newest = entries[0];
    const stale = entries.slice(1);

    // Discard patches older than or equal to current graph state
    if (currentFittedAt && newest.patch.fitted_at <= currentFittedAt) {
      // All patches are stale — the graph already has newer posteriors
      for (const entry of entries) {
        result.skipped.push({ fileId: entry.fileId, reason: `superseded by current posteriors (graph fitted_at: ${currentFittedAt})` });
      }
      sessionLogService.info('bayes', 'BAYES_SCAN_ALL_STALE',
        `All ${entries.length} patch(es) for ${graphId} are stale (graph fitted_at: ${currentFittedAt})`);
      continue;
    }

    // Mark stale intermediate patches for deletion
    for (const entry of stale) {
      result.skipped.push({ fileId: entry.fileId, reason: `superseded by newer patch (${newest.patch.fitted_at})` });
    }

    // Apply the newest patch
    try {
      const { edgesUpdated } = await applyPatchAndCascade(newest.patch, graphId);
      result.applied.push({ graphId, fileId: newest.fileId, edgesUpdated });
    } catch (err: any) {
      result.errors.push({ fileId: newest.fileId, error: `Apply failed: ${err.message}` });
      sessionLogService.error('bayes', 'BAYES_SCAN_APPLY_FAIL',
        `Failed to apply patch for ${graphId}: ${err.message}`);
      // On apply failure, do NOT mark stale patches for deletion (doc 28 §8.16 point 4)
      // Remove them from skipped so the caller doesn't delete them
      result.skipped = result.skipped.filter(s =>
        !entries.some(e => e.fileId === s.fileId)
      );
    }
  }

  sessionLogService.info('bayes', 'BAYES_SCAN_COMPLETE',
    `Scan complete: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.errors.length} errors`);

  return result;
}

/** Clear the poisoned-patch skip-set (e.g. when user re-triggers a fit). */
export function clearPoisonedPatches(): void {
  _poisonedPatches.clear();
}
