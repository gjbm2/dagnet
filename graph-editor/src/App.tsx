import React, { useEffect, useMemo, useState } from 'react';
import GraphCanvas from './components/GraphCanvas';
import PropertiesPanel from './components/PropertiesPanel';
import { loadFromSheet, saveToSheet } from './lib/sheetsClient';
import { decodeStateFromUrl, encodeStateToUrl } from './lib/shareUrl';
import { useGraphStore } from './lib/useGraphStore';
import { getValidator } from './lib/schema';

export default function App() {
  const { graph, setGraph } = useGraphStore();
  const [ajvValidate, setAjvValidate] = useState<any>(null);
  const [errors, setErrors] = useState<string[]>([]);

  // Load schema validator once
  useEffect(() => {
    getValidator().then(setAjvValidate).catch(e => setErrors([String(e)]));
  }, []);

  // Initial load: from ?data or from Sheet
  useEffect(() => {
    const decoded = decodeStateFromUrl();
    if (decoded) { setGraph(decoded); return; }
    loadFromSheet().then(g => g && setGraph(g)).catch(e => setErrors([String(e)]));
  }, [setGraph]);

  const validateNow = useMemo(() => {
    return () => {
      if (!ajvValidate || !graph) return [];
      const ok = ajvValidate(graph);
      const errs = ok ? [] : (ajvValidate.errors || []).map((e: any) => `${e.instancePath} ${e.message}`);
      setErrors(errs);
      return errs;
    };
  }, [ajvValidate, graph]);

  const onSave = async () => {
    const errs = validateNow();
    if (errs.length) { alert('Fix schema errors before save.'); return; }
    await saveToSheet(graph);
    alert('Saved to Sheet.');
  };

  const onShare = () => {
    const url = encodeStateToUrl(graph);
    navigator.clipboard.writeText(url);
    alert('Shareable URL copied to clipboard.');
  };

  const onDownload = () => {
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (graph?.metadata?.version || 'graph') + '.json';
    a.click();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', height: '100%' }}>
      <GraphCanvas onValidate={validateNow} />
      <div style={{ borderLeft: '1px solid #eee', padding: 12, overflow: 'auto' }}>
        <h3>Graph Inspector</h3>
        <button onClick={onSave}>Save to Sheet</button>
        <button onClick={onDownload} style={{ marginLeft: 8 }}>Download JSON</button>
        <button onClick={onShare} style={{ marginLeft: 8 }}>Share URL</button>
        <h4 style={{ marginTop: 16 }}>Schema errors</h4>
        {errors.length ? (
          <ul>{errors.map((e, i) => <li key={i} style={{ color: 'crimson' }}>{e}</li>)}</ul>
        ) : <div>None</div>}
        <PropertiesPanel />
      </div>
    </div>
  );
}
