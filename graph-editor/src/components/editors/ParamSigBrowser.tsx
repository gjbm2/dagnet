/**
 * ParamSigBrowser — renders a param-list + signature-cards panel.
 * Used as the primary view in the main grid, and also inside the
 * comparison pop-up for the secondary selection.
 */

import React, { useRef, useCallback, useEffect, useState } from 'react';
import type { SigParamSummary } from '../../services/signatureLinksApi';
import { detectQueryMode, type ParamSigBrowserState } from '../../hooks/useParamSigBrowser';

// ─── Display helpers (exported for use by the orchestrator) ──────────────────

export function truncateHash(hash: string, len = 10): string {
  return hash.length > len ? hash.slice(0, len) + '…' : hash;
}

export function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const day = d.getUTCDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[d.getUTCMonth()];
    const yr = String(d.getUTCFullYear()).slice(2);
    return `${day}-${mon}-${yr}`;
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const day = d.getUTCDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[d.getUTCMonth()];
    const yr = String(d.getUTCFullYear()).slice(2);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${day}-${mon}-${yr} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ─── Param list panel (extracted for reuse in same-param shared column) ──────

interface ParamListPanelProps {
  browser: ParamSigBrowserState;
  label: string;
  workspacePrefix: string;
  navigatorParams: Array<{ id: string; dbId: string }>;
  graphParamIds: Set<string> | null;
  dbParams: SigParamSummary[];
  /** Graph selector — rendered above the param filter when provided. */
  graphItems?: Array<{ id: string }>;
  selectedGraphName?: string | null;
  onGraphChange?: (name: string | null) => void;
}

