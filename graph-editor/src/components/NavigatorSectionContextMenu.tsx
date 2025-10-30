import React, { useMemo, useState } from 'react';
import { ObjectType } from '../types';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { NewFileModal } from './NewFileModal';
import { useTabContext } from '../contexts/TabContext';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { fileOperationsService } from '../services/fileOperationsService';

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
    await fileOperationsService.createFile(name, type, {
      openInTab: true,
      viewMode: 'interactive'
    });
    
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

