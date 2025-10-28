import React, { useMemo, useState } from 'react';
import { ObjectType } from '../types';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { NewFileModal } from './NewFileModal';
import { fileRegistry } from '../contexts/TabContext';
import { useTabContext } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';

interface NavigatorSectionContextMenuProps {
  sectionType: ObjectType;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * Context menu for Navigator section header right-click
 */
export function NavigatorSectionContextMenu({ sectionType, x, y, onClose }: NavigatorSectionContextMenuProps) {
  const { operations } = useTabContext();
  const { state: navState, operations: navOps } = useNavigatorContext();
  
  const [isNewFileModalOpen, setIsNewFileModalOpen] = useState(false);

  const menuItems: ContextMenuItem[] = useMemo(() => {
    const items: ContextMenuItem[] = [];
    
    // New file action
    items.push({
      label: `New ${sectionType.charAt(0).toUpperCase() + sectionType.slice(1)}...`,
      onClick: () => {
        setIsNewFileModalOpen(true);
      },
      keepMenuOpen: true
    });
    
    return items;
  }, [sectionType]);
  
  const handleCreateFile = async (name: string, type: ObjectType) => {
    // Create a new file with default content based on type
    const newFileId = `${type}-${name}`;
    
    let defaultData: any;
    if (type === 'graph') {
      defaultData = {
        nodes: [],
        edges: [],
        policies: {
          default_outcome: 'abandon',
          overflow_policy: 'error',
          free_edge_policy: 'complement'
        },
        metadata: {
          version: '1.0.0',
          created_at: new Date().toISOString(),
          author: 'Graph Editor',
          description: '',
          name: `${name}.json`
        }
      };
    } else {
      // YAML files (parameter, context, case)
      defaultData = {
        id: name,
        name: name,
        description: '',
        created_at: new Date().toISOString()
      };
    }
    
    // Create file in registry
    await fileRegistry.getOrCreateFile(
      newFileId,
      type,
      { repository: 'local', path: `${type}s/${name}`, branch: navState.selectedBranch || 'main' },
      defaultData
    );
    
    // Add to navigator items as local/uncommitted
    const newItem = {
      id: name,
      type: type,
      name: name,
      path: `${type}s/${name}.${type === 'graph' ? 'json' : 'yaml'}`,
      description: '',
      isLocal: true // Mark as uncommitted/local
    };
    
    navOps.addLocalItem(newItem);
    
    // Open the new file in a tab
    await operations.openTab(newItem, 'interactive');
    
    // Close modals
    setIsNewFileModalOpen(false);
    onClose();
  };

  return (
    <>
      <ContextMenu x={x} y={y} items={menuItems} onClose={onClose} />
      
      {/* New File Modal */}
      <NewFileModal
        isOpen={isNewFileModalOpen}
        onClose={() => {
          setIsNewFileModalOpen(false);
          onClose();
        }}
        onCreate={handleCreateFile}
        fileType={sectionType}
      />
    </>
  );
}

