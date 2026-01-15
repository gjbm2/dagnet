/**
 * Properties panel header badges service.
 *
 * Centralises the logic for:
 * - "overridden" badge (and which fields are overridden)
 * - "connected" badge (and which params have connections)
 *
 * UI should call this and just render the returned badges.
 */

import type { Graph, GraphEdge, GraphNode } from '../types';
import { listOverriddenFlagPaths } from '../utils/overrideFlags';

export interface HeaderBadgeInfo {
  visible: boolean;
  count?: number;
  tooltip?: string;
}

export interface PropertiesPanelHeaderBadges {
  overrides: HeaderBadgeInfo;
  connection: HeaderBadgeInfo;
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function compact(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

function findSelectedNode(graph: Graph | null, selectedNodeId: string | null): GraphNode | null {
  if (!graph || !selectedNodeId) return null;
  return (graph.nodes || []).find((n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId) ?? null;
}

function findSelectedEdge(graph: Graph | null, selectedEdgeId: string | null): GraphEdge | null {
  if (!graph || !selectedEdgeId) return null;
  return (graph.edges || []).find((e: any) =>
    e.uuid === selectedEdgeId || e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId
  ) ?? null;
}

function formatOverrideTooltip(paths: string[]): string {
  const readable = uniq(paths.map(p => p.replace(/_overridden$/, '')));
  return `Overrides: ${readable.join(', ')}`;
}

function formatConnectionTooltip(lines: string[]): string {
  return lines.join('\n');
}

function getEdgeConnectionLines(edge: GraphEdge): string[] {
  const lines: string[] = [];

  // Base probability param
  const pConn = compact(edge.p?.connection);
  const pSrc = compact(edge.p?.data_source?.type);
  if (pConn || pSrc) {
    lines.push(`p: ${[pConn ? `connection=${pConn}` : undefined, pSrc ? `source=${pSrc}` : undefined].filter(Boolean).join(', ')}`);
  }

  const costGbpConn = compact(edge.cost_gbp?.connection);
  const costGbpSrc = compact(edge.cost_gbp?.data_source?.type);
  if (costGbpConn || costGbpSrc) {
    lines.push(`cost_gbp: ${[costGbpConn ? `connection=${costGbpConn}` : undefined, costGbpSrc ? `source=${costGbpSrc}` : undefined].filter(Boolean).join(', ')}`);
  }

  const labourConn = compact(edge.labour_cost?.connection);
  const labourSrc = compact(edge.labour_cost?.data_source?.type);
  if (labourConn || labourSrc) {
    lines.push(`labour_cost: ${[labourConn ? `connection=${labourConn}` : undefined, labourSrc ? `source=${labourSrc}` : undefined].filter(Boolean).join(', ')}`);
  }

  if (Array.isArray(edge.conditional_p)) {
    for (const cp of edge.conditional_p) {
      const conn = compact(cp?.p?.connection);
      const src = compact(cp?.p?.data_source?.type);
      if (!conn && !src) continue;
      const label = compact(cp?.condition) ?? '(condition)';
      lines.push(`conditional_p (${label}): ${[conn ? `connection=${conn}` : undefined, src ? `source=${src}` : undefined].filter(Boolean).join(', ')}`);
    }
  }

  return lines;
}

function getNodeConnectionLines(node: GraphNode): string[] {
  const lines: string[] = [];
  const caseConn = compact(node.case?.connection);
  if (caseConn) lines.push(`case: connection=${caseConn}`);
  return lines;
}

export function getPropertiesPanelHeaderBadges(
  graph: Graph | null,
  selectedNodeId: string | null,
  selectedEdgeId: string | null
): PropertiesPanelHeaderBadges {
  const node = findSelectedNode(graph, selectedNodeId);
  const edge = findSelectedEdge(graph, selectedEdgeId);

  const overridePaths = node
    ? listOverriddenFlagPaths(node)
    : edge
      ? listOverriddenFlagPaths(edge)
      : [];

  const overrideCount = uniq(overridePaths).length;
  const overrides: HeaderBadgeInfo = overridePaths.length > 0
    ? { visible: true, count: overrideCount, tooltip: formatOverrideTooltip(overridePaths) }
    : { visible: false };

  const connectionLines = node
    ? getNodeConnectionLines(node)
    : edge
      ? getEdgeConnectionLines(edge)
      : [];

  const connection: HeaderBadgeInfo = connectionLines.length > 0
    ? { visible: true, tooltip: formatConnectionTooltip(connectionLines) }
    : { visible: false };

  return { overrides, connection };
}


