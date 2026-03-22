type SnapshotChartSummary = {
  id: string;
  analysisType: string;
  chartKind?: string;
  mode?: string;
};

type SnapshotBootLedgerStage =
  | 'graph-discovered'
  | 'reactflow-node-present'
  | 'reactflow-node-materialised'
  | 'node-mounted'
  | 'node-unmounted'
  | 'hook-mounted'
  | 'hook-unmounted'
  | 'prepared-blocked'
  | 'prepared-ready'
  | 'compute-start'
  | 'compute-success'
  | 'compute-error';

type SnapshotBootLedgerEntry = {
  cycleId: string;
  analysisId: string;
  analysisType?: string;
  chartKind?: string;
  mode?: string;
  stages: Partial<Record<SnapshotBootLedgerStage, number>>;
  lastPayloadByStage: Partial<Record<SnapshotBootLedgerStage, Record<string, unknown>>>;
};

type SnapshotBootLedgerState = {
  entries: Map<string, SnapshotBootLedgerEntry>;
  watchdogs: Map<string, number>;
  activeCycleByAnalysisId: Map<string, string>;
};

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getBootLedgerState(): SnapshotBootLedgerState {
  const globalScope = globalThis as typeof globalThis & {
    __dagnetSnapshotBootLedger?: SnapshotBootLedgerState;
  };
  if (!globalScope.__dagnetSnapshotBootLedger) {
    globalScope.__dagnetSnapshotBootLedger = {
      entries: new Map<string, SnapshotBootLedgerEntry>(),
      watchdogs: new Map<string, number>(),
      activeCycleByAnalysisId: new Map<string, string>(),
    };
  }
  return globalScope.__dagnetSnapshotBootLedger;
}

function getEntryKey(cycleId: string, analysisId: string): string {
  return `${cycleId}:${analysisId}`;
}

function resolveCycleId(analysisId: string, payload: Record<string, unknown>): string {
  const explicitCycleId = safeString(payload.cycleId);
  if (explicitCycleId) return explicitCycleId;
  return getBootLedgerState().activeCycleByAnalysisId.get(analysisId) || 'unknown-cycle';
}

function upsertLedgerEntry(
  cycleId: string,
  analysisId: string,
  payload: Record<string, unknown>,
): SnapshotBootLedgerEntry {
  const state = getBootLedgerState();
  const entryKey = getEntryKey(cycleId, analysisId);
  const existing = state.entries.get(entryKey);
  const entry: SnapshotBootLedgerEntry = existing || {
    cycleId,
    analysisId,
    stages: {},
    lastPayloadByStage: {},
  };
  entry.analysisType = safeString(payload.analysisType) || entry.analysisType;
  entry.chartKind = safeString(payload.chartKind) || entry.chartKind;
  if (typeof payload.mode === 'string') entry.mode = payload.mode;
  state.entries.set(entryKey, entry);
  return entry;
}

function summariseLedgerEntry(entry: SnapshotBootLedgerEntry) {
  return {
    cycleId: entry.cycleId,
    analysisId: entry.analysisId,
    analysisType: entry.analysisType,
    chartKind: entry.chartKind,
    mode: entry.mode,
    seenStages: Object.keys(entry.stages),
    lastBlockedReason: entry.lastPayloadByStage['prepared-blocked']?.reason ?? null,
  };
}

export function isSnapshotBootChart(analysis: any): boolean {
  // Content-item authority: read from content_items[0], fall back to legacy flat fields
  const ci = analysis?.content_items?.[0];
  const analysisType = safeString(ci?.analysis_type || analysis?.recipe?.analysis?.analysis_type);
  const chartKind = safeString(ci?.kind || analysis?.chart_kind);
  if (analysisType === 'cohort_maturity' || analysisType === 'daily_conversions' || analysisType === 'lag_fit') {
    return true;
  }
  return analysisType === 'branch_comparison' && chartKind === 'time_series';
}

