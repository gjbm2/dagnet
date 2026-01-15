/**
 * ShareLinkModal
 * 
 * Modal for creating share links with explicit tab selection.
 * Part of Phase 2: Share bundle modal and per-tab actions.
 * 
 * Features:
 * - Lists all open graph tabs with checkboxes
 * - Select all / clear all controls
 * - Dashboard mode toggle
 * - Include scenarios toggle
 * - Generates static share URL (live share deferred)
 */

import React, { useState, useMemo, useCallback } from 'react';
import { X, Copy, Check, Share2, LayoutDashboard, Layers, Zap } from 'lucide-react';
import { useTabContext, fileRegistry } from '../../contexts/TabContext';
import { shareLinkService, extractIdentityFromFileSource, resolveShareSecretForLinkGeneration } from '../../services/shareLinkService';
import { sessionLogService } from '../../services/sessionLogService';
import toast from 'react-hot-toast';
import './ShareLinkModal.css';

interface ShareLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShareableTab {
  id: string;
  fileId: string;
  title: string;
  type: 'graph' | 'chart' | 'other';
  isSelected: boolean;
}

export function ShareLinkModal({ isOpen, onClose }: ShareLinkModalProps) {
  const { tabs, activeTabId } = useTabContext();
  
  // Modal state
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [dashboardMode, setDashboardMode] = useState(true);
  // Live share is the default: it’s usually what users want (small links + always-fresh).
  const [liveMode, setLiveMode] = useState(true);
  const [includeScenarios, setIncludeScenarios] = useState(true);
  const [activeBundleTabId, setActiveBundleTabId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wasOpenRef = React.useRef(false);
  
  // Get shareable tabs (graphs and charts only for now)
  const shareableTabs = useMemo<ShareableTab[]>(() => {
    return tabs
      .filter(tab => tab.fileId.startsWith('graph-') || tab.fileId.startsWith('chart-'))
      .map(tab => ({
        id: tab.id,
        fileId: tab.fileId,
        title: tab.title,
        type: tab.fileId.startsWith('graph-') ? 'graph' as const : 
              tab.fileId.startsWith('chart-') ? 'chart' as const : 'other' as const,
        isSelected: selectedTabIds.has(tab.id),
      }));
  }, [tabs, selectedTabIds]);
  
  // Initialize selection with active tab when modal opens
  React.useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    // Only run initialisation on the open transition.
    if (!isOpen || wasOpen) return;

    if (!activeTabId) return;

    // IMPORTANT: Do NOT depend on shareableTabs here (it depends on selectedTabIds),
    // otherwise this effect can create an update loop when selection changes.
    const activeIsShareable = tabs.some(tab =>
      tab.id === activeTabId && (tab.fileId.startsWith('graph-') || tab.fileId.startsWith('chart-'))
    );
    if (!activeIsShareable) return;

    setSelectedTabIds(new Set([activeTabId]));
    setActiveBundleTabId(activeTabId);
  }, [isOpen, activeTabId, tabs]);

  // Keep bundle active tab consistent with selection
  React.useEffect(() => {
    if (!activeBundleTabId) {
      const first = Array.from(selectedTabIds)[0] || null;
      if (first) setActiveBundleTabId(first);
      return;
    }
    if (!selectedTabIds.has(activeBundleTabId)) {
      const first = Array.from(selectedTabIds)[0] || null;
      setActiveBundleTabId(first);
    }
  }, [selectedTabIds, activeBundleTabId]);
  
  // Toggle tab selection
  const toggleTab = useCallback((tabId: string) => {
    setSelectedTabIds(prev => {
      const next = new Set(prev);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return next;
    });
  }, []);
  
  // Select all / clear all
  const selectAll = useCallback(() => {
    setSelectedTabIds(new Set(shareableTabs.map(t => t.id)));
  }, [shareableTabs]);
  
  const clearAll = useCallback(() => {
    setSelectedTabIds(new Set());
  }, []);
  
  // Generate share URL
  const handleShare = useCallback(async () => {
    if (selectedTabIds.size === 0) {
      toast.error('Please select at least one tab to share');
      return;
    }
    
    const selectedTabs = shareableTabs.filter(t => selectedTabIds.has(t.id));
    if (selectedTabs.length === 0) return;
    
    try {
      if (selectedTabs.length === 1) {
        // Single tab share - use simple format
        const selectedTab = selectedTabs[0];
        const file = fileRegistry.getFile(selectedTab.fileId);
        if (!file?.data) {
          toast.error('No data available for selected tab');
          return;
        }
        
        const identity = extractIdentityFromFileSource(file.source);
        let url: string;

        if (liveMode) {
          const secret = resolveShareSecretForLinkGeneration();
          if (!secret) {
            toast.error('No share secret available (set SHARE_SECRET or open with ?secret=…)');
            return;
          }
          if (selectedTab.type === 'chart') {
            const res = await shareLinkService.buildLiveChartShareUrlFromChartFile({
              chartFileId: selectedTab.fileId,
              dashboardMode,
              secretOverride: secret,
            });
            if (!res.success || !res.url) {
              toast.error(res.error || 'Live chart share is not available for this chart');
              return;
            }
            url = res.url;
          } else {
            // For live graph shares, prefer a bundle payload so we can carry scenario DSLs + colours.
            const res = await shareLinkService.buildLiveBundleShareUrlFromTabs({
              tabIds: [selectedTab.id],
              dashboardMode,
              includeScenarios,
              activeTabId: selectedTab.id,
              secretOverride: secret,
            });
            if (!res.success || !res.url) {
              toast.error(res.error || 'Failed to create live graph share link');
              return;
            }
            url = res.url;
          }
        } else {
          if (selectedTab.type === 'chart') {
            const title = (file.data as any)?.title || selectedTab.title || 'Chart';
            url = shareLinkService.buildStaticSingleTabShareUrl({
              tabType: 'chart',
              title,
              data: file.data,
              identity,
              dashboardMode,
            });
          } else {
            url = shareLinkService.buildStaticShareUrl({
              graphData: file.data,
              identity,
              dashboardMode,
            });
          }
        }
        
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);

        const warning = shareLinkService.getShareUrlSoftWarning?.(url) ?? null;
        if (warning) {
          toast(warning);
          sessionLogService.warning('session', 'SHARE_URL_LONG_WARNING', warning, undefined, { urlLength: url.length });
        }
        
        sessionLogService.success(
          'session',
          liveMode ? 'SHARE_LIVE_LINK_COPIED' : 'SHARE_LINK_COPIED',
          `${liveMode ? 'Live' : 'Static'} share link copied for: ${selectedTab.title}`
        );
        
        toast.success(`${liveMode ? 'Live' : 'Static'} share link copied to clipboard!`);
      } else {
        // Multi-tab bundle share
        let url: string | null = null;

        if (liveMode) {
          const secret = resolveShareSecretForLinkGeneration();
          if (!secret) {
            toast.error('No share secret available (set SHARE_SECRET or open with ?secret=…)');
            return;
          }
          const res = await shareLinkService.buildLiveBundleShareUrlFromTabs({
            tabIds: selectedTabs.map(t => t.id),
            dashboardMode,
            includeScenarios,
            activeTabId: activeBundleTabId || activeTabId || undefined,
            secretOverride: secret,
          });
          if (!res.success || !res.url) {
            toast.error(res.error || 'Failed to create live bundle share link');
            return;
          }
          url = res.url;
        } else {
          const res = await shareLinkService.buildStaticBundleShareUrlFromTabs({
            tabIds: selectedTabs.map(t => t.id),
            dashboardMode,
            includeScenarios,
            activeTabId: activeBundleTabId || activeTabId || undefined,
          });
          if (!res.success || !res.url) {
            toast.error(res.error || 'Failed to create static bundle share link');
            return;
          }
          url = res.url;
        }

        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);

        const warning = shareLinkService.getShareUrlSoftWarning?.(url) ?? null;
        if (warning) {
          toast(warning);
          sessionLogService.warning('session', 'SHARE_URL_LONG_WARNING', warning, undefined, { urlLength: url.length });
        }
        
        sessionLogService.success('session', 'SHARE_BUNDLE_LINK_COPIED', 
          `Share link copied for ${selectedTabs.length} tabs`);
        
        toast.success(`Share link copied (${selectedTabs.length} tabs)!`);
      }
    } catch (error) {
      console.error('Failed to create share link:', error);
      toast.error('Failed to create share link');
    }
  }, [selectedTabIds, shareableTabs, dashboardMode, liveMode, includeScenarios, activeBundleTabId, activeTabId]);
  
  if (!isOpen) return null;
  
  return (
    <div className="share-link-modal-overlay" onClick={onClose}>
      <div className="share-link-modal" onClick={e => e.stopPropagation()}>
        <div className="share-link-modal__header">
          <div className="share-link-modal__title">
            <Share2 size={20} />
            <span>Share Link</span>
          </div>
          <button className="share-link-modal__close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        
        <div className="share-link-modal__content">
          {/* Tab selection */}
          <div className="share-link-modal__section">
            <div className="share-link-modal__section-header">
              <span className="share-link-modal__section-title">Select tabs to share</span>
              <div className="share-link-modal__section-actions">
                <button 
                  className="share-link-modal__text-button"
                  onClick={selectAll}
                >
                  Select all
                </button>
                <span className="share-link-modal__separator">|</span>
                <button 
                  className="share-link-modal__text-button"
                  onClick={clearAll}
                >
                  Clear
                </button>
              </div>
            </div>
            
            <div className="share-link-modal__tab-list">
              {shareableTabs.length === 0 ? (
                <div className="share-link-modal__empty">
                  No shareable tabs open. Open a graph to share.
                </div>
              ) : (
                shareableTabs.map(tab => (
                  <label 
                    key={tab.id}
                    className={`share-link-modal__tab-item ${tab.isSelected ? 'selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTabIds.has(tab.id)}
                      onChange={() => toggleTab(tab.id)}
                    />
                    {selectedTabIds.size > 1 && selectedTabIds.has(tab.id) ? (
                      <input
                        type="radio"
                        name="bundle-active-tab"
                        checked={(activeBundleTabId || activeTabId) === tab.id}
                        onChange={() => setActiveBundleTabId(tab.id)}
                        title="Initial active tab"
                        aria-label="Initial active tab"
                        style={{ marginLeft: 8 }}
                      />
                    ) : null}
                    <span className="share-link-modal__tab-icon">
                      {tab.type === 'graph' ? '📊' : tab.type === 'chart' ? '📈' : '📄'}
                    </span>
                    <span className="share-link-modal__tab-title">{tab.title}</span>
                  </label>
                ))
              )}
            </div>
          </div>
          
          {/* Options */}
          <div className="share-link-modal__section">
            <span className="share-link-modal__section-title">Options</span>
            
            <label className="share-link-modal__option">
              <input
                type="checkbox"
                checked={dashboardMode}
                onChange={e => setDashboardMode(e.target.checked)}
              />
              <LayoutDashboard size={16} />
              <span>Open in dashboard mode</span>
            </label>

            <label className="share-link-modal__option">
              <input
                type="checkbox"
                checked={liveMode}
                onChange={e => setLiveMode(e.target.checked)}
              />
              <Zap size={16} />
              <span>Live mode (fetch latest from GitHub)</span>
            </label>
            
            <label className="share-link-modal__option">
              <input
                type="checkbox"
                checked={includeScenarios}
                onChange={e => setIncludeScenarios(e.target.checked)}
              />
              <Layers size={16} />
              <span>Include scenarios</span>
            </label>
          </div>
          
          {/* Info note */}
          <div className="share-link-modal__note">
            <strong>Note:</strong>{' '}
            {liveMode
              ? 'This creates a live link. Recipients will fetch the latest from GitHub.'
              : 'This creates a static snapshot link. Recipients can view but not edit.'}
            {selectedTabIds.size > 1 && (
              <span className="share-link-modal__info">
                {' '}({selectedTabIds.size} tabs will be bundled)
              </span>
            )}
          </div>
        </div>
        
        <div className="share-link-modal__footer">
          <button 
            className="share-link-modal__button share-link-modal__button--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button 
            className="share-link-modal__button share-link-modal__button--primary"
            onClick={handleShare}
            disabled={selectedTabIds.size === 0}
          >
            {copied ? (
              <>
                <Check size={16} />
                Copied!
              </>
            ) : (
              <>
                <Copy size={16} />
                Copy Link
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
