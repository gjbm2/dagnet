# Phase 1B: Lightning Menu (Data Operations Dropdown)

**Date:** 2025-11-05 (Updated with centralized architecture)  
**Phase:** Phase 1B  
**Estimated Time:** 2.5 hours  
**Status:** Ready to implement

**Architecture:** ⭐ **Centralized DataOperationsService** - All UI components delegate to single service layer

---

## Overview

Add a **Lightning Menu** dropdown to the EnhancedSelector in Properties Panel, providing quick access to data sync operations.

**Location:** Properties Panel → next to any EnhancedSelector for parameters/cases/nodes

**Visual:** Lightning bolt button with dropdown menu showing data operations

---

## Architecture: Centralized Data Operations

**CRITICAL:** All data operations (Get/Put) must go through a **single centralized service** to avoid code duplication:

```
UI Components (Lightning Menu, Context Menus, Data Menu)
         ↓
    DataOperationsService (thin orchestration layer)
         ↓
    UpdateManager (handles all actual data movement)
```

**Benefits:**
- ✅ No duplicated logic across UI components
- ✅ Consistent behavior everywhere
- ✅ Single place to add logging, error handling, analytics
- ✅ Easy to test
- ✅ UI components stay thin and focused on presentation

---

## Centralized Service Layer

### DataOperationsService (NEW)

**Path:** `graph-editor/src/services/dataOperationsService.ts`

```typescript
/**
 * Centralized service for all data sync operations
 * Used by: Lightning Menu, Context Menus, Data Menu
 * 
 * This is a thin orchestration layer that:
 * - Validates input
 * - Shows appropriate toasts
 * - Calls UpdateManager for actual work
 * - Handles UI updates (dirty state, etc.)
 */

import { UpdateManager } from './UpdateManager';
import { toast } from 'react-hot-toast';
import { fileRegistry } from '../contexts/TabContext';

class DataOperationsService {
  private updateManager: UpdateManager;
  
  constructor() {
    this.updateManager = new UpdateManager();
  }
  
  /**
   * Get data from parameter file → graph edge
   */
  async getParameterFromFile(options: {
    paramId: string;
    edgeId?: string; // If updating specific edge
  }): Promise<void> {
    const { paramId, edgeId } = options;
    
    try {
      // Load parameter file
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (!paramFile) {
        toast.error(`File not found: ${paramId}`);
        return;
      }
      
      // Call UpdateManager to sync file → graph
      await this.updateManager.handleFileToGraph({
        sourceFile: paramFile,
        targetEdgeId: edgeId,
        interactive: true
      });
      
      toast.success(`Updated from ${paramId}.yaml`);
    } catch (error) {
      console.error('Failed to get from file:', error);
      toast.error('Failed to get from file');
    }
  }
  
  /**
   * Put data from graph edge → parameter file
   */
  async putParameterToFile(options: {
    paramId: string;
    edgeId?: string; // If saving from specific edge
  }): Promise<void> {
    const { paramId, edgeId } = options;
    
    try {
      // Call UpdateManager to sync graph → file
      await this.updateManager.handleGraphToFile({
        sourceEdgeId: edgeId,
        targetFileId: `parameter-${paramId}`,
        operation: 'APPEND', // Append to values[] array
        interactive: true
      });
      
      // Mark file as dirty
      const paramFile = fileRegistry.getFile(`parameter-${paramId}`);
      if (paramFile) {
        fileRegistry.markDirty(`parameter-${paramId}`);
      }
      
      toast.success(`Updated ${paramId}.yaml (unsaved)`);
    } catch (error) {
      console.error('Failed to put to file:', error);
      toast.error('Failed to put to file');
    }
  }
  
  /**
   * Get data from external source → file → graph (versioned)
   * STUB for Phase 1
   */
  async getFromSource(options: {
    paramId: string;
    edgeId?: string;
  }): Promise<void> {
    toast.info('Get from Source coming soon!');
    // TODO Phase 2: Implement external source retrieval
  }
  
  /**
   * Get data from external source → graph (direct, not versioned)
   * STUB for Phase 1
   */
  async getFromSourceDirect(options: {
    paramId: string;
    edgeId?: string;
  }): Promise<void> {
    toast.info('Get from Source (direct) coming soon!');
    // TODO Phase 2: Implement external source retrieval
  }
  
  /**
   * Open connection settings modal
   * STUB for Phase 1
   */
  async openConnectionSettings(paramId: string): Promise<void> {
    toast.info('Connection Settings coming soon!');
    // TODO Phase 2: Build connection settings modal
  }
  
  /**
   * Open sync status modal
   * STUB for Phase 1
   */
  async openSyncStatus(paramId: string): Promise<void> {
    toast.info('Sync Status coming soon!');
    // TODO Phase 2: Build sync status modal
  }
}

// Singleton instance
export const dataOperationsService = new DataOperationsService();
```

