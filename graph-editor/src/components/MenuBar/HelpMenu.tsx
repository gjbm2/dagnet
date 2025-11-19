import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useTabContext } from '../../contexts/TabContext';

/**
 * Help Menu
 * 
 * Help and information:
 * - Documentation
 * - Keyboard Shortcuts
 * - About
 */
export function HelpMenu() {
  const { operations } = useTabContext();
  const [docFiles, setDocFiles] = useState<Array<{id: string, name: string, title: string}>>([]);

  // Load available documentation files from build-time generated index
  useEffect(() => {
    const loadDocFiles = async () => {
      try {
        // Fetch the build-time generated index.json
        const indexResponse = await fetch('/docs/index.json');
        if (indexResponse.ok) {
          const indexData = await indexResponse.json();
          const docFilesWithTitles = await Promise.all(
            indexData.files.map(async (filename: string) => {
              try {
                const response = await fetch(`/docs/${filename}`);
                if (response.ok) {
                  const content = await response.text();
                  // Extract first H1 title
                  const h1Match = content.match(/^#\s+(.+)$/m);
                  const title = h1Match ? h1Match[1] : filename.replace('.md', '').replace(/-/g, ' ');
                  return {
                    id: filename.replace('.md', ''),
                    name: filename,
                    title: title
                  };
                }
              } catch (error) {
                console.warn(`Failed to load ${filename}:`, error);
              }
              return null;
            })
          );
          setDocFiles(docFilesWithTitles.filter(Boolean) as Array<{id: string, name: string, title: string}>);
        } else {
          console.error('Failed to load docs index.json');
        }
      } catch (error) {
        console.error('Failed to load documentation files:', error);
      }
    };

    loadDocFiles();
  }, []);

  const handleExploreRepo = () => {
    window.open('https://github.com/gjbm2/dagnet', '_blank');
  };

  const handleKeyboardShortcuts = async () => {
    const shortcutsItem = {
      id: 'keyboard-shortcuts',
      type: 'markdown' as const,
      name: 'Keyboard Shortcuts',
      path: 'docs/keyboard-shortcuts.md'
    };
    await operations.openTab(shortcutsItem, 'interactive', true);
  };

  const handleAbout = async () => {
    const aboutItem = {
      id: 'about',
      type: 'markdown' as const,
      name: 'About DagNet',
      path: 'docs/about.md'
    };
    await operations.openTab(aboutItem, 'interactive', true);
  };

  const handleCurrentVersion = async () => {
    const changelogItem = {
      id: 'changelog',
      type: 'markdown' as const,
      name: 'Release Notes',
      path: 'CHANGELOG.md'
    };
    await operations.openTab(changelogItem, 'interactive', true);
  };

  const handleDocFile = async (docFile: {id: string, name: string, title: string}) => {
    const docItem = {
      id: docFile.id,
      type: 'markdown' as const,
      name: docFile.title,
      path: `docs/${docFile.name}`
    };
    await operations.openTab(docItem, 'interactive', true);
  };

  return (
    <Menubar.Menu>
      <Menubar.Trigger className="menubar-trigger">Help</Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content className="menubar-content" align="start">
          <Menubar.Item 
            className="menubar-item" 
            onSelect={handleExploreRepo}
          >
            Explore App Repo
          </Menubar.Item>

          <Menubar.Sub>
            <Menubar.SubTrigger className="menubar-item">
              Documentation
            </Menubar.SubTrigger>
            <Menubar.Portal>
              <Menubar.SubContent className="menubar-content">
                {docFiles.map((docFile) => (
                  <Menubar.Item
                    key={docFile.id}
                    className="menubar-item"
                    onSelect={() => handleDocFile(docFile)}
                  >
                    {docFile.title}
                  </Menubar.Item>
                ))}
              </Menubar.SubContent>
            </Menubar.Portal>
          </Menubar.Sub>

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
            onSelect={handleCurrentVersion}
          >
            Current Version
            <div className="menubar-right-slot">v{import.meta.env.VITE_APP_VERSION || '0.91b'}</div>
          </Menubar.Item>

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

