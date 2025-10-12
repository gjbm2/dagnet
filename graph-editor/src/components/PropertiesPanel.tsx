import React from 'react';
import { useGraphStore } from '@/lib/useGraphStore';

export default function PropertiesPanel() {
  const { graph, setGraph } = useGraphStore();
  if (!graph) return null;

  const update = (path: string[], value: any) => {
    const next = structuredClone(graph);
    let cur: any = next; for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
    cur[path[path.length - 1]] = value;
    setGraph(next);
  };

  return (
    <div>
      <h4>Policies</h4>
      <label>default_outcome <input value={graph.policies?.default_outcome || ''} onChange={e => update(['policies','default_outcome'], e.target.value)} /></label>
      <div style={{ height: 12 }} />
      <h4>Metadata</h4>
      <label>version <input value={graph.metadata?.version || ''} onChange={e => update(['metadata','version'], e.target.value)} /></label>
    </div>
  );
}
