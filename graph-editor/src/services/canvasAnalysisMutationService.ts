import type { GraphData, CanvasAnalysis } from '../types';

export function mutateCanvasAnalysisGraph(
  graph: GraphData | null | undefined,
  analysisId: string,
  mutator: (analysis: CanvasAnalysis, nextGraph: GraphData) => void
): GraphData | null {
  if (!graph) return null;
  const nextGraph = structuredClone(graph) as GraphData;
  const analysis = nextGraph.canvasAnalyses?.find((a: any) => a.id === analysisId) as CanvasAnalysis | undefined;
  if (!analysis) return null;
  mutator(analysis, nextGraph);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
  return nextGraph;
}

export function deleteCanvasAnalysisFromGraph(
  graph: GraphData | null | undefined,
  analysisId: string
): GraphData | null {
  if (!graph) return null;
  const nextGraph = structuredClone(graph) as GraphData;
  if (!nextGraph.canvasAnalyses) return null;
  nextGraph.canvasAnalyses = nextGraph.canvasAnalyses.filter((a: any) => a.id !== analysisId);
  if (nextGraph.metadata) nextGraph.metadata.updated_at = new Date().toISOString();
  return nextGraph;
}