**Key Points:**
- ✅ Single instance shared across all UI components
- ✅ All toast notifications in one place
- ✅ All UpdateManager calls in one place
- ✅ Easy to add logging, analytics, error tracking
- ✅ Phase 1: Stub external source operations
- ✅ Phase 2: Implement actual connectors

---

## Component Structure

### 1. New Component: `LightningMenu.tsx`

**Path:** `graph-editor/src/components/LightningMenu.tsx`

```typescript
interface LightningMenuProps {
  /** Current parameter/case/node ID (if connected) */
  connectedId: string | null;
  
  /** Type of object being managed */
  objectType: 'parameter' | 'case' | 'node';
  
  /** Whether external data source is configured */
  hasDataSource: boolean;
  
  /** Callback when "Get from File" is clicked */
  onGetFromFile: () => void;
  
  /** Callback when "Put to File" is clicked */
  onPutToFile: () => void;
  
  /** Callback when "Get from Source" is clicked */
  onGetFromSource: () => void;
  
  /** Callback when "Get from Source (direct)" is clicked */
  onGetFromSourceDirect: () => void;
  
  /** Callback when "Connection Settings" is clicked */
  onConnectionSettings: () => void;
  
  /** Callback when "Sync Status" is clicked */
  onSyncStatus: () => void;
}
```

### 2. Visual States

**Lightning Button Icon:**
- `<Zap fill="currentColour">` (filled) - Data source configured
- `<Zap fill="none">` (stroke) - No data source / manual only

**Button States:**
- Enabled: Lightning bolt in accent colour
- Disabled: Greyed out (when no connected file)

---

## Menu Structure

```
┌─────────────────────────────────────────────────────────┐
│ Get from File                                           │  // if connectedId exists
│   🗂️ → 📊                                                │  // pathway icons
│                                                         │
│ Get from Source                                         │  // if hasDataSource
│   ⚡🗄️ → 🗂️ → 📊                                          │  // (stub Phase 1)
│                                                         │
│ Get from Source (direct)                                │  // if hasDataSource  
│   ⚡🗄️ → 📊                                               │  // (stub Phase 1)
│                                                         │
│ Put to File                                             │  // if connectedId exists
│   📊 → 🗂️                                                │  // pathway icons
│ ─────────────────────────────────────────────────────  │
│ Connection Settings...                                  │  // if connectedId (stub)
│ Sync Status...                                          │  // (stub Phase 1)
└─────────────────────────────────────────────────────────┘
```

**Icon Mapping:**
- `📊` = `<TrendingUpDown>` - Graph
- `🗂️` = `<Folders>` - Files  
- `⚡🗄️` = `<DatabaseZap>` - External Source

---

## Implementation Steps

### Step 1: Create LightningMenu Component (30 min)

**File:** `graph-editor/src/components/LightningMenu.tsx`

