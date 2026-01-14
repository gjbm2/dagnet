import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { RefreshCw } from 'lucide-react';
import { useAppUpdateAvailable } from '../../hooks/useAppUpdateAvailable';

/**
 * Small menubar badge shown when a newer deployed client version is available.
 * Click reloads the page.
 */
export function AppUpdateBadge() {
  const { isUpdateAvailable, remoteVersion, reloadNow } = useAppUpdateAvailable();

  if (!isUpdateAvailable) return null;

  const label = remoteVersion ? `New version (${remoteVersion})` : 'New version';

  return (
    <Menubar.Menu>
      <Menubar.Trigger
        className="menubar-trigger menubar-update-badge"
        title="A newer client has been deployed. Click to reload."
        onClick={(e) => {
          // Radix Menubar Trigger is a button; avoid opening a menu.
          e.preventDefault();
          e.stopPropagation();
          reloadNow();
        }}
      >
        <RefreshCw size={14} />
        <span>{label}</span>
      </Menubar.Trigger>
    </Menubar.Menu>
  );
}


