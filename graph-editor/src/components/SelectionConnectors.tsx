/**
 * SelectionConnectors — draws inflated shapes around analysis data subjects
 * and connecting lines from chart objects to their shapes.
 *
 * Shows for: the currently selected analysis AND any with persisted
 * `display.show_subject_overlay`.
 */

import React, { useMemo, useEffect, useRef } from 'react';
import { useViewport, useNodes, useReactFlow } from 'reactflow';
import { parseDSL } from '../lib/queryDSL';

const DEFAULT_COLOUR = '#9ca3af';
const MIN_RADIUS = 80;
const CIRCLE_PTS = 24;

interface Point { x: number; y: number }

/**
 * Compute a smooth outline path for the union of circles + tube.
 * Samples points on each circle boundary and along the tube edges,
 * takes the convex hull, then smooths with Catmull-Rom splines.
 */
function computeUnionOutline(
  nodes: Array<{ centre: Point; radius: number }>,
  minRadius: number,
): string {
  const pts: Point[] = [];

  // Sample each node's circle boundary
  for (const n of nodes) {
    for (let i = 0; i < CIRCLE_PTS; i++) {
      const a = (Math.PI * 2 * i) / CIRCLE_PTS;
      pts.push({ x: n.centre.x + n.radius * Math.cos(a), y: n.centre.y + n.radius * Math.sin(a) });
    }
  }

  // Sample along the tube edges (offset from polyline segments)
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i].centre, b = nodes[i + 1].centre;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const nx = (-dy / len) * minRadius, ny = (dx / len) * minRadius;
    const steps = Math.max(2, Math.ceil(len / 20));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mx = a.x + dx * t, my = a.y + dy * t;
      pts.push({ x: mx + nx, y: my + ny });
      pts.push({ x: mx - nx, y: my - ny });
    }
  }

  // Convex hull
  if (pts.length < 3) return '';
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return '';

  // Catmull-Rom smooth
  const n = hull.length;
  const tension = 0.25;
  let d = `M ${hull[0].x} ${hull[0].y}`;
  for (let i = 0; i < n; i++) {
    const p0 = hull[(i - 1 + n) % n];
    const p1 = hull[i];
    const p2 = hull[(i + 1) % n];
    const p3 = hull[(i + 2) % n];
    d += ` C ${p1.x + (p2.x - p0.x) * tension} ${p1.y + (p2.y - p0.y) * tension}, ${p2.x - (p3.x - p1.x) * tension} ${p2.y - (p3.y - p1.y) * tension}, ${p2.x} ${p2.y}`;
  }
  return d + ' Z';
}

function findPath(
  fromId: string, toId: string,
  graphEdges: Array<{ from: string; to: string }>,
  nodeUuidToId: Map<string, string>,
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of graphEdges) {
    const src = nodeUuidToId.get(e.from) ?? e.from;
    const tgt = nodeUuidToId.get(e.to) ?? e.to;
    if (!adj.has(src)) adj.set(src, []);
    adj.get(src)!.push(tgt);
  }
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue = [fromId];
  visited.add(fromId);
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === toId) {
      const path: string[] = [];
      let node: string | undefined = toId;
      while (node !== undefined) { path.unshift(node); node = parent.get(node); }
      return path;
    }
    for (const next of adj.get(curr) || []) {
      if (!visited.has(next)) { visited.add(next); parent.set(next, curr); queue.push(next); }
    }
  }
  return null;
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
  isPersisted: boolean;
    linePath: string;
    outlinePath: string;
    nodes: Array<{ centre: Point; radius: number }>;
  centres: Point[];
  cx: number;
  cy: number;
  minRadius: number;
  rfNode: any;
  colour: string;
}