export const ParamListPanel: React.FC<ParamListPanelProps> = ({
  browser: b, label, workspacePrefix, navigatorParams, graphParamIds, dbParams,
  graphItems, selectedGraphName, onGraphChange,
}) => {
  const noSigParams = navigatorParams
    .filter((np) => !dbParams.some((dp) => dp.param_id === np.dbId))
    .filter((np) => !graphParamIds || graphParamIds.has(np.dbId))
    .filter((np) => !b.paramFilter || np.id.toLowerCase().includes(b.paramFilter.toLowerCase()));

  return (
    <>
      <div className="sig-browse-params-header">
        <span className="sig-browse-label">{label}</span>
        {graphItems && onGraphChange && (
          <select
            className="sig-filter-select"
            value={selectedGraphName ?? ''}
            onChange={(e) => {
              const v = e.target.value || null;
              onGraphChange(v);
              b.setSelectedParamId(null);
            }}
            style={{ marginTop: 4, width: '100%', boxSizing: 'border-box' }}
          >
            <option value="">All graphs</option>
            {graphItems.map((g) => (
              <option key={g.id} value={g.id}>{g.id}</option>
            ))}
          </select>
        )}
        <input
          className="sig-links-search"
          placeholder="Filter params…"
          value={b.paramFilter}
          onChange={(e) => b.setParamFilter(e.target.value)}
          style={{ marginTop: 4 }}
        />
      </div>
      <div className="sig-links-param-list">
        {b.isLoading && !b.selectedParamId && (
          <div style={{ padding: '8px 12px', color: '#999', fontSize: '11px' }}>Loading…</div>
        )}
        {b.filteredParams.map((p) => {
          let displayName = p.param_id;
          if (displayName.startsWith(workspacePrefix)) displayName = displayName.slice(workspacePrefix.length);
          if (displayName.startsWith('parameter-')) displayName = displayName.slice('parameter-'.length);
          return (
            <div
              key={p.param_id}
              className={`sig-links-param-item${b.selectedParamId === p.param_id ? ' selected' : ''}`}
              onClick={() => b.setSelectedParamId(p.param_id)}
            >
              <div className="param-name" title={p.param_id}>{displayName}</div>
              <div className="param-badge">{p.signature_count}</div>
            </div>
          );
        })}
        {noSigParams.length > 0 && (
          <>
            <div className="sig-links-param-group">No signatures yet</div>
            {noSigParams.map((np) => (
              <div
                key={np.dbId}
                className={`sig-links-param-item${b.selectedParamId === np.dbId ? ' selected' : ''}`}
                onClick={() => b.setSelectedParamId(np.dbId)}
                style={{ opacity: 0.6 }}
              >
                <div className="param-name">{np.id}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
};

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  browser: ParamSigBrowserState;
  variant: 'primary' | 'secondary';
  workspacePrefix: string;
  navigatorParams: Array<{ id: string; dbId: string }>;
  graphParamIds: Set<string> | null;
  dbParams: SigParamSummary[];
  currentCoreHash?: string | null;
  /** When true, hide the param list (used in cross-param comparison pop-up). */
  hideParamList?: boolean;
  /** Hash highlighted as the compare target (amber styling). */
  compareHash?: string | null;
  /** Called when user clicks the "vs" compare button on a card. */
  onCompareClick?: (hash: string) => void;
  /** Optional floating action rendered at the bottom-centre of the sig cards column. */
  floatingAction?: React.ReactNode;
  /** Graph selector props — threaded to ParamListPanel. */
  graphItems?: Array<{ id: string }>;
  selectedGraphName?: string | null;
  onGraphChange?: (name: string | null) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const ParamSigBrowser: React.FC<Props> = ({
  browser: b,
  variant,
  workspacePrefix,
  navigatorParams,
  graphParamIds,
  dbParams,
  currentCoreHash,
  hideParamList,
  compareHash,
  onCompareClick,
  floatingAction,
  graphItems,
  selectedGraphName,
  onGraphChange,
}) => {
  const isPrimary = variant === 'primary';

  // ── Drag-to-resize param list ──
  const paramsRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      if (!paramsRef.current) return;
      const parentLeft = paramsRef.current.parentElement?.getBoundingClientRect().left ?? 0;
      const newWidth = Math.max(120, Math.min(400, e.clientX - parentLeft));
      paramsRef.current.style.width = `${newWidth}px`;
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  return (
    <div className={`sig-browse-half ${variant}`}>
      {/* ── Param list ── */}
      {!hideParamList && (
        <>
          <div className="sig-browse-params" ref={paramsRef}>
            <ParamListPanel
              browser={b}
              label={isPrimary ? 'Primary' : 'Compare'}
              workspacePrefix={workspacePrefix}
              navigatorParams={navigatorParams}
              graphParamIds={graphParamIds}
              dbParams={dbParams}
              graphItems={graphItems}
              selectedGraphName={selectedGraphName}
              onGraphChange={onGraphChange}
            />
          </div>
          <div
            className={`sig-resize-handle${dragging ? ' active' : ''}`}
            onMouseDown={onMouseDown}
          />
        </>
      )}

      {/* ── Sig cards ── */}
      <div className="sig-browse-sigs" style={{ position: 'relative' }}>
        <div className="sig-links-centre-header">
          <h3 style={{ fontSize: 12 }}>
            {b.selectedParamId
              ? (b.selectedParamId.startsWith(workspacePrefix) ? b.selectedParamId.slice(workspacePrefix.length) : b.selectedParamId)
              : 'Select a parameter'}
          </h3>
          {b.selectedParamId && (
            <button className="sig-refresh-btn" onClick={() => void b.loadSignatures()} disabled={b.isLoading}>
              Refresh
            </button>
          )}
        </div>

        {b.selectedParamId && b.registryRows.length > 0 && (
          <div className="sig-centre-controls">
            <select className="sig-filter-select" value={b.queryModeFilter} onChange={(e) => b.setQueryModeFilter(e.target.value as 'all' | 'cohort' | 'window')}>
              <option value="all">All</option>
              <option value="window">window()</option>
              <option value="cohort">cohort()</option>
            </select>
            <select className="sig-filter-select" value={b.sortOrder} onChange={(e) => b.setSortOrder(e.target.value as 'newest' | 'oldest' | 'most-data')}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="most-data">Most data</option>
            </select>
          </div>
        )}

        {/* Summary bar (primary only — secondary is just for comparison picking) */}
        {isPrimary && b.selectedParamId && !b.isLoading && b.registryRows.length > 0 && (
          <div className="sig-summary-bar">
            <span>{b.registryRows.length} sig{b.registryRows.length !== 1 ? 's' : ''}</span>
            <span className="sig-summary-sep">·</span>
            <span>{b.summary.totalSnapshots} snapshots</span>
            {currentCoreHash && b.summary.unlinkedCount > 0 && (
              <>
                <span className="sig-summary-sep">·</span>
                <span className="sig-summary-warn">{b.summary.unlinkedCount} unlinked</span>
              </>
            )}
          </div>
        )}

        <div className="sig-links-centre-body">
          {!b.selectedParamId && (
            <div className="sig-links-empty">
              <span style={{ fontSize: 11, color: '#999' }}>← Select a parameter to view its signatures</span>
            </div>
          )}
          {b.selectedParamId && b.isLoading && (
            <div className="sig-links-loading">Loading…</div>
          )}
          {b.selectedParamId && !b.isLoading && b.registryRows.length === 0 && (
            <div className="sig-links-empty">No signatures for this parameter</div>
          )}

          {b.displayRows.map((row) => {
            const isSelected = row.core_hash === b.selectedHash;
            const isCompare = compareHash ? row.core_hash === compareHash : false;
            const isCurrent = currentCoreHash ? row.core_hash === currentCoreHash : false;
            const isLinked = currentCoreHash ? b.linkedHashes.has(row.core_hash) : false;
            const isNewest = b.displayRows.length > 0 && row.core_hash === b.displayRows[0]?.core_hash && b.sortOrder === 'newest';
            const stats = b.sigStatsMap.get(row.core_hash);
            const queryMode = detectQueryMode(row);

            // Show the "vs" compare button when: a primary is selected, this card
            // isn't the primary, and onCompareClick is provided.
            const showVsBtn = onCompareClick && b.selectedHash && !isSelected;

            // Badge logic — skip "Compare" badge when the vs button handles it
            let badge: string | null = null;
            let badgeClass = '';
            if (isCompare && !showVsBtn) { badge = 'Compare'; badgeClass = 'compare'; }
            else if (isCurrent) { badge = 'Current'; badgeClass = 'current'; }
            else if (isLinked) { badge = 'Linked'; badgeClass = 'linked'; }
            else if (currentCoreHash && !isCompare) { badge = 'Unlinked'; badgeClass = 'unlinked'; }
            else if (isNewest && isPrimary) { badge = 'Latest'; badgeClass = 'current'; }

            return (
              <div
                key={row.core_hash}
                className={`sig-card${isSelected ? ' selected' : ''}${isCompare ? ' compare' : ''}${isCurrent ? ' current' : ''}`}
                tabIndex={0}
                role="button"
                onClick={() => b.setSelectedHash(row.core_hash)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.setSelectedHash(row.core_hash); } }}
              >
                <div className="sig-card-left">
                  <div className="sig-card-hash">{truncateHash(row.core_hash)}</div>
                  <div className="sig-card-mode">{queryMode === 'cohort' ? 'cohort' : queryMode === 'window' ? 'window' : ''}</div>
                </div>
                <div className="sig-card-info">
                  <div className="sig-card-date">Registered {formatDateTime(row.created_at)}</div>
                  {stats ? (
                    <div className="sig-card-stats">
                      <strong>{stats.snapshots}</strong> snap{stats.snapshots !== 1 ? 's' : ''}
                      {stats.earliest && stats.latest && (
                        <span className="sig-card-range"> ({formatDate(stats.earliest)} – {formatDate(stats.latest)})</span>
                      )}
                      {stats.slices > 1 && <span> · {stats.slices} slices</span>}
                    </div>
                  ) : (
                    <div className="sig-card-stats muted">no snapshot data</div>
                  )}
                </div>
                {showVsBtn && (
                  <button
                    className={`sig-card-vs-btn${isCompare ? ' active' : ''}`}
                    title={isCompare ? 'Remove compare' : 'Compare with selected'}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCompareClick(isCompare ? '' : row.core_hash);
                    }}
                  >
                    vs
                  </button>
                )}
                {badge && <div className={`sig-card-badge ${badgeClass}`}>{badge}</div>}
              </div>
            );
          })}
        </div>

        {/* Floating action (e.g. "Compare to another param") */}
        {floatingAction && (
          <div className="sig-floating-action">
            {floatingAction}
          </div>
        )}
      </div>
    </div>
  );
};