```typescript
import React, { useState, useRef, useEffect } from 'react';
import { Zap, Folders, TrendingUpDown, DatabaseZap } from 'lucide-react';
import './LightningMenu.css';

export function LightningMenu({
  connectedId,
  objectType,
  hasDataSource,
  onGetFromFile,
  onPutToFile,
  onGetFromSource,
  onGetFromSourceDirect,
  onConnectionSettings,
  onSyncStatus
}: LightningMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const hasConnection = !!connectedId;

  return (
    <div className="lightning-menu-wrapper" ref={menuRef}>
      <button
        className={`lightning-button ${hasDataSource ? 'has-source' : 'no-source'}`}
        onClick={() => setIsOpen(!isOpen)}
        disabled={!hasConnection}
        title={hasConnection ? 'Data operations' : 'Connect to a file first'}
      >
        <Zap 
          size={16} 
          fill={hasDataSource ? 'currentColour' : 'none'}
        />
      </button>

      {isOpen && hasConnection && (
        <div className="lightning-menu-dropdown">
          {/* Get from File */}
          <button
            className="lightning-menu-item"
            onClick={() => {
              onGetFromFile();
              setIsOpen(false);
            }}
          >
            <div className="menu-item-label">Get from File</div>
            <div className="menu-item-pathway">
              <Folders size={14} />
              <span>→</span>
              <TrendingUpDown size={14} />
            </div>
          </button>

          {/* Get from Source (versioned) - STUB */}
          {hasDataSource && (
            <button
              className="lightning-menu-item"
              onClick={() => {
                onGetFromSource();
                setIsOpen(false);
              }}
            >
              <div className="menu-item-label">Get from Source</div>
              <div className="menu-item-pathway">
                <DatabaseZap size={14} />
                <span>→</span>
                <Folders size={14} />
                <span>→</span>
                <TrendingUpDown size={14} />
              </div>
            </button>
          )}

          {/* Get from Source (direct) - STUB */}
          {hasDataSource && (
            <button
              className="lightning-menu-item"
              onClick={() => {
                onGetFromSourceDirect();
                setIsOpen(false);
              }}
            >
              <div className="menu-item-label">Get from Source (direct)</div>
              <div className="menu-item-pathway">
                <DatabaseZap size={14} />
                <span>→</span>
                <TrendingUpDown size={14} />
              </div>
            </button>
          )}

          {/* Put to File */}
          <button
            className="lightning-menu-item"
            onClick={() => {
              onPutToFile();
              setIsOpen(false);
            }}
          >
            <div className="menu-item-label">Put to File</div>
            <div className="menu-item-pathway">
              <TrendingUpDown size={14} />
              <span>→</span>
              <Folders size={14} />
            </div>
          </button>

          <div className="menu-separator" />

          {/* Connection Settings - STUB */}
          <button
            className="lightning-menu-item"
            onClick={() => {
              onConnectionSettings();
              setIsOpen(false);
            }}
          >
            <div className="menu-item-label">Connection Settings...</div>
          </button>

          {/* Sync Status - STUB */}
          <button
            className="lightning-menu-item"
            onClick={() => {
              onSyncStatus();
              setIsOpen(false);
            }}
          >
            <div className="menu-item-label">Sync Status...</div>
          </button>
        </div>
      )}
    </div>
  );
}
```

---

### Step 2: Create CSS (15 min)

**File:** `graph-editor/src/components/LightningMenu.css`

```css
.lightning-menu-wrapper {
  position: relative;
  display: inline-block;
  margin-left: 8px;
}

.lightning-button {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 4px;
  background: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.lightning-button:hover:not(:disabled) {
  background: var(--hover-bg, #f3f4f6);
  border-color: var(--hover-border, #d1d5db);
}

.lightning-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.lightning-button.has-source {
  color: #eab308; /* yellow-500 for live source */
}

.lightning-button.no-source {
  color: #6b7280; /* gray-500 for manual */
}

.lightning-menu-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 280px;
  background: white;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  z-index: 1000;
  padding: 4px;
}

.lightning-menu-item {
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
  font-size: 14px;
}

.lightning-menu-item:hover {
  background: var(--hover-bg, #f3f4f6);
}

.menu-item-label {
  margin-bottom: 4px;
  font-weight: 500;
}

.menu-item-pathway {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary, #6b7280);
  font-size: 12px;
}

.menu-item-pathway svg {
  flex-shrink: 0;
}

.menu-separator {
  height: 1px;
  background: var(--border-color, #e5e7eb);
  margin: 4px 0;
}
```

---

### Step 3: Integrate into EnhancedSelector (30 min)

**File:** `graph-editor/src/components/EnhancedSelector.tsx`

Add LightningMenu next to the selector input:

```typescript
import { LightningMenu } from './LightningMenu';

// Inside EnhancedSelector component, after the input field:

<div className="selector-actions">
  {value && (
    <>
      {/* Existing "Open Connected" button */}
      {onOpenConnected && (
        <button onClick={onOpenConnected} title="Open connected file">
          <ExternalLink size={14} />
        </button>
      )}
      
      {/* NEW: Lightning Menu */}
      <LightningMenu
        connectedId={value}
        objectType={type as 'parameter' | 'case' | 'node'}
        hasDataSource={false} // TODO: Determine from data
        onGetFromFile={() => handleGetFromFile()}
        onPutToFile={() => handlePutToFile()}
        onGetFromSource={() => showComingSoonToast('Get from Source')}
        onGetFromSourceDirect={() => showComingSoonToast('Get from Source (direct)')}
        onConnectionSettings={() => showComingSoonToast('Connection Settings')}
        onSyncStatus={() => showComingSoonToast('Sync Status')}
      />
    </>
  )}
</div>
```

**Add handler methods (THIN - delegate to service):**

