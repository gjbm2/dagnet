import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Plug, Zap, X, ExternalLink, FilePlus, Maximize2 } from 'lucide-react';
import { ObjectType } from '../types';
import { useNavigatorContext } from '../contexts/NavigatorContext';
import { useValidationMode } from '../contexts/ValidationContext';
import { useTabContext } from '../contexts/TabContext';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { fileRegistry } from '../contexts/TabContext';
import { registryService, RegistryItem } from '../services/registryService';
import { getObjectTypeTheme } from '../theme/objectTypeTheme';
import { useSelectionContext } from './editors/GraphEditor';
import { ItemBase } from '../hooks/useItemFiltering';
import { LightningMenu } from './LightningMenu';
import { fileOperationsService } from '../services/fileOperationsService';
import './EnhancedSelector.css';

interface EnhancedSelectorProps {
  /** The type of item being selected */
  type: 'parameter' | 'context' | 'case' | 'node' | 'event';
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
  /** Callback when connected item is clicked */
  onOpenConnected?: () => void;
  /** Callback when open icon is clicked in dropdown (without selecting) */
  onOpenItem?: (itemId: string) => void;
  /** Callback after creating new item to populate data */
  onAfterCreate?: (newItem: any) => void;
  /** Callback when field is cleared (for undo/redo history) */
  onClear?: () => void;
  /** UUID of the graph node/edge instance being edited (for auto-get operations) */
  targetInstanceUuid?: string;
  /** For direct parameter references without param file */
  paramSlot?: 'p' | 'cost_gbp' | 'cost_time';
  conditionalIndex?: number;
  /** When true, only call onChange on blur/selection (not on each keystroke) */
  commitOnBlurOnly?: boolean;
  /** Callback to create and initialize a new file from current graph data (returns the created file ID) */
  onCreateAndInitialize?: (fileId: string) => Promise<void>;
}

