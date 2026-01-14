import React, { useState, useEffect } from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { ChevronRight } from 'lucide-react';
import { useTabContext } from '../../contexts/TabContext';
import { APP_VERSION } from '../../version';

interface DocFile {
  id: string;
  name: string;
  title: string;
}

interface DocCategory {
  label: string;
  files: DocFile[];
}

/**
 * Help Menu
 * 
 * Help and information:
 * - Documentation (user guides)
 * - Developer Documentation (internal/technical)
 * - Keyboard Shortcuts
 * - About
 */
export function HelpMenu() {
  const { operations } = useTabContext();
  const [docFiles, setDocFiles] = useState<DocFile[]>([]);
  const [categories, setCategories] = useState<Record<string, DocCategory>>({});

  // Load available documentation files from build-time generated index
  useEffect(() => {
    const loadDocFiles = async () => {
      try {
        // Fetch the build-time generated index.json
        const indexResponse = await fetch('/docs/index.json');
        if (indexResponse.ok) {
          const indexData = await indexResponse.json();
          
          // Load root-level docs
          const rootFilesWithTitles = await Promise.all(
            (indexData.files || []).map(async (filename: string) => {
              try {
                const response = await fetch(`/docs/${filename}`);
                if (response.ok) {
                  const content = await response.text();
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
          setDocFiles(rootFilesWithTitles.filter(Boolean) as DocFile[]);

          // Load categorised docs (subdirectories)
          const loadedCategories: Record<string, DocCategory> = {};
          for (const [catKey, catData] of Object.entries(indexData.categories || {})) {
            const cat = catData as { label: string; files: string[] };
            const filesWithTitles = await Promise.all(
              cat.files.map(async (filepath: string) => {
                try {
                  const response = await fetch(`/docs/${filepath}`);
                  if (response.ok) {
                    const content = await response.text();
                    const h1Match = content.match(/^#\s+(.+)$/m);
                    const filename = filepath.split('/').pop() || filepath;
                    const title = h1Match ? h1Match[1] : filename.replace('.md', '').replace(/-/g, ' ');
                    return {
                      id: filepath.replace('.md', '').replace(/\//g, '-'),
                      name: filepath,
                      title: title
                    };
                  }
                } catch (error) {
                  console.warn(`Failed to load ${filepath}:`, error);
                }
                return null;
              })
            );
            loadedCategories[catKey] = {
              label: cat.label,
              files: filesWithTitles.filter(Boolean) as DocFile[]
            };
          }
          setCategories(loadedCategories);
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
      id: 'CHANGELOG',
      type: 'markdown' as const,
      name: 'Release Notes',
      path: 'docs/CHANGELOG.md'
    };
    await operations.openTab(changelogItem, 'interactive', true);
  };

  const handleDocFile = async (docFile: DocFile) => {
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
              <div className="menubar-right-slot"><ChevronRight size={14} /></div>
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

          {/* Render category submenus (e.g., Developer Documentation) */}
          {Object.entries(categories).map(([catKey, category]) => (
            <Menubar.Sub key={catKey}>
              <Menubar.SubTrigger className="menubar-item">
                {category.label}
                <div className="menubar-right-slot"><ChevronRight size={14} /></div>
              </Menubar.SubTrigger>
              <Menubar.Portal>
                <Menubar.SubContent className="menubar-content">
                  {category.files.map((docFile) => (
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
          ))}

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
            <div className="menubar-right-slot">v{APP_VERSION}</div>
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

