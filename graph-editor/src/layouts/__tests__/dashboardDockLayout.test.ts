import { describe, it, expect } from 'vitest';
import { buildDashboardDockLayout } from '../dashboardDockLayout';

function collectTabIds(layout: any): string[] {
  const ids: string[] = [];
  const visit = (node: any) => {
    if (!node) return;
    if (Array.isArray(node.tabs)) {
      for (const t of node.tabs) if (t?.id) ids.push(t.id);
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(layout.dockbox);
  if (Array.isArray(layout.floatbox?.children)) layout.floatbox.children.forEach(visit);
  return ids;
}

describe('buildDashboardDockLayout', () => {
  it('should include each tab ID exactly once', () => {
    const tabIds = ['t1', 't2', 't3', 't4', 't5'];
    const layout = buildDashboardDockLayout(tabIds);
    const found = collectTabIds(layout);

    expect(found.sort()).toEqual(tabIds.slice().sort());
  });

  it('should set each panel activeId to its single tab id', () => {
    const tabIds = ['a', 'b', 'c'];
    const layout: any = buildDashboardDockLayout(tabIds);

    const panels: any[] = [];
    const visit = (node: any) => {
      if (!node) return;
      if (Array.isArray(node.tabs)) panels.push(node);
      if (Array.isArray(node.children)) node.children.forEach(visit);
    };
    visit(layout.dockbox);

    for (const p of panels) {
      expect(p.tabs).toHaveLength(1);
      expect(p.activeId).toBe(p.tabs[0].id);
    }
  });
});


