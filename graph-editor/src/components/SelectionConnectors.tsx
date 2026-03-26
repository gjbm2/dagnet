/**
 * SelectionConnectors — draws inflated shapes around analysis data subjects
 * and connecting lines from chart objects to their shapes.
 *
 * Shows for: the currently selected analysis AND any with persisted
 * `display.show_subject_overlay`.
 */

import React, { useMemo, useEffect, useRef, useState } from 'react';
import { useViewport, useNodes, useReactFlow } from 'reactflow';
import { parseDSL } from '../lib/queryDSL';
import { useDecorationVisibility } from './GraphCanvas';

const DEFAULT_COLOUR = '#9ca3af';
const MIN_RADIUS = 80;
const STAGGER_STEP = 12;

interface Point { x: number; y: number }

interface TubeSegment {
  x1: number; y1: number; x2: number; y2: number;
  width: number;
}

const TRANSIT_RADIUS = 10;

/**
 * Build a directed adjacency list from graph edges, resolving UUIDs → human IDs.
 */
function buildAdjacency(
  graphEdges: Array<{ from: string; to: string }>,
  nodeUuidToId: Map<string, string>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of graphEdges) {
    const src = nodeUuidToId.get(e.from) ?? e.from;
    const tgt = nodeUuidToId.get(e.to) ?? e.to;
    if (!adj.has(src)) adj.set(src, []);
    adj.get(src)!.push(tgt);
  }
  return adj;
}

/**
 * BFS shortest path from `fromId` to `toId` using human-readable node IDs.
 * `nodeUuidToId` maps graph edge UUIDs to human IDs.
 * Returns the full path as an array of human IDs, or null if no path exists.
 */
export function findPath(
  fromId: string, toId: string,
  graphEdges: Array<{ from: string; to: string }>,
  nodeUuidToId: Map<string, string>,
): string[] | null {
  const adj = buildAdjacency(graphEdges, nodeUuidToId);
  return bfsPath(fromId, toId, adj);
}

/** BFS on a pre-built adjacency list. */
function bfsPath(fromId: string, toId: string, adj: Map<string, string[]>): string[] | null {
  if (fromId === toId) return [fromId];
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue = [fromId];
  visited.add(fromId);
  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const next of adj.get(curr) || []) {
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, curr);
        if (next === toId) {
          const path: string[] = [];
          let node: string | undefined = toId;
          while (node !== undefined) { path.unshift(node); node = parent.get(node); }
          return path;
        }
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * Topologically sort a set of waypoints using the full graph's edge structure.
 * Uses Kahn's algorithm on the full graph, then filters to waypoints.
 * Waypoints unreachable in the graph are appended at the end.
 */
