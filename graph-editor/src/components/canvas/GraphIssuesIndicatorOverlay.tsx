import React, { useEffect, useMemo, useState } from 'react';
import { Panel } from 'reactflow';
import { useTheme } from '../../contexts/ThemeContext';
import { useTabContext } from '../../contexts/TabContext';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import { graphIssuesService } from '../../services/graphIssuesService';
import { getSeverityIcon } from '../issues/issueIcons';

export function GraphIssuesIndicatorOverlay({ tabId }: { tabId?: string }) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const { tabs } = useTabContext();
  const { graph } = useGraphStore();

  const debuggingEnabled = !!(graph as any)?.debugging;

  const graphFileId = useMemo(() => {
    if (!tabId) return null;
    return tabs.find(t => t.id === tabId)?.fileId ?? null;
  }, [tabId, tabs]);

  const graphName = useMemo(() => {
    if (!graphFileId) return null;
    return graphIssuesService.getGraphNameFromFileId(graphFileId);
  }, [graphFileId]);

  const [counts, setCounts] = useState(() => {
    if (!graphName) return { errors: 0, warnings: 0, info: 0, total: 0 };
    return graphIssuesService.getSeverityCountsForGraph({ graphName, includeReferencedFiles: true });
  });

  useEffect(() => {
    if (!debuggingEnabled || !graphName) return;

    const updateCounts = () => {
      setCounts(graphIssuesService.getSeverityCountsForGraph({ graphName, includeReferencedFiles: true }));
    };

    const unsubscribe = graphIssuesService.subscribe(() => {
      updateCounts();
    });

    // Kick off a check promptly when a debugging graph is opened.
    graphIssuesService.scheduleCheck();
    updateCounts();

    return unsubscribe;
  }, [debuggingEnabled, graphName]);

  if (!debuggingEnabled || !graphName) return null;

  const openIssues = () => {
    void graphIssuesService.openIssuesTabForGraph(graphName);
  };

  // Suppress individual severities with zero count, and suppress the whole indicator when empty.
  if (counts.total === 0) return null;

  return (
    <Panel position="top-right" style={{ margin: '10px' }}>
      <div
        style={{
          display: 'flex',
          gap: '6px',
          alignItems: 'center',
          background: dark ? 'rgba(45,45,45,0.95)' : 'rgba(255,255,255,0.92)',
          border: `1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
          borderRadius: '10px',
          padding: '6px 8px',
          boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.3)' : '0 2px 10px rgba(0,0,0,0.06)',
          color: dark ? '#e0e0e0' : 'inherit',
          userSelect: 'none',
        }}
        aria-label={`Graph issues for ${graphName}: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.info} info`}
      >
        {counts.errors > 0 && (
          <button
            type="button"
            onClick={openIssues}
            title={graphIssuesService.getSeverityTooltipText({ graphName, severity: 'error', includeReferencedFiles: true })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '6px',
              color: '#b91c1c',
              fontSize: '12px',
              fontWeight: 600,
            }}
            aria-label={`Open Graph Issues (${counts.errors} errors)`}
          >
            {getSeverityIcon('error')} {counts.errors}
          </button>
        )}
        {counts.warnings > 0 && (
          <button
            type="button"
            onClick={openIssues}
            title={graphIssuesService.getSeverityTooltipText({ graphName, severity: 'warning', includeReferencedFiles: true })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '6px',
              color: '#b45309',
              fontSize: '12px',
              fontWeight: 600,
            }}
            aria-label={`Open Graph Issues (${counts.warnings} warnings)`}
          >
            {getSeverityIcon('warning')} {counts.warnings}
          </button>
        )}
        {counts.info > 0 && (
          <button
            type="button"
            onClick={openIssues}
            title={graphIssuesService.getSeverityTooltipText({ graphName, severity: 'info', includeReferencedFiles: true })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: '6px',
              color: '#1d4ed8',
              fontSize: '12px',
              fontWeight: 600,
            }}
            aria-label={`Open Graph Issues (${counts.info} info)`}
          >
            {getSeverityIcon('info')} {counts.info}
          </button>
        )}
      </div>
    </Panel>
  );
}
