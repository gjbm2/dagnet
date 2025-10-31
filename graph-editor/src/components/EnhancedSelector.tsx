import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ObjectType } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useValidationMode } from '../contexts/ValidationContext';
import { useTabContext } from '../contexts/TabContext';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { fileRegistry } from '../contexts/TabContext';
import { registryService, RegistryItem } from '../services/registryService';
import './EnhancedSelector.css';

interface EnhancedSelectorProps {
  /** The type of item being selected */
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
  /** Filter parameters by type (only applicable when type='parameter') */
  parameterType?: 'probability' | 'cost_gbp' | 'cost_time';
  /** Show "Current Graph" group in dropdown (for conditional node selection) */
  showCurrentGraphGroup?: boolean;
  /** Usage context for item (shows in sub-line) */
  usageContext?: string;
  /** Optional sync handlers */
  onPullFromRegistry?: () => Promise<void>;
  onPushToRegistry?: () => Promise<void>;
  onRetrieveLatest?: () => Promise<void>;
}

/**
 * EnhancedSelector Component
 * 
 * Universal selector for all connection fields (nodes, parameters, cases, contexts).
 * Features:
 * - Distinctive pastel border (type-specific color)
 * - Plug icon (grey=disconnected, black=connected)
 * - Clear 'x' button
 * - Sync menu '[⋮]' with Pull/Push/Retrieve options
 * - Grouped dropdown with sub-line usage info
 * - Inline creation for non-existent IDs
 */
