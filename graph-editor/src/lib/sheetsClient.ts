const APPS_SCRIPT = import.meta.env.VITE_APPS_SCRIPT_URL as string | undefined;

export async function loadFromSheet(): Promise<any | null> {
  const p = new URLSearchParams(window.location.search);
  const sheet = p.get('sheet');
  const tab = p.get('tab') || 'Graphs';
  const row = p.get('row');
  if (!APPS_SCRIPT || !sheet || !row) return null; // allow local editing via ?data= or paste
  const url = `${APPS_SCRIPT}?sheet=${encodeURIComponent(sheet)}&tab=${encodeURIComponent(tab)}&row=${encodeURIComponent(row)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('Sheet load failed');
  return res.json();
}

export async function saveToSheet(graph: any): Promise<void> {
  const p = new URLSearchParams(window.location.search);
  const sheet = p.get('sheet');
  const tab = p.get('tab') || 'Graphs';
  const row = p.get('row');
  if (!APPS_SCRIPT || !sheet || !row) throw new Error('Missing sheet/tab/row or APPS_SCRIPT url');
  const res = await fetch(APPS_SCRIPT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheet, tab, row, json: JSON.stringify(graph) }),
    credentials: 'include'
  });
  if (!res.ok) throw new Error('Sheet save failed');
}