export function summariseSnapshotCharts(graph: any): SnapshotChartSummary[] {
  const analyses = Array.isArray(graph?.canvasAnalyses) ? graph.canvasAnalyses : [];
  return analyses
    .filter((analysis: any) => isSnapshotBootChart(analysis))
    .map((analysis: any) => {
      const ci = analysis?.content_items?.[0];
      return {
        id: safeString(analysis?.id),
        analysisType: safeString(ci?.analysis_type || analysis?.recipe?.analysis?.analysis_type),
        chartKind: safeString(ci?.kind || analysis?.chart_kind) || undefined,
        mode: ci?.mode || analysis?.mode,
      };
    });
}

export function logSnapshotBoot(stage: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.log(`[SnapshotBootTrace] ${stage}`, payload);
}

export function logChartReadinessTrace(stage: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.log(`[ChartReadinessTrace] ${stage}`, payload);
}

export function recordSnapshotBootLedgerStage(
  stage: SnapshotBootLedgerStage,
  payload: Record<string, unknown> & { analysisId: string },
): void {
  if (!import.meta.env.DEV) return;
  const cycleId = resolveCycleId(payload.analysisId, payload);
  const enrichedPayload = {
    ...payload,
    cycleId,
  };
  const entry = upsertLedgerEntry(cycleId, payload.analysisId, enrichedPayload);
  entry.stages[stage] = Date.now();
  entry.lastPayloadByStage[stage] = enrichedPayload;
  logSnapshotBoot(`Ledger:${stage}`, enrichedPayload);
}

export function registerSnapshotBootExpectations(
  charts: SnapshotChartSummary[],
  context: Record<string, unknown> = {},
  timeoutMs = 4000,
): void {
  if (!import.meta.env.DEV || charts.length === 0) return;
  const state = getBootLedgerState();
  charts.forEach((chart) => {
    const cycleId = safeString(context.cycleId) || `cycle-${Date.now()}`;
    const previousCycleId = state.activeCycleByAnalysisId.get(chart.id);
    if (previousCycleId && previousCycleId !== cycleId) {
      const previousWatchdog = state.watchdogs.get(getEntryKey(previousCycleId, chart.id));
      if (previousWatchdog) clearTimeout(previousWatchdog);
    }
    state.activeCycleByAnalysisId.set(chart.id, cycleId);
    const payload = {
      cycleId,
      analysisId: chart.id,
      analysisType: chart.analysisType,
      chartKind: chart.chartKind,
      mode: chart.mode,
      ...context,
    };
    recordSnapshotBootLedgerStage('graph-discovered', payload);
    const watchdogKey = getEntryKey(cycleId, chart.id);
    const existingTimer = state.watchdogs.get(watchdogKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = window.setTimeout(() => {
      const current = getBootLedgerState().entries.get(watchdogKey);
      if (!current) return;
      const hasMounted = Boolean(current.stages['node-mounted'] || current.stages['hook-mounted']);
      const hasPrepared = Boolean(current.stages['prepared-blocked'] || current.stages['prepared-ready']);
      const hasComputeTerminal = Boolean(current.stages['compute-success'] || current.stages['compute-error']);
      const hasComputeStarted = Boolean(current.stages['compute-start']);
      const missingStages: string[] = [];
      if (!hasMounted) missingStages.push('node-mounted');
      if (!hasPrepared) missingStages.push('prepared-state');
      if (current.stages['prepared-ready'] && !hasComputeStarted) missingStages.push('compute-start');
      if (hasComputeStarted && !hasComputeTerminal) missingStages.push('compute-terminal');
      if (missingStages.length === 0) return;
      logSnapshotBoot('Ledger:watchdog-missing-stage', {
        ...summariseLedgerEntry(current),
        missingStages,
        timeoutMs,
      });
    }, timeoutMs);
    state.watchdogs.set(watchdogKey, timer);
  });
}
