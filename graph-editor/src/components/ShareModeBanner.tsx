/**
 * ShareModeBanner
 * 
 * Displays a banner at the top of the app when in share mode.
 * - Static mode: Shows "Viewing snapshot" with option to enter live mode
 * - Live mode: Shows "Live view" indicator
 */

import React from 'react';
import { useShareMode } from '../contexts/ShareModeContext';
import { useEnterLiveMode } from '../hooks/useEnterLiveMode';
import { Eye, Zap, AlertCircle, X } from 'lucide-react';
import './ShareModeBanner.css';

export function ShareModeBanner() {
  const shareMode = useShareMode();
  const { canEnterLiveMode, enterLiveMode, reason } = useEnterLiveMode();
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem('dagnet_share_banner_dismissed') === '1');
    } catch {
      // Ignore: best-effort only.
    }
  }, []);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem('dagnet_share_banner_dismissed', '1');
    } catch {
      // Ignore: best-effort only.
    }
  };
  
  // Don't show banner in normal workspace mode
  if (!shareMode.isShareMode || dismissed) {
    return null;
  }
  
  if (shareMode.isStaticMode) {
    return (
      <div className="share-mode-banner share-mode-banner--static">
        <div className="share-mode-banner__content">
          <Eye size={16} className="share-mode-banner__icon" />
          <span className="share-mode-banner__text">
            <strong>Static snapshot</strong> @ point-in-time
          </span>
        </div>
        <div className="share-mode-banner__actions">
          {canEnterLiveMode ? (
            <button 
              className="share-mode-banner__button share-mode-banner__button--primary"
              onClick={enterLiveMode}
              title="Fetch the latest graph from GitHub"
            >
              <Zap size={14} />
              Enter live mode
            </button>
          ) : (
            <span 
              className="share-mode-banner__disabled-hint"
              title={reason}
            >
              <AlertCircle size={14} />
              No live mode
            </span>
          )}
          <button
            type="button"
            className="share-mode-banner__dismiss"
            onClick={dismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }
  
  if (shareMode.isLiveMode) {
    return (
      <div className="share-mode-banner share-mode-banner--live">
        <div className="share-mode-banner__content">
          <Zap size={16} className="share-mode-banner__icon" />
          <span className="share-mode-banner__text">
            <strong>Live view</strong> — Connected to {shareMode.identity.repo}/{shareMode.identity.branch}
          </span>
        </div>
        <div className="share-mode-banner__actions">
          <button
            type="button"
            className="share-mode-banner__dismiss"
            onClick={dismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }
  
  return null;
}
