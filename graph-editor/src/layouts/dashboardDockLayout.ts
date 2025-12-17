import type { LayoutData } from 'rc-dock';

function chunk<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, i + chunkSize));
  return out;
}

/**
 * Build a nested rc-dock layout that tiles tabs in a roughly square grid.
 *
 * rc-dock only supports split panes (horizontal/vertical), so we approximate a grid by:
 * - choosing columns = ceil(sqrt(n))
 * - creating rows (vertical split) each containing up to `columns` panels (horizontal split)
 */
export function buildDashboardDockLayout(tabIds: string[]): LayoutData {
  const ids = tabIds.filter(Boolean);
  const n = ids.length;

  const columns = Math.max(1, Math.ceil(Math.sqrt(n || 1)));
  const rows = chunk(ids, columns);

  return {
    dockbox: {
      mode: 'vertical',
      children: rows.map((rowIds, rowIdx) => ({
        id: `dashboard-row-${rowIdx}`,
        mode: 'horizontal',
        children: rowIds.map((tabId) => ({
          id: `dashboard-panel-${tabId}`,
          // One-tab panels: active tab is the only tab, so VisibleTabsContext will mark all as visible.
          activeId: tabId,
          tabs: [
            {
              id: tabId,
              title: '', // hidden via CSS in dashboard mode
              // IMPORTANT: do NOT set `content: null` here.
              // rc-dock will skip `loadTab` if content is present (even null), which would render blank.
              cached: true,
              closable: false,
            },
          ],
          panelLock: {
            panelStyle: 'dashboard',
          },
        })),
      })),
    },
    floatbox: {
      mode: 'float',
      children: [],
    },
  };
}


