import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';

/**
 * Help Menu
 * 
 * Help and information:
 * - Documentation
 * - Keyboard Shortcuts
 * - About
 */
export function HelpMenu() {
  const handleDocumentation = () => {
    window.open('https://github.com/gjbm2/dagnet', '_blank');
  };

  const handleKeyboardShortcuts = () => {
    // TODO: Show keyboard shortcuts dialog
    console.log('Keyboard shortcuts');
  };

  const handleAbout = () => {
    // TODO: Open about tab
    console.log('About DagNet');
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">Help</Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleDocumentation}
          >
            Documentation
          </Menubar.Item>

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleKeyboardShortcuts}
          >
            Keyboard Shortcuts
            <div className="menubar-right-slot">⌘/</div>
          </Menubar.Item>

          <Menubar.Separator className="menubar-separator" />

          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleAbout}
          >
            About DagNet
          </Menubar.Item>
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

