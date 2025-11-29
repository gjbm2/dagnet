import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { FileMenu } from './FileMenu';
import { EditMenu } from './EditMenu';
import { ViewMenu } from './ViewMenu';
import { ObjectsMenu } from './ObjectsMenu';
import { DataMenu } from './DataMenu';
import { RepositoryMenu } from './RepositoryMenu';
import { HelpMenu } from './HelpMenu';
import { useTabContext } from '../../contexts/TabContext';
import './MenuBar.css';

// Import version from package.json
const APP_VERSION = '0.98.6-beta';

/**
 * Application Menu Bar
 * 
 * Context-sensitive menu bar that adapts based on active tab type
 */
export function MenuBarComponent() {
  const { operations } = useTabContext();

  const handleBrandClick = async () => {
    const aboutItem = {
      id: 'about-dagnet',
      type: 'markdown' as const,
      name: 'About DagNet',
      path: 'docs/about.md'
    };
    await operations.openTab(aboutItem, 'interactive', true);
  };

  return (
    <div className="menu-bar">
      <div 
        className="dagnet-brand" 
        onClick={handleBrandClick}
        title={`Dagnet v${APP_VERSION}`}
      >
        <img src="/dagnet-icon.png" alt="" className="dagnet-logo" />
        <span>Dagnet</span>
      </div>
      <Menubar.Root className="menubar-root">
        <FileMenu />
        <EditMenu />
        <ViewMenu />
        <ObjectsMenu />
        <DataMenu />
        <RepositoryMenu />
        <HelpMenu />
      </Menubar.Root>
    </div>
  );
}