export function EnhancedSelector({
  type,
  value,
  onChange,
  placeholder,
  disabled = false,
  label,
  autoFocus = false,
  parameterType,
  showCurrentGraphGroup = false,
  usageContext,
  onPullFromRegistry,
  onPushToRegistry,
  onRetrieveLatest
}: EnhancedSelectorProps) {
  const { operations: navOps } = useNavigatorContext();
  const { operations: tabOps } = useTabContext();
  const { mode: validationMode } = useValidationMode();
  const { graph } = useGraphStore();
  
  const [inputValue, setInputValue] = useState(value);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [registryItems, setRegistryItems] = useState<RegistryItem[]>([]);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sync inputValue with value prop
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (prevValueRef.current !== value) {
      setInputValue(value);
      prevValueRef.current = value;
    }
  }, [value]);

  // Load registry items
  useEffect(() => {
    const loadItems = async () => {
      try {
        let items: RegistryItem[];
        
        if (type === 'parameter' && parameterType) {
          items = await registryService.getParametersByType(parameterType);
        } else {
          items = await registryService.getItems(type);
        }
        
        setRegistryItems(items);
      } catch (error) {
        console.error(`Failed to load ${type} items:`, error);
        setRegistryItems([]);
      }
    };
    
    loadItems();
  }, [type, parameterType]);

  // Map registry items
  const allItems = registryItems.map(item => ({
    id: item.id,
    name: item.name || item.id,
    description: item.description,
    file_path: item.file_path,
    type: item.parameter_type || item.node_type || item.case_type,
    isLocal: item.isLocal
  }));

  // Get current graph nodes (for showCurrentGraphGroup)
  const currentGraphItems = showCurrentGraphGroup && graph ? 
    graph.nodes.map((n: any) => n.slug).filter(Boolean) : [];

  // Get used IDs in graph (for dimming)
  const usedIdsInGraph = type === 'node' && graph ? 
    new Set(graph.nodes.map((n: any) => n.slug).filter(Boolean)) : 
    new Set();

  // Filter items by input
  const filteredItems = allItems.filter((item: any) => {
    const query = inputValue.toLowerCase();
    return item.id.toLowerCase().includes(query) || 
           (item.name && item.name.toLowerCase().includes(query)) ||
           (item.description && item.description.toLowerCase().includes(query));
  });

  // Group items
  const groupedItems: { group: string; items: any[] }[] = [];
  
  if (showCurrentGraphGroup && currentGraphItems.length > 0) {
    const graphItems = filteredItems.filter((item: any) => 
      currentGraphItems.includes(item.id)
    );
    if (graphItems.length > 0) {
      groupedItems.push({ group: 'Current Graph', items: graphItems });
    }
  }
  
  const registryGroupItems = filteredItems.filter((item: any) => 
    !showCurrentGraphGroup || !currentGraphItems.includes(item.id)
  );
  if (registryGroupItems.length > 0) {
    groupedItems.push({ 
      group: `${type.charAt(0).toUpperCase() + type.slice(1)} Registry`, 
      items: registryGroupItems 
    });
  }

  // Check connection status
  const isConnected = allItems.some((item: any) => item.id === inputValue);
  const hasFile = allItems.find((item: any) => item.id === inputValue)?.file_path || 
                  fileRegistry.getFile(`${type}-${inputValue}.yaml`) !== null;

  // Validation state
  const showWarning = validationMode === 'warning' && inputValue && !isConnected;
  const showError = validationMode === 'strict' && inputValue && !isConnected;

  // Check if input value is new (not in registry)
  const isNewId = inputValue && !allItems.some((item: any) => item.id === inputValue);

  // Auto-focus
  useEffect(() => {
    if (autoFocus && inputRef.current && !value) {
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          if (validationMode !== 'none' && allItems.length > 0) {
            setShowSuggestions(true);
          }
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus, value, validationMode, allItems.length]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        wrapperRef.current && 
        !wrapperRef.current.contains(e.target as Node) &&
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        syncMenuRef.current &&
        !syncMenuRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
        setShowSyncMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setShowSuggestions(true);
    
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

  const handleClear = () => {
    setInputValue('');
    onChange('');
    inputRef.current?.focus();
  };

  const handleInputFocus = () => {
    // Always show suggestions on focus if not in 'none' validation mode
    if (validationMode !== 'none') {
      setShowSuggestions(true);
    }
  };

  const handleInputBlur = () => {
    setTimeout(() => {
      setShowSuggestions(false);
      
      if (validationMode === 'strict' && inputValue && !isConnected) {
        setInputValue(value);
      }
    }, 200);
  };

  const handleCreateNew = async () => {
    const defaultData = { 
      id: inputValue, 
      name: inputValue, 
      description: '',
      metadata: {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    };

    const file = fileRegistry.getOrCreateFile(
      `${type}-${inputValue}.yaml`, 
      type, 
      { repository: 'local', path: `${type}s/${inputValue}.yaml`, branch: 'main' },
      defaultData
    );
    
    const newItem = {
      id: inputValue,
      name: `${inputValue}.yaml`,
      path: `${type}s/${inputValue}.yaml`,
      type: type,
      size: 0,
      lastModified: new Date().toISOString(),
      isLocal: true
    };
    
    await navOps.addLocalItem(newItem);
    await tabOps.openTab(newItem, 'interactive');
    await navOps.refreshItems();

    setInputValue(inputValue);
    onChange(inputValue);
    setShowSuggestions(false);
  };

  const handleSyncAction = async (action: 'pull' | 'push' | 'retrieve') => {
    setShowSyncMenu(false);
    
    try {
      if (action === 'pull' && onPullFromRegistry) {
        await onPullFromRegistry();
      } else if (action === 'push' && onPushToRegistry) {
        await onPushToRegistry();
      } else if (action === 'retrieve' && onRetrieveLatest) {
        await onRetrieveLatest();
      }
    } catch (error) {
      console.error(`Sync action '${action}' failed:`, error);
    }
  };

  const displayLabel = label || `${type.charAt(0).toUpperCase() + type.slice(1)}`;

  return (
    <div className="enhanced-selector" ref={wrapperRef}>
      {/* Label */}
      <label className="enhanced-selector-label" htmlFor={`selector-${type}`}>
        {displayLabel}:
      </label>

      {/* Input wrapper with pastel border */}
      <div 
        className={`enhanced-selector-input-wrapper type-${type} ${isConnected ? 'connected' : ''}`}
      >
        <div className={`enhanced-selector-inner ${showError ? 'error' : ''} ${showWarning ? 'warning' : ''}`}>
          {/* Plug icon */}
          <div className={`enhanced-selector-plug ${isConnected ? 'connected' : ''}`}>
            {isConnected ? '🔌' : '⚪'}
          </div>

          {/* Text input */}
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
            className="enhanced-selector-input"
          />

          {/* Clear button */}
          {inputValue && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              className="enhanced-selector-clear"
              title="Clear"
            >
              ✕
            </button>
          )}

          {/* Sync menu button */}
          {!disabled && (onPullFromRegistry || onPushToRegistry || onRetrieveLatest) && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setShowSyncMenu(!showSyncMenu)}
                className="enhanced-selector-sync"
                title="Sync options"
              >
                ⋮
              </button>

              {/* Sync menu dropdown */}
              {showSyncMenu && (
                <div ref={syncMenuRef} className="enhanced-selector-sync-menu">
                  {onPullFromRegistry && (
                    <div 
                      className="enhanced-selector-sync-menu-item"
                      onClick={() => handleSyncAction('pull')}
                    >
                      ⬇ Pull from Registry
                    </div>
                  )}
                  {onPushToRegistry && (
                    <div 
                      className="enhanced-selector-sync-menu-item"
                      onClick={() => handleSyncAction('push')}
                    >
                      ⬆ Push to Registry
                    </div>
                  )}
                  {onRetrieveLatest && (
                    <div 
                      className="enhanced-selector-sync-menu-item"
                      onClick={() => handleSyncAction('retrieve')}
                    >
                      🔄 Retrieve Latest
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && (groupedItems.length > 0 || isNewId || (!inputValue && registryItems.length > 0)) && validationMode !== 'none' && (
        <div ref={suggestionsRef} className="enhanced-selector-suggestions">
          {/* Create new button */}
          {isNewId && (
            <div 
              className="enhanced-selector-create"
              onClick={handleCreateNew}
            >
              <span>➕</span>
              <span>Create new {type}: "{inputValue}"</span>
            </div>
          )}

          {/* Grouped items */}
          {groupedItems.map(({ group, items }) => (
            <div key={group}>
              <div className="enhanced-selector-group">{group}</div>
              {items.map((item: any) => {
                const isUsed = usedIdsInGraph.has(item.id);
                const isItemConnected = usedIdsInGraph.has(item.id);
                
                return (
                  <div
                    key={item.id}
                    onClick={() => handleSelectItem(item)}
                    className={`enhanced-selector-item ${inputValue === item.id ? 'selected' : ''} ${isUsed ? 'used' : ''}`}
                  >
                    {/* Main line */}
                    <div className="enhanced-selector-item-main">
                      <span className="enhanced-selector-item-id">{item.id}</span>
                      
                      {item.isLocal && (
                        <span className="enhanced-selector-item-badge local">local</span>
                      )}
                      
                      {!item.file_path && !item.isLocal && (
                        <span className="enhanced-selector-item-badge planned">planned</span>
                      )}
                      
                      {isItemConnected && (
                        <span className="enhanced-selector-item-badge connected">✓</span>
                      )}
                    </div>

                    {/* Sub-line (usage info or description) */}
                    {(item.description || usageContext) && (
                      <div className="enhanced-selector-item-subline">
                        {item.description || usageContext}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Validation messages */}
      {showWarning && (
        <div className="enhanced-selector-message warning">
          ⚠️ Not in registry. Consider using a registered {type}.
        </div>
      )}
      
      {showError && (
        <div className="enhanced-selector-message error">
          ❌ Must use a registered {type} ID in strict mode.
        </div>
      )}
    </div>
  );
}