export function SelectionConnectors({ graph }: { graph: any }) {
  const viewport = useViewport();
  const rfNodes = useNodes();

  const selectedAnalysisId = useMemo(() => {
    const selected = rfNodes.find(n => n.selected && n.id?.startsWith('analysis-'));
    return selected ? selected.id.replace('analysis-', '') : null;
  }, [rfNodes]);

  const visibleAnalyses = useMemo(() => {
    if (!graph?.canvasAnalyses?.length) return [];
    return (graph.canvasAnalyses as any[]).filter((a: any) => {
      if (a.id === selectedAnalysisId) return true;
      return a.display?.show_subject_overlay === true;
    }).map((a: any) => {
      const dsl = a.chart_current_layer_dsl || a.recipe?.analysis?.analytics_dsl;
      if (!dsl) return null;
      const rfNode = rfNodes.find(n => n.id === `analysis-${a.id}`);
      const colour = a.display?.subject_overlay_colour || DEFAULT_COLOUR;
      const isPersisted = a.display?.show_subject_overlay === true;
      return { id: a.id, dsl, rfNode, isSelected: a.id === selectedAnalysisId, isPersisted, colour };
    }).filter(Boolean) as Array<{ id: string; dsl: string; rfNode: any; isSelected: boolean; isPersisted: boolean; colour: string }>;
  }, [graph, rfNodes, selectedAnalysisId]);

  const allShapes = useMemo((): ShapeData[] => {
    if (!graph) return [];
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

    return visibleAnalyses.map(va => {
      const parsed = parseDSL(va.dsl);
      let pathIds: string[] = [];
      if (parsed.from && parsed.to) {
        pathIds = findPath(parsed.from, parsed.to, graph.edges || [], nodeUuidToId) || [parsed.from, parsed.to];
      } else if (parsed.from) {
        pathIds = [parsed.from];
      } else if (parsed.to) {
        pathIds = [parsed.to];
      }
      for (const v of parsed.visited || []) { if (!pathIds.includes(v)) pathIds.push(v); }
      for (const vAny of parsed.visitedAny || []) { if (typeof vAny === 'string' && !pathIds.includes(vAny)) pathIds.push(vAny); }

      const shapeNodes: Array<{ centre: Point; radius: number }> = [];
      for (const id of pathIds) { const info = getNodeInfo(id); if (info) shapeNodes.push(info); }
      if (shapeNodes.length === 0) return null;

      const centres = shapeNodes.map(n => n.centre);
      const minR = Math.min(...shapeNodes.map(n => n.radius));
      let linePath: string;
      if (centres.length === 1) {
        linePath = `M ${centres[0].x} ${centres[0].y} l 0.01 0`;
      } else {
        linePath = `M ${centres[0].x} ${centres[0].y}`;
        for (let i = 1; i < centres.length; i++) linePath += ` L ${centres[i].x} ${centres[i].y}`;
      }

      let cx = 0, cy = 0;
      for (const c of centres) { cx += c.x; cy += c.y; }

      const outlinePath = computeUnionOutline(shapeNodes, minR);

      return {
        id: va.id, isSelected: va.isSelected, isPersisted: va.isPersisted,
        linePath, outlinePath, nodes: shapeNodes, centres,
        cx: cx / centres.length, cy: cy / centres.length,
        minRadius: minR, rfNode: va.rfNode, colour: va.colour,
      };
    }).filter(Boolean) as ShapeData[];
  }, [visibleAnalyses, rfNodes, graph]);

  // Halo highlight: for each RF node, collect ALL overlapping shape colours and blend them
  const { setNodes } = useReactFlow();
  const prevHighlightRef = useRef<Map<string, string>>(new Map());

  const nodeColourMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const shape of allShapes) {
      for (const centre of shape.centres) {
        const node = rfNodes.find(n => {
          if (n.id?.startsWith('postit-') || n.id?.startsWith('container-') || n.id?.startsWith('analysis-')) return false;
          const nx = (n.position?.x ?? 0) + ((n as any).measured?.width ?? n.width ?? 200) / 2;
          const ny = (n.position?.y ?? 0) + ((n as any).measured?.height ?? n.height ?? 60) / 2;
          return Math.abs(nx - centre.x) < 1 && Math.abs(ny - centre.y) < 1;
        });
        if (node) {
          if (!map.has(node.id)) map.set(node.id, []);
          if (!map.get(node.id)!.includes(shape.colour)) map.get(node.id)!.push(shape.colour);
        }
      }
    }
    // For each node, blend all overlapping colours and track count
    const result = new Map<string, { colour: string; count: number }>();
    for (const [id, colours] of map) {
      let rT = 0, gT = 0, bT = 0;
      for (const hex of colours) {
        const h = hex.replace('#', '');
        rT += parseInt(h.slice(0, 2), 16);
        gT += parseInt(h.slice(2, 4), 16);
        bT += parseInt(h.slice(4, 6), 16);
      }
      const n = colours.length;
      const blended = `#${Math.round(rT / n).toString(16).padStart(2, '0')}${Math.round(gT / n).toString(16).padStart(2, '0')}${Math.round(bT / n).toString(16).padStart(2, '0')}`;
      result.set(id, { colour: blended, count: n });
    }
    return result;
  }, [allShapes, rfNodes]);

  // Serialise map for comparison
  const nodeColourKey = useMemo(() => {
    const entries: string[] = [];
    for (const [id, { colour, count }] of nodeColourMap) entries.push(`${id}:${colour}:${count}`);
    return entries.sort().join('|');
  }, [nodeColourMap]);

  useEffect(() => {
    setNodes(nodes => nodes.map(n => {
      const entry = nodeColourMap.get(n.id);
      const hadColour = (n.data as any)?.selectionHighlightColour;
      if (entry) {
        const val = `${entry.colour}:${entry.count}`;
        if (hadColour !== val) {
          return { ...n, data: { ...n.data, selectionHighlightColour: entry.colour, selectionHighlightCount: entry.count } };
        }
      } else if (hadColour) {
        const { selectionHighlightColour: _, selectionHighlightCount: _c, ...rest } = n.data as any;
        return { ...n, data: rest };
      }
      return n;
    }));

    return () => {
      setNodes(nodes => nodes.map(n => {
        if ((n.data as any)?.selectionHighlightColour) {
          const { selectionHighlightColour: _, selectionHighlightCount: _c, ...rest } = n.data as any;
          return { ...n, data: rest };
        }
        return n;
      }));
    };
  }, [nodeColourKey, setNodes]); // eslint-disable-line react-hooks/exhaustive-deps

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
          const fillOpacity = shape.isSelected ? 0.08 : 0.05;
          const showConnector = shape.rfNode && (shape.isSelected || shape.isPersisted);

          let connector: JSX.Element | null = null;
          if (showConnector) {
            const aX = shape.rfNode.position?.x ?? 0;
            const aY = shape.rfNode.position?.y ?? 0;
            const aW = (shape.rfNode as any).measured?.width ?? shape.rfNode.width ?? 400;
            const aH = (shape.rfNode as any).measured?.height ?? shape.rfNode.height ?? 300;
            const aCx = aX + aW / 2, aCy = aY + aH / 2;
            const shapePt = closestPointOnShape(shape.nodes, shape.minRadius, aCx, aCy);
            const chartPt = closestPointOnRect(aX, aY, aW, aH, shapePt.x, shapePt.y);
            connector = (
              <>
                <line x1={chartPt.x} y1={chartPt.y} x2={shapePt.x} y2={shapePt.y}
                  stroke={c} strokeWidth={lineSw} strokeOpacity={0.3} strokeDasharray={dash} />
                <circle cx={chartPt.x} cy={chartPt.y} r={dotR} fill={c} fillOpacity={0.5} />
                <circle cx={shapePt.x} cy={shapePt.y} r={dotR} fill={c} fillOpacity={0.5} />
              </>
            );
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
                  {shape.centres.length > 1 && (
                    <path d={shape.linePath} fill="none" stroke="black"
                      strokeWidth={shape.minRadius * 2} strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </mask>
              </defs>

              {/* Filled union shape (group opacity prevents double-counting) */}
              <g opacity={fillOpacity}>
                {shape.nodes.map((n, i) => (
                  <circle key={`c-${i}`} cx={n.centre.x} cy={n.centre.y} r={n.radius} fill={c} />
                ))}
                {shape.centres.length > 1 && (
                  <path d={shape.linePath} fill="none" stroke={c}
                    strokeWidth={shape.minRadius * 2} strokeLinecap="round" strokeLinejoin="round" />
                )}
              </g>

              {/* Perimeter outline via inverted mask */}
              <g mask={`url(#${maskId})`} opacity={0.2}>
                {shape.nodes.map((n, i) => (
                  <circle key={`o-${i}`} cx={n.centre.x} cy={n.centre.y}
                    r={n.radius + lineSw * 1.5} fill={c} />
                ))}
                {shape.centres.length > 1 && (
                  <path d={shape.linePath} fill="none" stroke={c}
                    strokeWidth={shape.minRadius * 2 + lineSw * 3}
                    strokeLinecap="round" strokeLinejoin="round" />
                )}
              </g>

              {connector}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
