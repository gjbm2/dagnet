import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useNavigatorContext } from '../../contexts/NavigatorContext';
import { useDialog } from '../../contexts/DialogContext';
import { sessionLogService } from '../../services/sessionLogService';
import {
  createEquivalenceLink,
  deactivateEquivalenceLink,
  listEquivalenceLinks,
  listSignatures,
  resolveEquivalentHashes,
  type SigEquivalenceLinkRow,
  type SigRegistryRow,
} from '../../services/signatureLinksApi';

type Facet = 'registry' | 'links';

function safeJsonStringify(value: any): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractGraphNameFromParamId(paramId: string): string | null {
  // param_id is workspace-prefixed; graph name may be present in inputs_json.provenance.
  // For UI dropdown, we instead let user pick repo/branch and free-text param filter.
  void paramId;
  return null;
}

export const SignatureLinksViewer: React.FC = () => {
  const { state: navState, items } = useNavigatorContext();
  const { showConfirm } = useDialog();

  const repo = navState.selectedRepo;
  const branch = navState.selectedBranch || 'main';

  const [facet, setFacet] = useState<Facet>('registry');
  const [paramFilter, setParamFilter] = useState<string>('');
  const [includeInputs, setIncludeInputs] = useState<boolean>(true);
  const [includeInactiveLinks, setIncludeInactiveLinks] = useState<boolean>(false);

  const [isLoading, setIsLoading] = useState(false);
  const [registryRows, setRegistryRows] = useState<SigRegistryRow[]>([]);
  const [linkRows, setLinkRows] = useState<SigEquivalenceLinkRow[]>([]);
  const [selectedCoreHash, setSelectedCoreHash] = useState<string | null>(null);
  const [selectedCanonicalSig, setSelectedCanonicalSig] = useState<string | null>(null);
  const [selectedInputsJson, setSelectedInputsJson] = useState<any>(null);
  const [resolvedClosure, setResolvedClosure] = useState<string[]>([]);

  const candidateParamIds = useMemo(() => {
    // Best-effort list of param ids in this workspace from Navigator items.
    // Users asked for graph>params: "just traverse graphs in indexeddb and get param_ids".
    // The navigator already has parameter items with ids; we can surface them quickly.
    const base = items.filter((i) => i.type === 'parameter').map((i) => i.id);
    base.sort((a, b) => a.localeCompare(b));
    return base;
  }, [items]);

  const dbParamCandidates = useMemo(() => {
    const q = paramFilter.trim().toLowerCase();
    const filtered = q
      ? candidateParamIds.filter((pid) => pid.toLowerCase().includes(q))
      : candidateParamIds;
    // Build workspace-prefixed param_id.
    const out = filtered.map((pid) => `${repo}-${branch}-${pid}`).filter((x) => x.split('-').length >= 3);
    return out.slice(0, 200);
  }, [candidateParamIds, paramFilter, repo, branch]);

  const [selectedDbParamId, setSelectedDbParamId] = useState<string | null>(null);

  useEffect(() => {
    // Keep selection consistent when repo/branch changes
    setSelectedDbParamId(null);
    setRegistryRows([]);
    setLinkRows([]);
    setSelectedCoreHash(null);
    setSelectedCanonicalSig(null);
    setSelectedInputsJson(null);
    setResolvedClosure([]);
  }, [repo, branch]);

  const refresh = useCallback(async () => {
    if (!selectedDbParamId) return;
    setIsLoading(true);
    const opId = sessionLogService.startOperation('info', 'session', 'SIGS_REFRESH', `Refreshing signatures for ${selectedDbParamId}`);
    try {
      const [reg, links] = await Promise.all([
        listSignatures({ param_id: selectedDbParamId, limit: 500, include_inputs: includeInputs }),
        listEquivalenceLinks({ param_id: selectedDbParamId, include_inactive: includeInactiveLinks, limit: 2000 }),
      ]);

      if (!reg.success) throw new Error(reg.error || 'listSignatures failed');
      if (!links.success) throw new Error(links.error || 'listEquivalenceLinks failed');

      setRegistryRows(reg.rows);
      setLinkRows(links.rows);
      sessionLogService.endOperation(opId, 'success', `Loaded ${reg.count} signatures + ${links.count} links`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[SignatureLinksViewer] refresh failed:', msg);
      toast.error(`Failed to load: ${msg}`);
      sessionLogService.endOperation(opId, 'error', `Failed to refresh: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }, [includeInactiveLinks, includeInputs, selectedDbParamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSelectRegistryRow = useCallback(async (row: SigRegistryRow) => {
    setSelectedCoreHash(row.core_hash);
    setSelectedCanonicalSig(row.canonical_signature);
    setSelectedInputsJson(row.inputs_json);
    setResolvedClosure([]);
    const res = await resolveEquivalentHashes({ param_id: row.param_id, core_hash: row.core_hash, include_equivalents: true });
    if (res.success) setResolvedClosure(res.core_hashes);
  }, []);

  const onCreateLink = useCallback(async () => {
    if (!selectedDbParamId || !selectedCoreHash) return;

    const other = prompt('Equivalent to (core_hash):');
    if (!other || !other.trim()) return;
    const reason = prompt('Reason:') || '';
    const createdBy = prompt('Created by:') || 'user';

    const confirmed = await showConfirm({
      title: 'Create equivalence link',
      message: `Link\n\n${selectedCoreHash}\n\n≡\n\n${other.trim()}\n\nfor:\n${selectedDbParamId}\n\nThis affects snapshot matching and inventory grouping.`,
      confirmLabel: 'Create link',
      cancelLabel: 'Cancel',
      confirmVariant: 'primary',
    });
    if (!confirmed) return;

    const opId = sessionLogService.startOperation('info', 'session', 'SIGS_LINK_CREATE', 'Creating equivalence link');
    const res = await createEquivalenceLink({
      param_id: selectedDbParamId,
      core_hash: selectedCoreHash,
      equivalent_to: other.trim(),
      created_by: createdBy,
      reason,
    });
    if (!res.success) {
      toast.error(`Create link failed: ${res.error || 'unknown error'}`);
      sessionLogService.endOperation(opId, 'error', `Create link failed: ${res.error || 'unknown error'}`);
      return;
    }
    toast.success('Link created');
    sessionLogService.endOperation(opId, 'success', 'Link created');
    await refresh();
  }, [refresh, selectedCoreHash, selectedDbParamId, showConfirm]);

  const onDeactivateLink = useCallback(
    async (link: SigEquivalenceLinkRow) => {
      const confirmed = await showConfirm({
        title: 'Deactivate link',
        message: `Deactivate link?\n\n${link.core_hash}\n≡\n${link.equivalent_to}\n\nfor:\n${link.param_id}`,
        confirmLabel: 'Deactivate',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger',
      });
      if (!confirmed) return;

      const reason = prompt('Reason:') || '';
      const createdBy = prompt('Created by:') || 'user';

      const opId = sessionLogService.startOperation('info', 'session', 'SIGS_LINK_DEACTIVATE', 'Deactivating equivalence link');
      const res = await deactivateEquivalenceLink({
        param_id: link.param_id,
        core_hash: link.core_hash,
        equivalent_to: link.equivalent_to,
        created_by: createdBy,
        reason,
      });
      if (!res.success) {
        toast.error(`Deactivate failed: ${res.error || 'unknown error'}`);
        sessionLogService.endOperation(opId, 'error', `Deactivate failed: ${res.error || 'unknown error'}`);
        return;
      }
      toast.success('Link deactivated');
      sessionLogService.endOperation(opId, 'success', 'Link deactivated');
      await refresh();
    },
    [refresh, showConfirm]
  );

  // Minimal inline UI (we can style later; focus on end-to-end completeness first)
  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700 }}>Signature Links</div>
        <div style={{ fontSize: 12, color: '#666' }}>{repo}/{branch}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => void refresh()} disabled={isLoading || !selectedDbParamId}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: '#444' }}>
          Param filter:
          <input
            value={paramFilter}
            onChange={(e) => setParamFilter(e.target.value)}
            style={{ marginLeft: 8, padding: '4px 8px', width: 240 }}
            placeholder="type to filter parameters..."
          />
        </label>

        <label style={{ fontSize: 12, color: '#444' }}>
          Param:
          <select
            value={selectedDbParamId || ''}
            onChange={(e) => setSelectedDbParamId(e.target.value || null)}
            style={{ marginLeft: 8, padding: '4px 8px', minWidth: 420 }}
          >
            <option value="">(select)</option>
            {dbParamCandidates.map((pid) => (
              <option key={pid} value={pid}>
                {pid}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: 12, color: '#444' }}>
          <input type="checkbox" checked={includeInputs} onChange={(e) => setIncludeInputs(e.target.checked)} />
          <span style={{ marginLeft: 6 }}>Include inputs_json</span>
        </label>

        <label style={{ fontSize: 12, color: '#444' }}>
          <input type="checkbox" checked={includeInactiveLinks} onChange={(e) => setIncludeInactiveLinks(e.target.checked)} />
          <span style={{ marginLeft: 6 }}>Include inactive links</span>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <button onClick={() => setFacet('registry')} disabled={facet === 'registry'}>Registry</button>
        <button onClick={() => setFacet('links')} disabled={facet === 'links'}>Links</button>
        <button onClick={() => void onCreateLink()} disabled={!selectedDbParamId || !selectedCoreHash}>Create link from selected</button>
      </div>

      {facet === 'registry' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: 10, background: '#f7f7f7', fontWeight: 600 }}>
              Signature registry ({registryRows.length})
            </div>
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: '#fff' }}>
                    <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>created_at</th>
                    <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>core_hash</th>
                  </tr>
                </thead>
                <tbody>
                  {registryRows.map((r) => (
                    <tr
                      key={`${r.param_id}:${r.core_hash}`}
                      onClick={() => void onSelectRegistryRow(r)}
                      style={{
                        cursor: 'pointer',
                        background: r.core_hash === selectedCoreHash ? '#EEF2FF' : 'transparent',
                      }}
                    >
                      <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }}>{r.created_at}</td>
                      <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace' }}>{r.core_hash}</td>
                    </tr>
                  ))}
                  {registryRows.length === 0 && (
                    <tr>
                      <td colSpan={2} style={{ padding: 12, color: '#666' }}>
                        No rows.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: 10, background: '#f7f7f7', fontWeight: 600 }}>
              Selected
            </div>
            <div style={{ padding: 12, display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 12, color: '#444' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>core_hash</div>
                <div style={{ fontFamily: 'monospace' }}>{selectedCoreHash || '(none)'}</div>
              </div>
              <div style={{ fontSize: 12, color: '#444' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>canonical_signature</div>
                <pre style={{ margin: 0, maxHeight: 120, overflow: 'auto', background: '#fafafa', padding: 8, borderRadius: 6 }}>
                  {selectedCanonicalSig || ''}
                </pre>
              </div>
              <div style={{ fontSize: 12, color: '#444' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>inputs_json</div>
                <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', background: '#fafafa', padding: 8, borderRadius: 6 }}>
                  {selectedInputsJson ? safeJsonStringify(selectedInputsJson) : ''}
                </pre>
              </div>
              <div style={{ fontSize: 12, color: '#444' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>equivalence closure</div>
                <div style={{ fontFamily: 'monospace' }}>
                  {resolvedClosure.length ? resolvedClosure.join(', ') : '(none)'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {facet === 'links' && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: 10, background: '#f7f7f7', fontWeight: 600 }}>
            Equivalence links ({linkRows.length})
          </div>
          <div style={{ maxHeight: 520, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: '#fff' }}>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>created_at</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>core_hash</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>equivalent_to</th>
                  <th style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>active</th>
                  <th style={{ padding: 8, borderBottom: '1px solid #eee' }} />
                </tr>
              </thead>
              <tbody>
                {linkRows.map((l) => (
                  <tr key={`${l.param_id}:${l.core_hash}:${l.equivalent_to}`} style={{ opacity: l.active ? 1 : 0.5 }}>
                    <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }}>{l.created_at}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace' }}>{l.core_hash}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0', fontFamily: 'monospace' }}>{l.equivalent_to}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }}>{String(l.active)}</td>
                    <td style={{ padding: 8, borderBottom: '1px solid #f0f0f0', textAlign: 'right' }}>
                      <button onClick={() => void onDeactivateLink(l)} disabled={!l.active}>
                        Deactivate
                      </button>
                    </td>
                  </tr>
                ))}
                {linkRows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 12, color: '#666' }}>
                      No links.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