/**
 * EnhancedSelector Component
 * 
 * Universal selector for all connection fields (nodes, parameters, cases, contexts).
 * Features:
 * - Distinctive pastel border (type-specific colour)
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
  onRetrieveLatest,
  onOpenConnected,
  onOpenItem,
  onAfterCreate,
  onClear,
  targetInstanceUuid,
  paramSlot,
  conditionalIndex,
  commitOnBlurOnly = false,
  onCreateAndInitialize
}: EnhancedSelectorProps) {
  console.log(`[${new Date().toISOString()}] [EnhancedSelector] RENDER (type=${type}, value=${value})`);
  const { operations: navOps } = useNavigatorContext();
  const { tabs, operations: tabOps } = useTabContext();
  const { mode: validationMode } = useValidationMode();
  const { graph, setGraph, setAutoUpdating, window } = useGraphStore();
  
  const [inputValue, setInputValue] = useState(value);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [registryItems, setRegistryItems] = useState<RegistryItem[]>([]);
  
  // Get context to open modal
  const selectionContext = useSelectionContext();
  
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const syncMenuRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // State for dropdown positioning
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [showShimmer, setShowShimmer] = useState(false);
  
  // Get theme colours and icon for this type
  const theme = getObjectTypeTheme(type as any);
  const IconComponent = theme.icon;

  // Sync inputValue with value prop
  const prevValueRef = useRef(value);
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES1: Sync inputValue with value prop`);
    if (prevValueRef.current !== value) {
      setInputValue(value);
      prevValueRef.current = value;
    }
  }, [value]);

  // Load registry items
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES2: Load registry items`);
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
    isLocal: item.isLocal,
    hasFile: item.hasFile  // Include hasFile for "planned" badge logic
  }));

  // Get current graph nodes (for showCurrentGraphGroup)
  const currentGraphItems = showCurrentGraphGroup && graph && type === 'node' ? 
    graph.nodes.map((n: any) => ({
      id: n.id || n.id,
      name: n.label || n.id || n.id,
      description: '',
      type: 'node',
      isLocal: true,
      hasFile: false  // Graph nodes don't have separate files
    })).filter(item => item.id) : [];

  // Get used IDs in graph (for dimming)
  const usedIdsInGraph = type === 'node' && graph ? 
    new Set(graph.nodes.map((n: any) => n.id).filter(Boolean)) : 
    new Set();

  // Filter items by input
  const filteredItems = allItems.filter((item: any) => {
    const query = inputValue.toLowerCase();
    return item.id.toLowerCase().includes(query) || 
           (item.name && item.name.toLowerCase().includes(query)) ||
           (item.description && item.description.toLowerCase().includes(query));
  });

  // Filter current graph items by input
  const filteredGraphItems = currentGraphItems.filter((item: any) => {
    const query = inputValue.toLowerCase();
    return item.id.toLowerCase().includes(query) || 
           (item.name && item.name.toLowerCase().includes(query));
  });

  // Group items
  const groupedItems: { group: string; items: any[] }[] = [];
  
  // Add current graph nodes first (if enabled)
  if (showCurrentGraphGroup && filteredGraphItems.length > 0) {
    groupedItems.push({ group: 'Current Graph', items: filteredGraphItems });
  }
  
  // Add registry items (excluding ones already in current graph)
  const currentGraphIds = new Set(currentGraphItems.map(item => item.id));
  const registryGroupItems = filteredItems.filter((item: any) => 
    !showCurrentGraphGroup || !currentGraphIds.has(item.id)
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
                  fileRegistry.getFile(`${type}-${inputValue}`) !== null;

  // Validation state
  const showWarning = validationMode === 'warning' && inputValue && !isConnected;
  const showError = validationMode === 'strict' && inputValue && !isConnected;

  // Check if input value is new (not in registry)
  const isNewId = inputValue && !allItems.some((item: any) => item.id === inputValue);

  // Auto-focus
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES3: Auto-focus`);
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

  // Calculate dropdown position (accounting for scroll offset)
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES4: Calculate dropdown position`);
    if (showSuggestions && inputRef.current) {
      const updatePosition = () => {
        const rect = inputRef.current!.getBoundingClientRect();
        const dropdownWidth = 320; // Approximate dropdown width
        const dropdownHeight = 300; // Approximate max dropdown height
        
        // Calculate initial position
        let top = rect.bottom + 4; // 4px gap below input
        let left = rect.left;
        
        // Ensure dropdown stays within viewport horizontally
        // Use globalThis to avoid shadowing the window prop from useGraphStore
        const viewportWidth = globalThis.innerWidth;
        if (left + dropdownWidth > viewportWidth - 20) {
          left = viewportWidth - dropdownWidth - 20; // 20px margin from right edge
        }
        if (left < 20) {
          left = 20; // 20px margin from left edge
        }
        
        // Ensure dropdown stays within viewport vertically
        const viewportHeight = globalThis.innerHeight;
        if (top + dropdownHeight > viewportHeight - 20) {
          // Show above input if there's not enough space below
          if (rect.top - dropdownHeight - 4 > 20) {
            top = rect.top - dropdownHeight - 4;
          } else {
            top = viewportHeight - dropdownHeight - 20;
          }
        }
        
        setDropdownPosition({ top, left });
      };
      
      updatePosition();
      
      // Update position on scroll
      const scrollContainer = inputRef.current.closest('.properties-panel, .dock-panel');
      scrollContainer?.addEventListener('scroll', updatePosition);
      globalThis.addEventListener('scroll', updatePosition, true); // Use capture to catch all scroll events
      
      return () => {
        scrollContainer?.removeEventListener('scroll', updatePosition);
        globalThis.removeEventListener('scroll', updatePosition, true);
      };
    }
  }, [showSuggestions]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    console.log(`[${new Date().toISOString()}] [EnhancedSelector] useEffect#ES5: Setup click outside listener`);
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
    
    // Immediate commit only when allowed (most fields), not when caller wants commit-on-blur semantics.
    // Validation mode controls messaging (warnings/errors) but should not block user edits.
    if (!commitOnBlurOnly) {
      onChange(newValue);
    }
  };

  const handleSelectItem = (item: any) => {
    setInputValue(item.id);
    onChange(item.id);
    setShowSuggestions(false);
    inputRef.current?.blur();
    
    // Trigger shimmer effect
    setShowShimmer(true);
    setTimeout(() => setShowShimmer(false), 600); // Match animation duration
    
    // If this is an existing item with data, call onAfterCreate to pull data
    if (item.data && onAfterCreate) {
      onAfterCreate(item.data);
    }
    
    // AUTO-GET: If connecting to an item with a file, automatically pull data from file
    // This provides immediate feedback and populates the graph with file data on first connect
    if (item.hasFile && graph && targetInstanceUuid && (type === 'parameter' || type === 'case' || type === 'node')) {
      console.log(`[EnhancedSelector] Auto-get from file: type=${type}, id=${item.id}, targetInstanceUuid=${targetInstanceUuid}`);
      
      // Trigger the get operation asynchronously (don't block the selection)
      setTimeout(async () => {
        try {
          const { dataOperationsService } = await import('../services/dataOperationsService');
          
          if (type === 'parameter') {
            await dataOperationsService.getParameterFromFile({
              paramId: item.id,           // Semantic ID → finds parameter-{id}.yaml
              edgeId: targetInstanceUuid, // UUID → finds which edge instance to update
              graph: graph as any,
              setGraph: setGraph as any,
              setAutoUpdating: setAutoUpdating
            });
          } else if (type === 'case') {
            await dataOperationsService.getCaseFromFile({
              caseId: item.id,            // Semantic ID → finds case-{id}.yaml
              nodeId: targetInstanceUuid, // UUID → finds which node instance to update
              graph: graph as any,
              setGraph: setGraph as any,
              setAutoUpdating: setAutoUpdating
            });
          } else if (type === 'node') {
            await dataOperationsService.getNodeFromFile({
              nodeId: item.id,                 // Semantic ID → finds node-{id}.yaml
              targetNodeUuid: targetInstanceUuid, // UUID → finds which node instance to update
              graph: graph as any,
              setGraph: setGraph as any,
              setAutoUpdating: setAutoUpdating
            });
          }
        } catch (error) {
          console.error('[EnhancedSelector] Auto-get failed:', error);
          // Don't show toast - user didn't explicitly request this, so silent failure is OK
        }
      }, 100); // Small delay to allow UI to update first
    }
  };

  const handleClear = () => {
    // Cancel any pending blur commit/hide
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }

    // Clear the input and show suggestions so user can immediately pick a new value
    setInputValue('');
    setShowSuggestions(true);

    // For commit-on-blur fields, don't treat clear as an immediate commit;
    // wait for blur/Enter to propagate the change.
    if (!commitOnBlurOnly) {
      onChange('');
    }
    inputRef.current?.focus();
    
    // Call onClear callback for undo/redo history
    if (onClear) {
      onClear();
    }
  };

  const handleInputFocus = () => {
    // Always show suggestions on focus if not in 'none' validation mode
    if (validationMode !== 'none') {
      setShowSuggestions(true);
    }
  };

  const handleInputBlur = () => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }

    blurTimeoutRef.current = globalThis.setTimeout(() => {
      blurTimeoutRef.current = null;
      setShowSuggestions(false);
      
      // Always commit the final value on blur when it differs from the prop value.
      // Validation mode can show warnings/errors but must not block or revert edits.
      if (inputValue !== value) {
        // This covers both commit-on-blur fields (e.g. node IDs) and
        // normal fields (e.g. event IDs), without requiring Enter.
        onChange(inputValue);
      }
    }, 200);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (commitOnBlurOnly && e.key === 'Enter') {
      e.preventDefault();
      if (inputValue !== value) {
        onChange(inputValue);
      }
      inputRef.current?.blur();
    }
  };

  const handleCreateNew = async () => {
    // Use fileOperationsService instead of direct FileRegistry calls
    // This ensures proper parameter type handling
    const metadata = type === 'parameter' && parameterType 
      ? { parameterType }  // Pass through parameterType from props
      : {};
    
    await fileOperationsService.createFile(inputValue, type, {
      openInTab: true,
      viewMode: 'interactive',
      metadata
    });

    // Update the selector value
    setInputValue(inputValue);
    onChange(inputValue);
    setShowSuggestions(false);
    
    // If onCreateAndInitialize is provided, call it to populate the file from graph data
    // This is used when creating a parameter file from within an edge editor
    if (onCreateAndInitialize) {
      try {
        await onCreateAndInitialize(inputValue);
      } catch (error) {
        console.error('[EnhancedSelector] Failed to initialize new file from graph data:', error);
      }
    }
    
    // Call onAfterCreate if provided (though data is now in FileRegistry)
    if (onAfterCreate) {
      const file = fileRegistry.getFile(`${type}-${inputValue}`);
      if (file) {
        onAfterCreate(file.data);
      }
    }
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

  // Determine visual treatment for the input field based on current value
  const fileId = value ? `${type}-${value}` : '';
  const fileState = fileId ? fileRegistry.getFile(fileId) : null;
  const hasOpenTabs = fileId ? tabs.some((tab: any) => tab.fileId === fileId) : false;
  const isDirty = fileState?.isDirty || false;
  const currentItem = allItems.find((item: any) => item.id === value);
  const isLocalFile = currentItem?.isLocal || false;
  const inRegistryOnly = currentItem && !currentItem.file_path && !isLocalFile;
  
  // Determine input text colour and style based on state priority
  let inputTextColour = 'inherit';
  let inputFontStyle = 'normal';
  
  if (isDirty) {
    inputTextColour = '#ea580c'; // Orange for dirty
  } else if (hasOpenTabs) {
    inputTextColour = '#0066cc'; // Blue for open
  } else if (inRegistryOnly) {
    inputTextColour = '#6B7280'; // Grey for registry-only
  }
  
  if (isLocalFile) {
    inputFontStyle = 'italic';
  }

  return (
    <div 
      className="enhanced-selector" 
      ref={wrapperRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        '--selector-accent-colour': theme.accentColour,
        '--selector-light-colour': theme.lightColour
      } as React.CSSProperties}
    >
      {/* Label */}
      <label className="enhanced-selector-label" htmlFor={`selector-${type}`}>
        <IconComponent 
          size={14} 
          strokeWidth={2}
          style={{ color: theme.accentColour, marginRight: '4px' }}
        />
        {displayLabel}:
      </label>

      {/* Input wrapper with pastel border */}
      <div 
        className={`enhanced-selector-input-wrapper type-${type} ${isConnected ? 'connected' : ''} ${showShimmer ? 'shimmer' : ''}`}
      >
        <div className={`enhanced-selector-inner ${showError ? 'error' : ''} ${showWarning ? 'warning' : ''}`}>
          {/* Plug icon - clickable when connected */}
          <button
            type="button"
            className={`enhanced-selector-plug ${isConnected ? 'connected' : ''}`}
            onClick={(e) => {
              // Prevent the click from bubbling up to rc-dock/tab chrome
              // so it doesn't immediately re-activate the current graph tab.
              e.stopPropagation();
              e.preventDefault();
              if (isConnected && onOpenConnected) {
                onOpenConnected();
              }
            }}
            disabled={!isConnected || !onOpenConnected}
            title={isConnected ? "Open connected item" : "Not connected"}
            style={{
              background: 'none',
              border: 'none',
              padding: '0 8px',
              cursor: isConnected && onOpenConnected ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center'
            }}
          >
            <Plug 
              size={16} 
              strokeWidth={2}
              style={{ 
                color: isConnected ? '#1F2937' : '#D1D5DB',
                transition: 'color 0.2s'
              }}
            />
          </button>

          {/* Text input */}
          <input
            ref={inputRef}
            id={`selector-${type}`}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            placeholder={placeholder || `Select or enter ${type} ID...`}
            disabled={disabled}
            className="enhanced-selector-input"
            style={{
              color: inputTextColour,
              fontStyle: inputFontStyle
            }}
          />

          {/* Clear button - only visible on hover */}
          {inputValue && !disabled && isHovered && (
            <button
              type="button"
              onClick={handleClear}
              className="enhanced-selector-clear"
              title="Clear selection"
              style={{
                background: 'none',
                border: 'none',
                padding: '0 4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                color: '#9CA3AF',
                transition: 'color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = '#6B7280'}
              onMouseLeave={(e) => e.currentTarget.style.color = '#9CA3AF'}
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}

          {/* Lightning Menu - data operations */}
          {(() => {
            // Show LightningMenu for parameter, case, node, and event (events only show file operations, no external connections)
            const shouldShow = !disabled && (type === 'parameter' || type === 'case' || type === 'node' || type === 'event') && graph && targetInstanceUuid;
            // Check if file actually EXISTS in fileRegistry (not just if file_path is set)
            // Note: fileRegistry.getFile expects format "parameter-{id}" not "parameter-{id}.yaml"
            const fileId = `${type}-${inputValue}`;
            const fileObj = inputValue ? fileRegistry.getFile(fileId) : null;
            const computedHasFile = fileObj !== null && fileObj !== undefined;
            console.log('[EnhancedSelector] Lightning Menu conditions:', {
              disabled,
              inputValue,
              type,
              fileId,
              fileObj: fileObj ? 'EXISTS' : 'NULL',
              hasGraph: !!graph,
              hasTargetId: !!targetInstanceUuid,
              shouldShow,
              hasFile: computedHasFile,
              currentItemHasFile: !!currentItem?.hasFile
            });
            return shouldShow ? (
            <LightningMenu
              objectType={type}
                objectId={inputValue || ''}
              hasFile={computedHasFile}
              targetId={targetInstanceUuid}
              graph={graph}
              setGraph={setGraph}
                paramSlot={paramSlot}
                conditionalIndex={conditionalIndex}
              window={window}
            />
            ) : null;
          })()}
        </div>
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && (groupedItems.length > 0 || isNewId || (!inputValue && registryItems.length > 0)) && validationMode !== 'none' && (
        <div 
          ref={suggestionsRef} 
          className="enhanced-selector-suggestions"
          style={{
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`
          }}
        >
          {/* Floating buttons - Expand and Close */}
          <div style={{
            position: 'sticky',
            top: '4px',
            right: '4px',
            zIndex: 10,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: '2px',
            padding: '0 4px',
            pointerEvents: 'none'
          }}>
            <button
              type="button"
              onClick={() => {
                setShowSuggestions(false);
                // Open modal at GraphEditor level
                selectionContext.openSelectorModal({
                  type,
                  items: [...currentGraphItems, ...allItems].map(item => ({
                    ...item,
                    hasFile: !!('file_path' in item ? item.file_path : false) || item.isLocal,
                    isOpen: tabs.some((tab: any) => tab.fileId === `${type}-${item.id}`),
                    isDirty: fileRegistry.getFile(`${type}-${item.id}`)?.isDirty || false
                  } as ItemBase)),
                  currentValue: inputValue,
                  onSelect: (selectedId) => {
                    setInputValue(selectedId);
                    onChange(selectedId);
                  },
                  onOpenItem
                });
              }}
              className="enhanced-selector-expand-btn"
              title="Open advanced selector (full view)"
              style={{
                background: 'white',
                border: '1px solid #e9ecef',
                padding: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#6B7280',
                borderRadius: '4px',
                transition: 'all 0.15s',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
                pointerEvents: 'auto'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#f3f4f6';
                e.currentTarget.style.color = '#374151';
                e.currentTarget.style.borderColor = '#d1d5db';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'white';
                e.currentTarget.style.color = '#6B7280';
                e.currentTarget.style.borderColor = '#e9ecef';
              }}
            >
              <Maximize2 size={14} strokeWidth={2} />
            </button>
            
            <button
              type="button"
              onClick={() => setShowSuggestions(false)}
              className="enhanced-selector-dropdown-close"
              title="Close dropdown"
              style={{
                background: 'white',
                border: '1px solid #e9ecef',
                padding: '4px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                color: '#9CA3AF',
                borderRadius: '4px',
                transition: 'all 0.15s',
                boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
                pointerEvents: 'auto'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#6B7280';
                e.currentTarget.style.background = '#f3f4f6';
                e.currentTarget.style.borderColor = '#d1d5db';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#9CA3AF';
                e.currentTarget.style.background = 'white';
                e.currentTarget.style.borderColor = '#e9ecef';
              }}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>

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
              <div className="enhanced-selector-group">
                <IconComponent 
                  size={12} 
                  strokeWidth={2}
                  style={{ color: theme.accentColour, marginRight: '6px' }}
                />
                {group}
              </div>
              {items.map((item: any) => {
                const isUsed = usedIdsInGraph.has(item.id);
                const isItemConnected = usedIdsInGraph.has(item.id);
                
                // Check file state for visual treatment
                const fileId = `${type}-${item.id}`;
                const fileState = fileRegistry.getFile(fileId);
                const hasOpenTabs = tabs.some((tab: any) => tab.fileId === fileId);
                const isDirty = fileState?.isDirty || false;
                const isLocal = item.isLocal || false;
                const inRegistryOnly = !item.file_path && !isLocal;
                
                // Determine text colour based on state priority: dirty > open > registry-only
                let textColour = 'inherit';
                let fontStyle = 'normal';
                let opacity = 1;
                
                if (isDirty) {
                  textColour = '#ea580c'; // Orange for dirty
                } else if (hasOpenTabs) {
                  textColour = '#0066cc'; // Blue for open
                } else if (inRegistryOnly) {
                  opacity = 0.7; // Grey for registry-only
                }
                
                if (isLocal) {
                  fontStyle = 'italic';
                }
                
                return (
                  <div
                    key={item.id}
                    className={`enhanced-selector-item ${inputValue === item.id ? 'selected' : ''} ${isUsed ? 'used' : ''}`}
                  >
                    <div
                      onClick={() => handleSelectItem(item)}
                      style={{ flex: 1, cursor: 'pointer' }}
                    >
                      {/* Main line */}
                      <div className="enhanced-selector-item-main">
                        <IconComponent 
                          size={12} 
                          strokeWidth={2}
                          style={{ color: theme.accentColour, marginRight: '6px', opacity: 0.5 }}
                        />
                        <span 
                          className="enhanced-selector-item-id"
                          style={{ 
                            color: textColour, 
                            fontStyle,
                            opacity
                          }}
                        >{item.id}</span>
                        
                        {item.isLocal && (
                          <span className="enhanced-selector-item-badge local">local</span>
                        )}
                        
                        {!item.hasFile && (
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

                    {/* Open/Create button */}
                    {onOpenItem && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenItem(item.id);
                        }}
                        className="enhanced-selector-item-action-btn"
                        title={item.file_path || item.isLocal ? `Open ${type}` : `Create ${type}`}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: '4px 8px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          color: item.file_path || item.isLocal ? '#9CA3AF' : '#10B981',
                          transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.color = item.file_path || item.isLocal ? '#1F2937' : '#059669';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.color = item.file_path || item.isLocal ? '#9CA3AF' : '#10B981';
                        }}
                      >
                        {item.file_path || item.isLocal ? (
                          <ExternalLink size={14} strokeWidth={2} />
                        ) : (
                          <FilePlus size={14} strokeWidth={2} />
                        )}
                      </button>
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
          ⚠️ Not in registry. Use an existing {type}.
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

