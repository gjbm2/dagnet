import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { Share2, Sun, Moon } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { FileMenu } from './FileMenu';
import { EditMenu } from './EditMenu';
import { ViewMenu } from './ViewMenu';
import { ElementsMenu } from './ElementsMenu';
import { DataMenu } from './DataMenu';
import { RepositoryMenu } from './RepositoryMenu';
import { HelpMenu } from './HelpMenu';
import { AppUpdateBadge } from './AppUpdateBadge';
import { useDashboardMode } from '../../hooks/useDashboardMode';
import { DevConsoleMirrorControls } from './DevConsoleMirrorControls';
import { DevBayesTrigger } from './DevBayesTrigger';
import { ShareLinkModal } from '../modals/ShareLinkModal';
import { APP_VERSION } from '../../version';
import { useHealthStatus } from '../../hooks/useHealthStatus';
import { GitHubOAuthChip } from '../../hooks/useGitHubOAuthChip';
import './MenuBar.css';

/**
 * Application Menu Bar
 * 
 * Context-sensitive menu bar that adapts based on active tab type
 */
export function MenuBarComponent() {
  const { isDashboardMode, toggleDashboardMode } = useDashboardMode();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const { mode: healthMode, tooltip: healthTooltip } = useHealthStatus({ pollIntervalMs: 5 * 60_000 });
  const { theme, toggleTheme } = useTheme();

  const handleBrandClick = async () => {
    toggleDashboardMode({ updateUrl: true });
  };

  return (
    <div className="menu-bar">
      <Menubar.Root className="menubar-root">
        <FileMenu />
        <EditMenu />
        <ViewMenu />
        <ElementsMenu />
        <DataMenu />
        <RepositoryMenu />
        <HelpMenu />
        <AppUpdateBadge />
      </Menubar.Root>
      <div className="dagnet-right-controls">
        <DevBayesTrigger />
        <DevConsoleMirrorControls />
        <GitHubOAuthChip />
        {!isDashboardMode && (
          <button
            className="share-link-button"
            onClick={() => setShareModalOpen(true)}
            title="Share link..."
          >
            <Share2 size={18} />
          </button>
        )}
        <button
          className="theme-toggle-button"
          onClick={toggleTheme}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <div
          className={`dagnet-brand dagnet-brand--health-${healthMode}`}
          onClick={handleBrandClick}
          title={`Dagnet v${APP_VERSION}\n\n${healthTooltip}`}
        >
          <img src="/dagnet-icon.png" alt="" className="dagnet-logo" />
          <span>Dagnet</span>
        </div>
      </div>
      <ShareLinkModal isOpen={shareModalOpen} onClose={() => setShareModalOpen(false)} />
    </div>
  );
}

