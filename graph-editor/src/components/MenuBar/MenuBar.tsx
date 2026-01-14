import React, { useState } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { Share2 } from 'lucide-react';
import { FileMenu } from './FileMenu';
import { EditMenu } from './EditMenu';
import { ViewMenu } from './ViewMenu';
import { ObjectsMenu } from './ObjectsMenu';
import { DataMenu } from './DataMenu';
import { RepositoryMenu } from './RepositoryMenu';
import { HelpMenu } from './HelpMenu';
import { AppUpdateBadge } from './AppUpdateBadge';
import { useTabContext } from '../../contexts/TabContext';
import { useDashboardMode } from '../../hooks/useDashboardMode';
import { DevConsoleMirrorControls } from './DevConsoleMirrorControls';
import { ShareLinkModal } from '../modals/ShareLinkModal';
import { APP_VERSION } from '../../version';
import './MenuBar.css';

/**
 * Application Menu Bar
 * 
 * Context-sensitive menu bar that adapts based on active tab type
 */
export function MenuBarComponent() {
  const { operations } = useTabContext();
  const { isDashboardMode, toggleDashboardMode } = useDashboardMode();
  const [shareModalOpen, setShareModalOpen] = useState(false);

  const handleBrandClick = async () => {
    toggleDashboardMode({ updateUrl: true });
  };

  return (
    <div className="menu-bar">
      <Menubar.Root className="menubar-root">
        <FileMenu />
        <EditMenu />
        <ViewMenu />
        <ObjectsMenu />
        <DataMenu />
        <RepositoryMenu />
        <HelpMenu />
        <AppUpdateBadge />
      </Menubar.Root>
      <div className="dagnet-right-controls">
        <DevConsoleMirrorControls />
        {!isDashboardMode && (
          <button
            className="share-link-button"
            onClick={() => setShareModalOpen(true)}
            title="Share link..."
          >
            <Share2 size={18} />
          </button>
        )}
        <div
          className="dagnet-brand"
          onClick={handleBrandClick}
          title={`Dagnet v${APP_VERSION}`}
        >
          <img src="/dagnet-icon.png" alt="" className="dagnet-logo" />
          <span>Dagnet</span>
        </div>
      </div>
      <ShareLinkModal isOpen={shareModalOpen} onClose={() => setShareModalOpen(false)} />
    </div>
  );
}

