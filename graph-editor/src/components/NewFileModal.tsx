import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ObjectType } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';

interface NewFileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, type: ObjectType, metadata?: any) => Promise<void>;
  fileType?: ObjectType; // If provided, type selector is hidden and this type is used
  defaultName?: string; // For duplicate functionality
}

type CreationMode = 'new' | 'from-registry';

/**
 * New File Modal
 * Prompts for file name and type (if not pre-selected)
 */
export function NewFileModal({ isOpen, onClose, onCreate, fileType, defaultName = '' }: NewFileModalProps) {
  const { state } = useNavigatorContext();
  const [fileName, setFileName] = useState(defaultName);
  const [selectedType, setSelectedType] = useState<ObjectType>(fileType || 'graph');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creationMode, setCreationMode] = useState<CreationMode>('new');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRegistryId, setSelectedRegistryId] = useState<string | null>(null);

  // Get registry items for the selected type
  const typeToUse = fileType || selectedType;
  const registrySupported = 
    typeToUse === 'parameter' || 
    typeToUse === 'context' || 
    typeToUse === 'case' || 
    typeToUse === 'node' ||
    typeToUse === 'event';
  
  const registryItems = registrySupported && state.registryIndexes ? (() => {
    const key = `${typeToUse}s` as keyof typeof state.registryIndexes;
    const index = state.registryIndexes[key];
    
    if (!index) return [];
    
    // Extract IDs from the registry index (preserve full item data where needed)
    if (typeToUse === 'parameter' && 'parameters' in index) {
      return (index as any).parameters.map((p: any) => ({ 
        id: p.id, 
        name: p.name, 
        description: p.description,
        type: p.type // Preserve parameter subtype (probability, cost_gbp, cost_time)
      }));
    } else if (typeToUse === 'context' && 'contexts' in index) {
      return (index as any).contexts.map((c: any) => ({ id: c.id, name: c.name, description: c.description }));
    } else if (typeToUse === 'case' && 'cases' in index) {
      return (index as any).cases.map((c: any) => ({ id: c.id, name: c.name, description: c.description }));
    } else if (typeToUse === 'node' && 'nodes' in index) {
      return (index as any).nodes.map((n: any) => ({ id: n.id, name: n.name, description: n.description }));
    } else if (typeToUse === 'event' && 'events' in index) {
      return (index as any).events.map((e: any) => ({
        id: e.id,
        name: e.name,
        description: e.description
      }));
    }
    return [];
  })() : [];

  // Filter registry items by search query
  const filteredRegistryItems = registryItems.filter((item: any) => {
    const query = searchQuery.toLowerCase();
    return item.id.toLowerCase().includes(query) || 
           (item.name && item.name.toLowerCase().includes(query)) ||
           (item.description && item.description.toLowerCase().includes(query));
  });

  // Reset mode when type changes
  useEffect(() => {
    if (!registrySupported) {
      setCreationMode('new');
    }
  }, [registrySupported]);

  // Reset search and selection when mode changes
  useEffect(() => {
    setSearchQuery('');
    setSelectedRegistryId(null);
  }, [creationMode]);

  const handleCreate = async () => {
    // In from-registry mode, use the selected registry ID
    // In new mode, use the entered file name
    const nameToUse = creationMode === 'from-registry' && selectedRegistryId 
      ? selectedRegistryId 
      : fileName.trim();
    
    if (!nameToUse) {
      setError(creationMode === 'from-registry' ? 'Please select a registry item' : 'Please enter a file name');
      return;
    }

    // Validate name (alphanumeric, hyphens, underscores) - only for new mode
    if (creationMode === 'new' && !/^[a-zA-Z0-9_-]+$/.test(nameToUse)) {
      setError('File name can only contain letters, numbers, hyphens, and underscores');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // If creating from registry, find the full registry item to pass its metadata
      const selectedItem = creationMode === 'from-registry' 
        ? registryItems.find((item: any) => item.id === selectedRegistryId)
        : null;
      
      // For parameters created from registry, pass the parameter type (probability, cost_gbp, etc)
      const metadata = selectedItem?.type ? { parameterType: selectedItem.type } : {};
      
      // onCreate signature is (name, objectType), but we also need to pass metadata
      // The onCreate callback will need to handle metadata - let's update the callers
      await onCreate(nameToUse, typeToUse, metadata);
      
      // Success - close modal
      handleCancel();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to create file');
      setIsCreating(false);
    }
  };

  const handleCancel = () => {
    setFileName(defaultName);
    setSelectedType(fileType || 'graph');
    setError(null);
    setIsCreating(false);
    setCreationMode('new');
    setSearchQuery('');
    setSelectedRegistryId(null);
    onClose();
  };

  if (!isOpen) return null;

  const fileExtension = typeToUse === 'graph' ? '.json' : '.yaml';
  const canSubmit = creationMode === 'from-registry' ? !!selectedRegistryId : !!fileName.trim();

  const modalContent = (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000
      }}
      onClick={handleCancel}
    >
      <div 
        style={{
          background: '#fff',
          borderRadius: '8px',
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
          minWidth: '400px',
          maxWidth: '500px',
          width: '90%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid #e0e0e0'
        }}>
          <h3 style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            color: '#333'
          }}>
            {defaultName ? 'Duplicate File' : 'New File'}
          </h3>
        </div>

        {/* Body */}
        <div style={{
          padding: '24px'
        }}>
          {/* File type selector (if not pre-selected) */}
          {!fileType && (
            <div style={{ marginBottom: '20px' }}>
              <label htmlFor="file-type" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                File Type:
              </label>
              <select
                id="file-type"
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value as ObjectType)}
                disabled={isCreating}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  border: '1px solid #ccc',
                  fontSize: '14px',
                  backgroundColor: '#fff',
                  cursor: isCreating ? 'not-allowed' : 'pointer'
                }}
              >
                <option value="graph">Graph</option>
                <option value="parameter">Parameter</option>
                <option value="context">Context</option>
                <option value="case">Case</option>
                <option value="node">Node</option>
              </select>
            </div>
          )}

          {/* Mode toggle (only for registry-supported types) */}
          {registrySupported && !defaultName && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ 
                display: 'flex', 
                gap: '8px',
                padding: '4px',
                backgroundColor: '#f5f5f5',
                borderRadius: '6px'
              }}>
                <button
                  type="button"
                  onClick={() => setCreationMode('new')}
                  disabled={isCreating}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: isCreating ? 'not-allowed' : 'pointer',
                    backgroundColor: creationMode === 'new' ? '#fff' : 'transparent',
                    color: creationMode === 'new' ? '#0066cc' : '#666',
                    boxShadow: creationMode === 'new' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    transition: 'all 0.2s'
                  }}
                >
                  New {typeToUse}
                </button>
                <button
                  type="button"
                  onClick={() => setCreationMode('from-registry')}
                  disabled={isCreating || registryItems.length === 0}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '13px',
                    fontWeight: 500,
                    cursor: (isCreating || registryItems.length === 0) ? 'not-allowed' : 'pointer',
                    backgroundColor: creationMode === 'from-registry' ? '#fff' : 'transparent',
                    color: creationMode === 'from-registry' ? '#0066cc' : '#666',
                    boxShadow: creationMode === 'from-registry' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    transition: 'all 0.2s',
                    opacity: registryItems.length === 0 ? 0.5 : 1
                  }}
                >
                  From Registry ({registryItems.length})
                </button>
              </div>
            </div>
          )}

          {/* NEW MODE: File name input */}
          {creationMode === 'new' && (
            <div style={{ marginBottom: '20px' }}>
              <label htmlFor="file-name" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                File Name:
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="file-name"
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isCreating && canSubmit) {
                      handleCreate();
                    } else if (e.key === 'Escape') {
                      handleCancel();
                    }
                  }}
                  placeholder={`my-${typeToUse}`}
                  disabled={isCreating}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    paddingRight: '80px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    fontSize: '14px'
                  }}
                />
                <span style={{
                  position: 'absolute',
                  right: '12px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#888',
                  fontSize: '14px',
                  pointerEvents: 'none'
                }}>
                  {fileExtension}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                Letters, numbers, hyphens, and underscores only
              </div>
            </div>
          )}

          {/* FROM-REGISTRY MODE: Search and selection */}
          {creationMode === 'from-registry' && (
            <div style={{ marginBottom: '20px' }}>
              {/* Search input */}
              <div style={{ marginBottom: '12px' }}>
                <label htmlFor="registry-search" style={{ fontWeight: '500', fontSize: '14px', display: 'block', marginBottom: '8px' }}>
                  Search Registry:
                </label>
                <input
                  id="registry-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by ID, name, or description..."
                  disabled={isCreating}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #ccc',
                    borderRadius: '4px',
                    fontSize: '14px'
                  }}
                />
              </div>

              {/* Registry items list */}
              <div style={{
                maxHeight: '250px',
                overflowY: 'auto',
                border: '1px solid #ddd',
                borderRadius: '4px',
                backgroundColor: '#fafafa'
              }}>
                {filteredRegistryItems.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#999', fontSize: '14px' }}>
                    {searchQuery ? 'No matching items found' : 'Registry is empty'}
                  </div>
                ) : (
                  filteredRegistryItems.map((item: any) => (
                    <div
                      key={item.id}
                      onClick={() => setSelectedRegistryId(item.id)}
                      style={{
                        padding: '12px 16px',
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        backgroundColor: selectedRegistryId === item.id ? '#e6f2ff' : '#fff',
                        transition: 'background-color 0.15s'
                      }}
                      onMouseEnter={(e) => {
                        if (selectedRegistryId !== item.id) {
                          e.currentTarget.style.backgroundColor = '#f5f5f5';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (selectedRegistryId !== item.id) {
                          e.currentTarget.style.backgroundColor = '#fff';
                        }
                      }}
                    >
                      <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '2px', color: '#333' }}>
                        {item.id}
                      </div>
                      {item.name && (
                        <div style={{ fontSize: '13px', color: '#666', marginBottom: '2px' }}>
                          {item.name}
                        </div>
                      )}
                      {item.description && (
                        <div style={{ fontSize: '12px', color: '#999' }}>
                          {item.description}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              padding: '12px',
              backgroundColor: '#fee',
              border: '1px solid #fcc',
              borderRadius: '4px',
              color: '#c33',
              fontSize: '14px',
              marginBottom: '20px'
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '8px'
        }}>
          <button
            type="button"
            onClick={handleCancel}
            disabled={isCreating}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: isCreating ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#f0f0f0',
              color: '#333',
              opacity: isCreating ? 0.5 : 1
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={isCreating || !canSubmit}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: (isCreating || !canSubmit) ? 'not-allowed' : 'pointer',
              border: 'none',
              backgroundColor: '#0066cc',
              color: 'white',
              opacity: (isCreating || !canSubmit) ? 0.5 : 1
            }}
          >
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