export function topoSortWaypoints(
  waypoints: string[],
  graphEdges: Array<{ from: string; to: string }>,
  nodeUuidToId: Map<string, string>,
): string[] {
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  const allNodes = new Set<string>();

  for (const e of graphEdges) {
    const src = nodeUuidToId.get(e.from) ?? e.from;
    const tgt = nodeUuidToId.get(e.to) ?? e.to;
    allNodes.add(src);
    allNodes.add(tgt);
    if (!adj.has(src)) adj.set(src, []);
    adj.get(src)!.push(tgt);
    inDegree.set(tgt, (inDegree.get(tgt) || 0) + 1);
    if (!inDegree.has(src)) inDegree.set(src, 0);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const n of allNodes) {
    if ((inDegree.get(n) || 0) === 0) queue.push(n);
  }

  const waypointSet = new Set(waypoints);
  const order: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (waypointSet.has(node)) order.push(node);
    for (const next of adj.get(node) || []) {
      const d = (inDegree.get(next) || 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // Append any waypoints not reached (not in graph, or in cycles)
  for (const w of waypoints) {
    if (!order.includes(w)) order.push(w);
  }

  return order;
}

/**
 * Chain waypoints into a single connected path by finding BFS sub-paths
 * between consecutive topo-sorted waypoints.  When a waypoint can't be
 * reached, it is marked unreachable and the chain continues from the
 * current tail of the path (skipping the gap).
 */
function chainWaypointPaths(
  sortedWaypoints: string[],
  adj: Map<string, string[]>,
): { path: string[]; unreachable: string[] } {
  if (sortedWaypoints.length === 0) return { path: [], unreachable: [] };
  if (sortedWaypoints.length === 1) return { path: [sortedWaypoints[0]], unreachable: [] };

  const path: string[] = [sortedWaypoints[0]];
  const onPath = new Set<string>([sortedWaypoints[0]]);
  const unreachable: string[] = [];

  for (let i = 1; i < sortedWaypoints.length; i++) {
    const target = sortedWaypoints[i];
    // Try to reach target from the current tail of the path
    const tail = path[path.length - 1];
    const subPath = bfsPath(tail, target, adj);
    if (subPath) {
      for (let j = 1; j < subPath.length; j++) {
        if (!onPath.has(subPath[j])) {
          path.push(subPath[j]);
          onPath.add(subPath[j]);
        }
      }
    } else {
      // Can't reach target — mark it unreachable, continue from current tail
      unreachable.push(target);
    }
  }

  return { path, unreachable };
}

export interface ResolvedShapeNodes {
  /** All node IDs on the BFS path (from→to), including transit nodes. */
  connectedIds: string[];
  /** Node IDs that couldn't be connected via a path (e.g. from-only, to-only, no path). */
  disconnectedIds: string[];
  /** Only the DSL-referenced node IDs (from, to, visited) — NOT transit nodes. */
  referencedOnPath: Set<string>;
}

/**
 * Resolve a DSL string into lists of connected/disconnected/referenced node IDs.
 * Pure function — no React or DOM dependencies.
 *
 * Uses topological ordering of waypoints (from, to, visited, visitedAny) to
 * build a connected path that traces the graph in a sensible order, chaining
 * BFS sub-paths between consecutive waypoints.
 */
export function resolveShapeNodes(
  dsl: string,
  graphEdges: Array<{ from: string; to: string }>,
  nodeUuidToId: Map<string, string>,
): ResolvedShapeNodes {
  const parsed = parseDSL(dsl);

  let connectedIds: string[] = [];
  let disconnectedIds: string[] = [];
  let referencedOnPath = new Set<string>();

  if (parsed.from && parsed.to) {
    // Collect all DSL-referenced waypoints
    const allWaypoints = new Set<string>([parsed.from, parsed.to]);
    for (const v of parsed.visited || []) allWaypoints.add(v);
    for (const group of parsed.visitedAny || []) {
      for (const nodeId of group) allWaypoints.add(nodeId);
    }

    // Topologically sort waypoints using the graph structure
    const sorted = topoSortWaypoints([...allWaypoints], graphEdges, nodeUuidToId);

    // Ensure `from` is first and `to` is last (topo sort should do this
    // naturally for a well-formed DAG, but enforce it for robustness)
    const fromIdx = sorted.indexOf(parsed.from);
    if (fromIdx > 0) { sorted.splice(fromIdx, 1); sorted.unshift(parsed.from); }
    const toIdx = sorted.indexOf(parsed.to);
    if (toIdx !== sorted.length - 1) { sorted.splice(toIdx, 1); sorted.push(parsed.to); }

    // Chain BFS sub-paths between consecutive topo-sorted waypoints
    const adj = buildAdjacency(graphEdges, nodeUuidToId);
    const { path, unreachable } = chainWaypointPaths(sorted, adj);

    if (path.length >= 2) {
      connectedIds = path;
      referencedOnPath = new Set<string>(allWaypoints);
      // Move unreachable waypoints to disconnected
      for (const id of unreachable) {
        if (!connectedIds.includes(id)) disconnectedIds.push(id);
        referencedOnPath.delete(id);
      }
    } else {
      // Couldn't build a connected path at all
      disconnectedIds = [...allWaypoints];
    }
  } else if (parsed.from) {
    disconnectedIds = [parsed.from];
    for (const v of parsed.visited || []) {
      if (!disconnectedIds.includes(v)) disconnectedIds.push(v);
    }
    for (const group of parsed.visitedAny || []) {
      for (const nodeId of group) {
        if (!disconnectedIds.includes(nodeId)) disconnectedIds.push(nodeId);
      }
    }
  } else if (parsed.to) {
    disconnectedIds = [parsed.to];
    for (const v of parsed.visited || []) {
      if (!disconnectedIds.includes(v)) disconnectedIds.push(v);
    }
    for (const group of parsed.visitedAny || []) {
      for (const nodeId of group) {
        if (!disconnectedIds.includes(nodeId)) disconnectedIds.push(nodeId);
      }
    }
  } else {
    // No from/to — just visited/visitedAny
    for (const v of parsed.visited || []) {
      if (!disconnectedIds.includes(v)) disconnectedIds.push(v);
    }
    for (const group of parsed.visitedAny || []) {
      for (const nodeId of group) {
        if (!disconnectedIds.includes(nodeId)) disconnectedIds.push(nodeId);
      }
    }
  }

  return { connectedIds, disconnectedIds, referencedOnPath };
}

// ---------------------------------------------------------------------------
// Visibility filter — the ONE place that decides which analyses to display.
// Every analysis that passes this filter gets identical treatment downstream:
// SVG shapes, connector lines, AND node halos. No branching.
// ---------------------------------------------------------------------------

export interface AnalysisVisibilityInput {
  id: string;
  content_items: Array<{ display?: { show_subject_overlay?: boolean; subject_overlay_colour?: string }; analytics_dsl?: string; chart_current_layer_dsl?: string }>;
}

/**
 * Determine which analyses should be displayed. ONE filter, used everywhere.
 * Four triggers, each identifying a SPECIFIC analysis:
 *   1. selectedAnalysisId — the analysis the user clicked/selected
 *   2. draggedAnalysisId — the analysis currently being dragged
 *   3. hoveredAnalysisId — the analysis the mouse is currently over
 *   4. persisted overlay — content_item.display.show_subject_overlay === true
 * Returns the IDs of analyses that should show shapes + connectors + halos.
 * All visible analyses go through ONE rendering codepath downstream.
 */
export function getVisibleAnalysisIds(
  analyses: AnalysisVisibilityInput[],
  selectedAnalysisId: string | null,
  draggedAnalysisId: string | null,
  hoveredAnalysisId?: string | null,
): Set<string> {
  const visible = new Set<string>();
  for (const a of analyses) {
    if (a.id === selectedAnalysisId) { visible.add(a.id); continue; }
    if (a.id === draggedAnalysisId) { visible.add(a.id); continue; }
    if (a.id === hoveredAnalysisId) { visible.add(a.id); continue; }
    // Per-tab overlay — if ANY content item has the flag, the analysis is visible
    if (a.content_items?.some(ci => (ci.display as any)?.show_subject_overlay === true)) { visible.add(a.id); continue; }
  }
  return visible;
}

/**
 * Compute halo node IDs from a set of shapes. No branching — every shape
 * in the input contributes its referencedCentres to halos.
 */
/**
 * Alpha-composite a source colour+opacity onto a running (r,g,b,a) accumulator.
 * Standard Porter-Duff "source over" in premultiplied form.
 */
function compositeOver(
  dstR: number, dstG: number, dstB: number, dstA: number,
  srcHex: string, srcAlpha: number,
): [number, number, number, number] {
  const h = srcHex.replace('#', '');
  const sR = parseInt(h.slice(0, 2), 16);
  const sG = parseInt(h.slice(2, 4), 16);
  const sB = parseInt(h.slice(4, 6), 16);
  const outA = srcAlpha + dstA * (1 - srcAlpha);
  if (outA < 0.0001) return [0, 0, 0, 0];
  const outR = (sR * srcAlpha + dstR * dstA * (1 - srcAlpha)) / outA;
  const outG = (sG * srcAlpha + dstG * dstA * (1 - srcAlpha)) / outA;
  const outB = (sB * srcAlpha + dstB * dstA * (1 - srcAlpha)) / outA;
  return [outR, outG, outB, outA];
}

/**
 * Compute halo node data from a set of shapes.
 * Alpha-composites each overlapping shape's (colour, fillOpacity) per node
 * so the halo colour matches the visual effect of the stacked SVG fills.
 */
export function computeHaloNodeIds(
  shapes: Array<{ referencedNodeIds: string[]; colour: string; fillOpacity: number }>,
): Map<string, { colour: string; opacity: number }> {
  // Collect layers per node: ordered list of (colour, opacity)
  const layers = new Map<string, Array<{ colour: string; opacity: number }>>();
  for (const shape of shapes) {
    for (const nodeId of shape.referencedNodeIds) {
      if (!layers.has(nodeId)) layers.set(nodeId, []);
      layers.get(nodeId)!.push({ colour: shape.colour, opacity: shape.fillOpacity });
    }
  }

  // Alpha-composite layers for each node
  const result = new Map<string, { colour: string; opacity: number }>();
  for (const [nodeId, nodeLayers] of layers) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const layer of nodeLayers) {
      [r, g, b, a] = compositeOver(r, g, b, a, layer.colour, layer.opacity);
    }
    if (a < 0.001) continue;
    const hex = `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
    result.set(nodeId, { colour: hex, opacity: a });
  }
  return result;
}

function closestPointOnRect(
  rx: number, ry: number, rw: number, rh: number, px: number, py: number,
): Point {
  const cx = rx + rw / 2, cy = ry + rh / 2;
  const dx = px - cx, dy = py - cy;
  if (dx === 0 && dy === 0) return { x: rx, y: cy };
  const scale = Math.max(Math.abs(dx) / (rw / 2), Math.abs(dy) / (rh / 2));
  return { x: cx + dx / scale, y: cy + dy / scale };
}

/**
 * Find the closest point on the shape surface to a target point.
 * The shape is a union of circles (per-node, varying radii) and a tube
 * (polyline stroke at minRadius). We check each circle and each segment.
 */
function closestPointOnShape(
  nodes: Array<{ centre: Point; radius: number }>,
  minRadius: number,
  px: number, py: number,
): Point {
  let best: Point = nodes[0]?.centre || { x: px, y: py };
  let bestDist = Infinity;

  // Check each node's circle
  for (const n of nodes) {
    const dist = Math.hypot(px - n.centre.x, py - n.centre.y);
    const surfaceDist = Math.abs(dist - n.radius);
    if (surfaceDist < bestDist) {
      bestDist = surfaceDist;
      const d = Math.max(dist, 0.001);
      best = {
        x: n.centre.x + ((px - n.centre.x) / d) * n.radius,
        y: n.centre.y + ((py - n.centre.y) / d) * n.radius,
      };
    }
  }

  // Check each tube segment (minRadius around the polyline)
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i].centre, b = nodes[i + 1].centre;
    const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx, cy = a.y + t * dy;
    const dist = Math.hypot(px - cx, py - cy);
    const surfaceDist = Math.abs(dist - minRadius);
    if (surfaceDist < bestDist) {
      bestDist = surfaceDist;
      const d = Math.max(dist, 0.001);
      best = { x: cx + ((px - cx) / d) * minRadius, y: cy + ((py - cy) / d) * minRadius };
    }
  }

  return best;
}

interface ShapeData {
  id: string;
  isSelected: boolean;
  /** True when visible only because of mouse hover (faint rendering). */
  isHovered: boolean;
  /** True when visible because the analysis is being dragged. */
  isDragged: boolean;
  tubeSegments: TubeSegment[];
  nodes: Array<{ centre: Point; radius: number }>;
  connectedNodes: Array<{ centre: Point; radius: number }>;
  disconnectedNodes: Array<{ centre: Point; radius: number }>;
  centres: Point[];
  /** Human IDs of DSL-referenced nodes — used for halo highlights. */
  referencedNodeIds: string[];
  /** Human IDs parallel to `nodes` array — used for stagger dedup. */
  nodeHumanIds: string[];
  cx: number;
  cy: number;
  minRadius: number;
  rfNode: any;
  colour: string;
  /** Fill opacity for this shape (varies by selection/hover state). */
  fillOpacity: number;
  /** True when the parent canvas analysis is minimised. */
  minimised?: boolean;
}

export function SelectionConnectors({ graph, controlledSetNodes }: { graph: any; controlledSetNodes?: (updater: (nodes: any[]) => any[]) => void }) {
  const viewport = useViewport();
  const rfNodes = useNodes();
  const { draggedAnalysisId } = useDecorationVisibility();

  const selectedAnalysisId = useMemo(() => {
    const selected = rfNodes.find(n => n.selected && n.id?.startsWith('analysis-'));
    return selected ? selected.id.replace('analysis-', '') : null;
  }, [rfNodes]);

  // Track hovered analysis via custom event (avoids context re-renders on all edges)
  const [hoveredAnalysisId, setHoveredAnalysisId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      setHoveredAnalysisId((e as CustomEvent).detail?.analysisId ?? null);
    };
    window.addEventListener('dagnet:analysisHover', handler);
    return () => window.removeEventListener('dagnet:analysisHover', handler);
  }, []);

  // Track active content tab per analysis (for per-tab DSL connector resolution)
  const [activeTabByAnalysis, setActiveTabByAnalysis] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const handler = (e: Event) => {
      const { analysisId, activeContentIndex } = (e as CustomEvent).detail || {};
      if (analysisId != null) {
        setActiveTabByAnalysis(m => {
          const next = new Map(m);
          next.set(analysisId, activeContentIndex ?? 0);
          return next;
        });
      }
    };
    window.addEventListener('dagnet:analysisActiveTabChanged', handler);
    return () => window.removeEventListener('dagnet:analysisActiveTabChanged', handler);
  }, []);

  // ONE visibility decision — four triggers, same rendering codepath.
  const visibleIds = useMemo(() => {
    if (!graph?.canvasAnalyses?.length) return new Set<string>();
    return getVisibleAnalysisIds(graph.canvasAnalyses, selectedAnalysisId, draggedAnalysisId, hoveredAnalysisId);
  }, [graph?.canvasAnalyses, selectedAnalysisId, draggedAnalysisId, hoveredAnalysisId]);

  const allShapes = useMemo((): ShapeData[] => {
    if (!graph || visibleIds.size === 0) return [];
    const nodeUuidToId = new Map<string, string>();
    for (const n of graph.nodes || []) { if (n.uuid && n.id) nodeUuidToId.set(n.uuid, n.id); }

    const resolveRfNode = (humanId: string) =>
      rfNodes.find(n => {
        if (n.id?.startsWith('postit-') || n.id?.startsWith('container-') || n.id?.startsWith('analysis-')) return false;
        return ((n.data as any)?.id || n.id) === humanId;
      });

    const getNodeInfo = (humanId: string): { centre: Point; radius: number } | null => {
      const node = resolveRfNode(humanId);
      if (!node) return null;
      const nw = (node as any).measured?.width ?? node.width ?? 200;
      const nh = (node as any).measured?.height ?? node.height ?? 60;
      return {
        centre: { x: (node.position?.x ?? 0) + nw / 2, y: (node.position?.y ?? 0) + nh / 2 },
        radius: Math.max(MIN_RADIUS, Math.max(nw, nh) / 2 + 30),
      };
    };

    // --- Pass 1: compute shapes with base radii ---
    // Each shape represents one visible tab within an analysis.
    // For selected/hovered/dragged analyses: the active tab gets a shape.
    // For persisted overlays: each tab with show_subject_overlay gets its own shape.
    type BaseShape = {
      id: string; isSelected: boolean; isHovered: boolean; isDragged: boolean; rfNode: any; colour: string;
      connectedNodes: Array<{ centre: Point; radius: number }>;
      disconnectedNodes: Array<{ centre: Point; radius: number }>;
      allNodes: Array<{ centre: Point; radius: number }>;
      nodeHumanIds: string[];
      connectedHumanIds: string[];
      referencedOnPath: Set<string>;
      referencedNodeIds: string[];
      minimised?: boolean;
    };

    const buildShape = (
      analysisId: string, dsl: string, colour: string, isSelected: boolean, isHovered: boolean, isDragged: boolean, rfNode: any,
    ): BaseShape | null => {
      const { connectedIds, disconnectedIds, referencedOnPath } = resolveShapeNodes(
        dsl, graph.edges || [], nodeUuidToId,
      );

      console.log('[SelectionConnectors] shape resolve', {
        analysisId,
        dsl,
        isSelected, isHovered, isDragged,
        connectedIds,
        disconnectedIds,
        referencedOnPath: [...referencedOnPath],
      });

      const connectedNodes: Array<{ centre: Point; radius: number }> = [];
      const connectedHumanIds: string[] = [];
      for (const id of connectedIds) {
        const info = getNodeInfo(id);
        if (info) {
          connectedNodes.push(referencedOnPath.has(id) ? info : { centre: info.centre, radius: TRANSIT_RADIUS });
          connectedHumanIds.push(id);
        }
      }
      const disconnectedNodes: Array<{ centre: Point; radius: number }> = [];
      const disconnectedHumanIds: string[] = [];
      for (const id of disconnectedIds) {
        const info = getNodeInfo(id);
        if (info) { disconnectedNodes.push(info); disconnectedHumanIds.push(id); }
      }
      const allNodes = [...connectedNodes, ...disconnectedNodes];
      const nodeHumanIds = [...connectedHumanIds, ...disconnectedHumanIds];
      if (allNodes.length === 0) return null;

      const referencedNodeIds: string[] = [];
      for (const id of connectedIds) {
        if (referencedOnPath.has(id)) referencedNodeIds.push(id);
      }
      for (const id of disconnectedIds) {
        referencedNodeIds.push(id);
      }

      return {
        id: analysisId, isSelected, isHovered, isDragged, rfNode, colour,
        connectedNodes, disconnectedNodes, allNodes, nodeHumanIds,
        connectedHumanIds, referencedOnPath, referencedNodeIds,
      } as BaseShape;
    };

    const baseShapes: BaseShape[] = [];
    for (const a of (graph.canvasAnalyses as any[]).filter((a: any) => visibleIds.has(a.id))) {
      const rfNode = rfNodes.find(n => n.id === `analysis-${a.id}`);
      const isSelected = a.id === selectedAnalysisId;
      const isDragged = !isSelected && a.id === draggedAnalysisId;
      const isHovered = !isSelected && !isDragged && a.id === hoveredAnalysisId;
      const activeIdx = activeTabByAnalysis.get(a.id) ?? 0;
      // Ensure content_items exists — legacy in-memory graphs may still have flat fields
      const contentItems: any[] = a.content_items?.length ? a.content_items : [{
        analytics_dsl: (a as any).recipe?.analysis?.analytics_dsl || (a as any).chart_current_layer_dsl,
        display: (a as any).display,
      }];

      // Collect tabs that need shapes:
      // - The active tab (for selected/hovered/dragged)
      // - Any tab with persisted show_subject_overlay
      const tabsToShow = new Set<number>();
      if (isSelected || a.id === draggedAnalysisId || a.id === hoveredAnalysisId) {
        tabsToShow.add(activeIdx);
      }
      for (let i = 0; i < contentItems.length; i++) {
        if ((contentItems[i].display as any)?.show_subject_overlay === true) tabsToShow.add(i);
      }

      // Deduplicate tabs with the same DSL (avoids overlapping identical shapes)
      const seenDsls = new Set<string>();
      for (const tabIdx of tabsToShow) {
        const ci = contentItems[tabIdx] || contentItems[0];
        const dsl = ci?.chart_current_layer_dsl || ci?.analytics_dsl
          // Fallback: any content item with a DSL (legacy graphs may not have DSL on every item)
          || contentItems.find((c: any) => c.analytics_dsl)?.analytics_dsl;
        if (!dsl) continue;
        if (seenDsls.has(dsl)) continue;
        seenDsls.add(dsl);
        const colour = (ci?.display as any)?.subject_overlay_colour || DEFAULT_COLOUR;
        const isPersisted = (ci?.display as any)?.show_subject_overlay === true;
        const tabIsHovered = isHovered;
        const shapeId = `${a.id}:${tabIdx}`;
        const shape = buildShape(shapeId, dsl, colour, isSelected, tabIsHovered, isDragged, rfNode);
        if (shape) {
          shape.minimised = !!a.minimised;
          baseShapes.push(shape);
        }
      }
    }

    // --- Pass 2: deterministic radius staggering for shared nodes ---
    // Build node → sorted shape IDs map
    const nodeToShapeIds = new Map<string, string[]>();
    for (const shape of baseShapes) {
      for (const humanId of shape.nodeHumanIds) {
        if (!nodeToShapeIds.has(humanId)) nodeToShapeIds.set(humanId, []);
        const list = nodeToShapeIds.get(humanId)!;
        if (!list.includes(shape.id)) list.push(shape.id);
      }
    }
    // Sort each node's shape list by analysis ID for determinism
    for (const list of nodeToShapeIds.values()) list.sort();

    return baseShapes.map(shape => {
      // Apply stagger offset to each node's radius
      const nodes = shape.allNodes.map((n, i) => {
        const humanId = shape.nodeHumanIds[i];
        const shapeList = nodeToShapeIds.get(humanId);
        const staggerIdx = shapeList ? shapeList.indexOf(shape.id) : 0;
        return staggerIdx > 0
          ? { centre: n.centre, radius: n.radius + staggerIdx * STAGGER_STEP }
          : n;
      });

      // Split back into connected/disconnected (same lengths as originals)
      const connLen = shape.connectedNodes.length;
      const connectedNodes = nodes.slice(0, connLen);
      const disconnectedNodes = nodes.slice(connLen);

      // Recompute tube segments with staggered radii
      const tubeSegments: TubeSegment[] = [];
      for (let i = 0; i < connectedNodes.length - 1; i++) {
        const a2 = connectedNodes[i], b = connectedNodes[i + 1];
        tubeSegments.push({
          x1: a2.centre.x, y1: a2.centre.y,
          x2: b.centre.x, y2: b.centre.y,
          width: Math.min(a2.radius, b.radius) * 2,
        });
      }

      const centres = nodes.map(n => n.centre);

      // Recompute minRadius from referenced nodes (with stagger applied)
      const refNodes = connectedNodes.filter((_, i) => shape.referencedOnPath.has(shape.connectedHumanIds[i]));
      const minR = refNodes.length > 0
        ? Math.min(...refNodes.map(n => n.radius))
        : (nodes.length > 0 ? Math.min(...nodes.map(n => n.radius)) : MIN_RADIUS);

      let cx = 0, cy = 0;
      for (const c of centres) { cx += c.x; cy += c.y; }

      return {
        id: shape.id, isSelected: shape.isSelected, isHovered: shape.isHovered, isDragged: shape.isDragged,
        tubeSegments, nodes, connectedNodes, disconnectedNodes, centres,
        referencedNodeIds: shape.referencedNodeIds,
        nodeHumanIds: shape.nodeHumanIds,
        cx: cx / centres.length, cy: cy / centres.length,
        minRadius: minR, rfNode: shape.rfNode, colour: shape.colour,
        fillOpacity: shape.isSelected ? 0.08 : shape.isHovered || shape.isDragged ? 0.04 : 0.03,
        minimised: shape.minimised,
      } as ShapeData;
    });
  }, [visibleIds, rfNodes, graph, selectedAnalysisId, hoveredAnalysisId, draggedAnalysisId, activeTabByAnalysis]);

  // Halo highlights — ONE codepath. Every shape contributes equally.
  const { setNodes } = useReactFlow();

  const haloMap = useMemo(() => {
    // computeHaloNodeIds: alpha-composites each shape's (colour, fillOpacity) per node
    const rawMap = computeHaloNodeIds(allShapes);

    // Resolve human IDs → RF node IDs
    const result = new Map<string, { colour: string; opacity: number }>();
    for (const [humanId, composited] of rawMap) {
      const rfNode = rfNodes.find(n => {
        if (n.id?.startsWith('postit-') || n.id?.startsWith('container-') || n.id?.startsWith('analysis-')) return false;
        return ((n.data as any)?.id || n.id) === humanId;
      });
      if (!rfNode) continue;
      result.set(rfNode.id, composited);
    }

    if (result.size > 0) {
      const haloEntries: Record<string, string> = {};
      for (const [id, { colour, opacity }] of result) haloEntries[id] = `${colour}@${opacity.toFixed(3)}`;
      console.log('[SelectionConnectors] halo highlights', {
        shapeCount: allShapes.length,
        haloNodeIds: Object.keys(haloEntries),
        haloEntries,
      });
    }
    return result;
  }, [allShapes, rfNodes]);

  // Serialise map for effect comparison
  const haloKey = useMemo(() => {
    const entries: string[] = [];
    for (const [id, { colour, opacity }] of haloMap) entries.push(`${id}:${colour}:${opacity.toFixed(4)}`);
    return entries.sort().join('|');
  }, [haloMap]);

  // Halo highlight effect — uses the CONTROLLED setNodes (from useNodesState)
  // rather than useReactFlow().setNodes() to avoid the 'reset' path which
  // overwrites controlled state (including style) with stale nodeInternals.
  // This was causing minimised analysis nodes to snap back to full size.
  const haloSetNodes = controlledSetNodes ?? setNodes;

  useEffect(() => {
    haloSetNodes(nodes => nodes.map(n => {
      const entry = haloMap.get(n.id);
      const had = (n.data as any)?.selectionHighlightColour;
      if (entry) {
        const val = `${entry.colour}:${entry.opacity.toFixed(4)}`;
        if (had !== val) {
          return { ...n, data: { ...n.data, selectionHighlightColour: entry.colour, selectionHighlightOpacity: entry.opacity } };
        }
      } else if (had) {
        const { selectionHighlightColour: _, selectionHighlightOpacity: _o, ...rest } = n.data as any;
        return { ...n, data: rest };
      }
      return n;
    }));

    return () => {
      haloSetNodes(nodes => nodes.map(n => {
        if ((n.data as any)?.selectionHighlightColour) {
          const { selectionHighlightColour: _, selectionHighlightOpacity: _o, ...rest } = n.data as any;
          return { ...n, data: rest };
        }
        return n;
      }));
    };
  }, [haloKey, haloSetNodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Briefly suppress connector lines during minimise/maximise to avoid jumps
  const [connectorsHidden, setConnectorsHidden] = useState(false);
  useEffect(() => {
    const handler = () => {
      setConnectorsHidden(true);
      setTimeout(() => setConnectorsHidden(false), 300);
    };
    window.addEventListener('dagnet:hideConnectors', handler);
    return () => window.removeEventListener('dagnet:hideConnectors', handler);
  }, []);

  if (allShapes.length === 0) return null;

  const lineSw = 1.5 / viewport.zoom;
  const dash = `${6 / viewport.zoom} ${4 / viewport.zoom}`;
  const dotR = 3 / viewport.zoom;

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0, left: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 1,
      }}
    >
      <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
        {allShapes.map(shape => {
          const c = shape.colour;
          const active = shape.isSelected || shape.isHovered || shape.isDragged;
          const persistedMin = !active && shape.minimised;
          //                       Selected   Hover/Drag                          Persisted (minimised)  Persisted
          const fillOpacity    = shape.isSelected ? 0.08 : shape.isHovered || shape.isDragged ? 0.04 : persistedMin ? 0.015 : 0.03;
          const outlineOpacity = shape.isSelected ? 0.20 : shape.isHovered || shape.isDragged ? 0.12 : persistedMin ? 0.05  : 0.10;
          const lineOpacity    = shape.isSelected ? 0.30 : shape.isHovered || shape.isDragged ? 0.20 : persistedMin ? 0.06  : 0.15;
          const dotOpacity     = shape.isSelected ? 0.50 : shape.isHovered || shape.isDragged ? 0.35 : persistedMin ? 0.10  : 0.25;
          if (shape.minimised) console.log('[SelectionConnectors] minimised shape render', { id: shape.id, isHovered: shape.isHovered, isDragged: shape.isDragged, active, persistedMin, fillOpacity });
          // Connector lines: always show for visible shapes (same codepath)
          const showConnector = !!shape.rfNode && !connectorsHidden;

          let connector: JSX.Element | null = null;
          if (showConnector) {
            const aX = shape.rfNode.position?.x ?? 0;
            const aY = shape.rfNode.position?.y ?? 0;
            // When minimised, use the fixed minimised dimensions — RF measured/width
            // may still reflect the old full size during the transition.
            const aW = shape.minimised ? 32 : ((shape.rfNode as any).measured?.width ?? shape.rfNode.width ?? 400);
            const aH = shape.minimised ? 32 : ((shape.rfNode as any).measured?.height ?? shape.rfNode.height ?? 300);
            const aCx = aX + aW / 2, aCy = aY + aH / 2;

            const lines: JSX.Element[] = [];

            if (shape.connectedNodes.length > 0) {
              const shapePt = closestPointOnShape(shape.connectedNodes, shape.minRadius, aCx, aCy);
              const chartPt = closestPointOnRect(aX, aY, aW, aH, shapePt.x, shapePt.y);
              lines.push(
                <React.Fragment key="conn">
                  <line x1={chartPt.x} y1={chartPt.y} x2={shapePt.x} y2={shapePt.y}
                    stroke={c} strokeWidth={lineSw} strokeOpacity={lineOpacity} strokeDasharray={dash} />
                  <circle cx={chartPt.x} cy={chartPt.y} r={dotR} fill={c} fillOpacity={dotOpacity} />
                  <circle cx={shapePt.x} cy={shapePt.y} r={dotR} fill={c} fillOpacity={dotOpacity} />
                </React.Fragment>
              );
            }

            for (let i = 0; i < shape.disconnectedNodes.length; i++) {
              const node = shape.disconnectedNodes[i];
              const dist = Math.hypot(aCx - node.centre.x, aCy - node.centre.y);
              const d = Math.max(dist, 0.001);
              const shapePt = {
                x: node.centre.x + ((aCx - node.centre.x) / d) * node.radius,
                y: node.centre.y + ((aCy - node.centre.y) / d) * node.radius,
              };
              const chartPt = closestPointOnRect(aX, aY, aW, aH, shapePt.x, shapePt.y);
              lines.push(
                <React.Fragment key={`disc-${i}`}>
                  <line x1={chartPt.x} y1={chartPt.y} x2={shapePt.x} y2={shapePt.y}
                    stroke={c} strokeWidth={lineSw} strokeOpacity={lineOpacity} strokeDasharray={dash} />
                  <circle cx={chartPt.x} cy={chartPt.y} r={dotR} fill={c} fillOpacity={dotOpacity} />
                  <circle cx={shapePt.x} cy={shapePt.y} r={dotR} fill={c} fillOpacity={dotOpacity} />
                </React.Fragment>
              );
            }

            if (lines.length > 0) connector = <>{lines}</>;
          }

          const maskId = `shape-mask-${shape.id}`;
          const bx = Math.min(...shape.nodes.map(n => n.centre.x - n.radius)) - 50;
          const by = Math.min(...shape.nodes.map(n => n.centre.y - n.radius)) - 50;
          const bx2 = Math.max(...shape.nodes.map(n => n.centre.x + n.radius)) + 50;
          const by2 = Math.max(...shape.nodes.map(n => n.centre.y + n.radius)) + 50;

          return (
            <g key={shape.id}>
              <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse"
                  x={bx} y={by} width={bx2 - bx} height={by2 - by}>
                  <rect x={bx} y={by} width={bx2 - bx} height={by2 - by} fill="white" />
                  {shape.nodes.map((n, i) => (
                    <circle key={`m-${i}`} cx={n.centre.x} cy={n.centre.y} r={n.radius} fill="black" />
                  ))}
                  {shape.tubeSegments.map((seg, i) => (
                    <line key={`mt-${i}`} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                      stroke="black" strokeWidth={seg.width} strokeLinecap="round" />
                  ))}
                </mask>
              </defs>

              {/* Circles for all nodes; tube segments taper at transit nodes */}
              <g opacity={fillOpacity}>
                {shape.nodes.map((n, i) => (
                  <circle key={`c-${i}`} cx={n.centre.x} cy={n.centre.y} r={n.radius} fill={c} />
                ))}
                {shape.tubeSegments.map((seg, i) => (
                  <line key={`t-${i}`} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                    stroke={c} strokeWidth={seg.width} strokeLinecap="round" />
                ))}
              </g>

              {/* Perimeter outline via inverted mask */}
              <g mask={`url(#${maskId})`} opacity={outlineOpacity}>
                {shape.nodes.map((n, i) => (
                  <circle key={`o-${i}`} cx={n.centre.x} cy={n.centre.y}
                    r={n.radius + lineSw * 1.5} fill={c} />
                ))}
                {shape.tubeSegments.map((seg, i) => (
                  <line key={`ot-${i}`} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                    stroke={c} strokeWidth={seg.width + lineSw * 3} strokeLinecap="round" />
                ))}
              </g>

              {connector}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