```typescript
import { dataOperationsService } from '../services/dataOperationsService';

// All handlers just delegate to centralized service
const handleGetFromFile = () => {
  if (!value) return;
  dataOperationsService.getParameterFromFile({ 
    paramId: value,
    edgeId: currentEdgeId // Pass context if available
  });
};

const handlePutToFile = () => {
  if (!value) return;
  dataOperationsService.putParameterToFile({ 
    paramId: value,
    edgeId: currentEdgeId
  });
};

const handleGetFromSource = () => {
  if (!value) return;
  dataOperationsService.getFromSource({ 
    paramId: value,
    edgeId: currentEdgeId
  });
};

const handleGetFromSourceDirect = () => {
  if (!value) return;
  dataOperationsService.getFromSourceDirect({ 
    paramId: value,
    edgeId: currentEdgeId
  });
};

const handleConnectionSettings = () => {
  if (!value) return;
  dataOperationsService.openConnectionSettings(value);
};

const handleSyncStatus = () => {
  if (!value) return;
  dataOperationsService.openSyncStatus(value);
};
```

**KEY PRINCIPLE:** UI components are **THIN**. They only:
1. Validate basic preconditions (e.g., `value` exists)
2. Pass context to the service
3. Let the service handle everything else (logic, toasts, errors)

This same pattern will be used in:
- Context Menus (right-click)
- Data Menu (top menu)
- Any other UI that needs data operations

---

### Step 4: Add Toast Notifications (15 min)

Install `react-hot-toast` if not already present:

```bash
npm install react-hot-toast
```

Add toast container to main app:

```typescript
// In App.tsx or main component
import { Toaster } from 'react-hot-toast';

<Toaster position="top-right" />
```

---

### Step 5: Testing (30 min)

**Manual Test Cases:**

1. **No connection:**
   - Lightning button should be disabled/greyed
   
2. **Connected to parameter (no data source):**
   - Lightning button shows stroke Zap (grey)
   - Menu shows: Get from File, Put to File, Connection Settings, Sync Status
   - "Get from Source" options hidden
   
3. **Connected with data source:**
   - Lightning button shows filled Zap (yellow)
   - Menu shows all 6 options
   - "Get from Source" options visible
   
4. **Click Get from File:**
   - Shows toast "Updated from {param_id} (coming soon)"
   
5. **Click Put to File:**
   - Shows toast "Updated {param_id}.yaml (unsaved)"
   
6. **Click stubbed options:**
   - Shows "Feature coming soon!" toast
   
7. **Click outside menu:**
   - Menu closes

---

## Phase 1 vs Future Phases

**Phase 1 (This PR):**
- ✅ Lightning button UI
- ✅ Dropdown menu with all options
- ✅ Pathway visualizations
- ✅ Toast notifications
- ⏸️ **STUB:** "Get from Source" operations (show toast)
- ⏸️ **STUB:** "Connection Settings" modal (show toast)
- ⏸️ **STUB:** "Sync Status" modal (show toast)
- ⏸️ **STUB:** "Get from File" / "Put to File" (show toast, don't actually sync)

**Phase 2:**
- Implement actual UpdateManager integration
- Build Connection Settings modal
- Build Sync Status modal
- Implement external source connectors

---

## Files to Create/Modify

### New Files:
- `graph-editor/src/services/dataOperationsService.ts` ⭐ **CENTRALIZED SERVICE**
- `graph-editor/src/components/LightningMenu.tsx` (UI component)
- `graph-editor/src/components/LightningMenu.css` (styles)

### Modified Files:
- `graph-editor/src/components/EnhancedSelector.tsx` (add LightningMenu, delegate to service)
- `graph-editor/src/components/EnhancedSelector.css` (selector-actions styling)
- `graph-editor/src/App.tsx` or main component (add Toaster)

---

## Estimated Time Breakdown

| Task | Time |
|------|------|
| Create DataOperationsService (centralized) | 45 min |
| Create LightningMenu component | 30 min |
| Create CSS styling | 15 min |
| Integrate into EnhancedSelector | 20 min |
| Add toast notifications | 10 min |
| Testing & polish | 30 min |
| **Total** | **2.5 hours** |

---

## Success Criteria

- ✅ Lightning button appears next to all EnhancedSelectors in Properties Panel
- ✅ Button shows correct icon state (filled/stroke) based on data source
- ✅ Button is disabled when no connection exists
- ✅ Dropdown menu shows correct options based on context
- ✅ Pathway visualizations display correctly with proper icons
- ✅ All operations show appropriate toast messages
- ✅ Menu closes on click outside
- ✅ No console errors
- ✅ Consistent styling with rest of Properties Panel

---

**Ready to implement!** 🚀

