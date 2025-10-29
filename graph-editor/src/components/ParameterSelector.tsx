import React, { useState, useEffect, useRef } from 'react';
import { ObjectType } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useValidationMode } from '../contexts/ValidationContext';
import { useTabContext } from '../contexts/TabContext';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { NewFileModal } from './NewFileModal';
import { fileRegistry } from '../contexts/TabContext';

interface ParameterSelectorProps {
  /** The type of item being selected (parameter, context, case, or node) */
  type: 'parameter' | 'context' | 'case' | 'node';
  /** Current value (ID of selected item) */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Optional placeholder text */
  placeholder?: string;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Optional label */
  label?: string;
  /** Auto-focus input and show dropdown on mount */
  autoFocus?: boolean;
}

/**
 * ParameterSelector Component
 * 
 * A generic selector for parameters, contexts, cases, and nodes.
 * Integrates with the registry system and supports:
 * - Search/autocomplete from registry
 * - Validation modes (warning, strict, none)
 * - Quick file creation for registry IDs without files
 * - Free-form entry (depending on validation mode)
 */
export function ParameterSelector({
  type,
  value,
  onChange,
  placeholder,
  disabled = false,
  label,
  autoFocus = false
}: ParameterSelectorProps) {
  const { state, operations: navOps } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  const { mode: validationMode } = useValidationMode();
  const { graph } = useGraphStore(); // Get current graph to check for used IDs
  const [inputValue, setInputValue] = useState(value);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isNewFileModalOpen, setIsNewFileModalOpen] = useState(false);
  const [selectedRegistryId, setSelectedRegistryId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Sync inputValue with value prop, but only if value actually changed
  // (not just a re-render with the same value)
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current !== value) {
      setInputValue(value);
      prevValueRef.current = value;
    }
  }, [value]);

  // Get registry items for this type
  const registryItems = state.registryIndexes ? (() => {
    const key = `${type}s` as keyof typeof state.registryIndexes;
    const index = state.registryIndexes[key];
    
    if (!index) return [];
    
    // Extract IDs from the registry index
    if (type === 'parameter' && 'parameters' in index) {
      return (index as any).parameters.map((p: any) => ({ id: p.id, name: p.name, description: p.description, file_path: p.file_path }));
    } else if (type === 'context' && 'contexts' in index) {
      return (index as any).contexts.map((c: any) => ({ id: c.id, name: c.name, description: c.description, file_path: c.file_path }));
    } else if (type === 'case' && 'cases' in index) {
      return (index as any).cases.map((c: any) => ({ id: c.id, name: c.name, description: c.description, file_path: c.file_path }));
    } else if (type === 'node' && 'nodes' in index) {
      return (index as any).nodes.map((n: any) => ({ id: n.id, name: n.name, description: n.description, file_path: n.file_path }));
    }
    return [];
  })() : [];

  // Get list of used IDs in the current graph (for nodes only)
  const usedIdsInGraph = type === 'node' && graph ? 
    new Set(graph.nodes.map((n: any) => n.slug).filter(Boolean)) : 
    new Set();

  // Filter registry items by input value
  const filteredItems = registryItems.filter((item: any) => {
    const query = inputValue.toLowerCase();
    return item.id.toLowerCase().includes(query) || 
           (item.name && item.name.toLowerCase().includes(query)) ||
           (item.description && item.description.toLowerCase().includes(query));
  });

  // Sort filtered items: unused first, then used (for nodes only)
  const sortedItems = type === 'node' ? 
    [...filteredItems].sort((a, b) => {
      const aUsed = usedIdsInGraph.has(a.id);
      const bUsed = usedIdsInGraph.has(b.id);
      if (aUsed === bUsed) return 0; // Keep original order if both are used or both unused
      return aUsed ? 1 : -1; // Unused items first
    }) :
    filteredItems;

  // Check if current value is in registry
  const isInRegistry = registryItems.some((item: any) => item.id === inputValue);
  const registryHasFile = registryItems.find((item: any) => item.id === inputValue)?.file_path;
  
  // Check if file exists locally (in FileRegistry or as a local item in navigator)
  const fileExistsLocally = fileRegistry.getFile(`${type}-${inputValue}.${type === 'graph' ? 'json' : 'yaml'}`) !== null;
  
  const hasFile = registryHasFile || fileExistsLocally;

  // Validation state
  const showWarning = validationMode === 'warning' && inputValue && !isInRegistry;
  const showError = validationMode === 'strict' && inputValue && !isInRegistry;

  // Auto-focus and show dropdown when autoFocus is true (e.g., no slug yet)
  useEffect(() => {
    if (autoFocus && inputRef.current && !value) {
      // Small delay to ensure component is fully rendered
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          if (validationMode !== 'none' && registryItems.length > 0) {
            setShowSuggestions(true);
          }
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus, value, validationMode, registryItems.length]); // Re-run when these change

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        inputRef.current && 
        !inputRef.current.contains(e.target as Node) &&
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setShowSuggestions(true);
    
    // In non-strict mode, propagate changes immediately
    if (validationMode !== 'strict') {
      onChange(newValue);
    }
  };

  const handleSelectItem = (item: any) => {
    setInputValue(item.id);
    onChange(item.id);
    setShowSuggestions(false);
    inputRef.current?.blur();
  };

  const handleInputBlur = () => {
    // Delay to allow clicking on suggestions
    setTimeout(() => {
      setShowSuggestions(false);
      
      // In strict mode, revert to last valid value if invalid
      if (validationMode === 'strict' && inputValue && !isInRegistry) {
        setInputValue(value);
      }
    }, 200);
  };

  const handleInputFocus = () => {
    if (validationMode !== 'none' && registryItems.length > 0) {
      setShowSuggestions(true);
    }
  };

  const handleCreateFile = async (name: string, fileType: ObjectType) => {
    // Create the file using the same logic as other places
    const defaultData = fileType === 'graph' 
      ? { 
          nodes: [], 
          edges: [], 
          metadata: { 
            name, 
            description: '', 
            created: new Date().toISOString() 
          } 
        }
      : { id: name, name, description: '' };

    const file = fileRegistry.getOrCreateFile(`${fileType}-${name}.${fileType === 'graph' ? 'json' : 'yaml'}`, fileType, defaultData);
    
    // Add to navigator as local item
    const newItem = {
      id: name,
      name: `${name}.${fileType === 'graph' ? 'json' : 'yaml'}`,
      path: `${fileType}s/${name}.${fileType === 'graph' ? 'json' : 'yaml'}`,
      type: fileType,
      size: 0,
      lastModified: new Date().toISOString(),
      isLocal: true
    };
    
    await navOps.addLocalItem(newItem);

    // Open the file in a new tab
    await tabOps.openTab(newItem, 'interactive');

    // Refresh the navigator to update the registry state
    await navOps.refreshItems();

    // Set as selected value
    setInputValue(name);
    onChange(name);
    setShowSuggestions(false);
  };

  const displayLabel = label || `${type.charAt(0).toUpperCase() + type.slice(1)}`;

  return (
    <div style={{ marginBottom: '16px' }}>
      {/* Label */}
      <label 
        htmlFor={`selector-${type}`}
        style={{ 
          fontWeight: '500', 
          fontSize: '14px', 
          display: 'block', 
          marginBottom: '6px',
          color: '#333'
        }}
      >
        {displayLabel}:
      </label>

      {/* Input with suggestions */}
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          id={`selector-${type}`}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          placeholder={placeholder || `Select or enter ${type} ID...`}
          disabled={disabled}
          style={{
            width: '100%',
            padding: '8px 12px',
            paddingRight: hasFile ? '40px' : '12px', // Make room for open icon
            border: showError ? '2px solid #dc3545' : showWarning ? '2px solid #ffc107' : '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '14px',
            backgroundColor: disabled ? '#f5f5f5' : '#fff',
            cursor: disabled ? 'not-allowed' : 'text',
            outline: 'none'
          }}
        />

        {/* Open file icon (when file exists) */}
        {hasFile && inputValue && (
          <button
            type="button"
            onClick={async () => {
              const item = {
                id: inputValue,
                name: `${inputValue}.${type === 'graph' ? 'json' : 'yaml'}`,
                path: `${type}s/${inputValue}.${type === 'graph' ? 'json' : 'yaml'}`,
                type: type,
                size: 0,
                lastModified: new Date().toISOString()
              };
              await tabOps.openTab(item, 'interactive');
            }}
            style={{
              position: 'absolute',
              right: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '16px',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              color: '#0066cc'
            }}
            title={`Open ${inputValue}`}
          >
            ↗
          </button>
        )}

        {/* Validation indicator (only show if no file exists) */}
        {!hasFile && showWarning && (
          <div style={{ 
            position: 'absolute', 
            right: '8px', 
            top: '50%', 
            transform: 'translateY(-50%)',
            color: '#ffc107',
            fontSize: '18px',
            pointerEvents: 'none'
          }}>
            ⚠️
          </div>
        )}
        {!hasFile && showError && (
          <div style={{ 
            position: 'absolute', 
            right: '8px', 
            top: '50%', 
            transform: 'translateY(-50%)',
            color: '#dc3545',
            fontSize: '18px',
            pointerEvents: 'none'
          }}>
            ❌
          </div>
        )}

        {/* Suggestions dropdown */}
        {showSuggestions && sortedItems.length > 0 && validationMode !== 'none' && (
          <div
            ref={suggestionsRef}
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: '4px',
              maxHeight: '200px',
              overflowY: 'auto',
              backgroundColor: '#fff',
              border: '1px solid #ccc',
              borderRadius: '4px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              zIndex: 1000
            }}
          >
            {sortedItems.map((item: any) => {
              const isUsed = type === 'node' && usedIdsInGraph.has(item.id);
              return (
                <div
                  key={item.id}
                  onClick={() => handleSelectItem(item)}
                  style={{
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #eee',
                    backgroundColor: inputValue === item.id ? '#e6f2ff' : '#fff',
                    transition: 'background-color 0.15s',
                    opacity: isUsed ? 0.5 : 1
                  }}
                  onMouseEnter={(e) => {
                    if (inputValue !== item.id) {
                      e.currentTarget.style.backgroundColor = '#f5f5f5';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (inputValue !== item.id) {
                      e.currentTarget.style.backgroundColor = '#fff';
                    }
                  }}
                >
                  <div style={{ fontWeight: 500, fontSize: '13px', marginBottom: '2px', color: '#333', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>{item.id}</span>
                    {isUsed && (
                      <span style={{ fontSize: '10px', color: '#999' }} title="Already used in this graph">
                        ✓
                      </span>
                    )}
                    {!item.file_path && (
                      <span style={{ 
                        marginLeft: '2px', 
                        fontSize: '11px', 
                        color: '#999',
                        fontStyle: 'italic'
                      }}>
                        (planned)
                      </span>
                    )}
                  </div>
                  {item.name && (
                    <div style={{ fontSize: '12px', color: '#666' }}>
                      {item.name}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Validation message */}
      {showWarning && (
        <div style={{ 
          marginTop: '4px', 
          fontSize: '12px', 
          color: '#ffc107',
          display: 'flex',
          alignItems: 'center',
          gap: '4px'
        }}>
          ⚠️ Not in registry. Consider using a registered {type}.
        </div>
      )}
      
      {/* Create File button - shows when in registry but no file exists */}
      {isInRegistry && !registryHasFile && !fileExistsLocally && inputValue && (
        <div style={{ 
          marginTop: '4px', 
          fontSize: '12px', 
          color: '#666',
          display: 'flex',
          alignItems: 'center',
          gap: '4px'
        }}>
          <span style={{ fontStyle: 'italic' }}>In registry, but no file yet.</span>
          <button
            type="button"
            onClick={() => {
              // Bypass modal - directly create file with current input value
              handleCreateFile(inputValue, type);
            }}
            style={{
              padding: '2px 8px',
              fontSize: '11px',
              border: '1px solid #0066cc',
              borderRadius: '3px',
              backgroundColor: '#fff',
              color: '#0066cc',
              cursor: 'pointer'
            }}
          >
            Create File
          </button>
        </div>
      )}
      {showError && (
        <div style={{ 
          marginTop: '4px', 
          fontSize: '12px', 
          color: '#dc3545',
          display: 'flex',
          alignItems: 'center',
          gap: '4px'
        }}>
          ❌ Must use a registered {type} ID in strict mode.
        </div>
      )}

      {/* NewFileModal for creating files */}
      <NewFileModal
        isOpen={isNewFileModalOpen}
        onClose={() => {
          setIsNewFileModalOpen(false);
          setSelectedRegistryId(null);
        }}
        onCreate={handleCreateFile}
        fileType={type}
        defaultName={selectedRegistryId || ''}
      />
    </div>
  );
}

