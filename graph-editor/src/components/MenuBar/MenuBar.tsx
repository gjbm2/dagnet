import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { FileMenu } from './FileMenu';
import { EditMenu } from './EditMenu';
import { ViewMenu } from './ViewMenu';
import { ObjectsMenu } from './ObjectsMenu';
import { GitMenu } from './GitMenu';
import { HelpMenu } from './HelpMenu';
import './MenuBar.css';

/**
 * Application Menu Bar
 * 
 * Context-sensitive menu bar that adapts based on active tab type
 */
export function MenuBarComponent() {
  return (
    <div className="menu-bar">
      <Menubar.Root className="menubar-root">
        <FileMenu />
        <EditMenu />
        <ViewMenu />
        <ObjectsMenu />
        <GitMenu />
        <HelpMenu />
      </Menubar.Root>
    </div>
  );
}

