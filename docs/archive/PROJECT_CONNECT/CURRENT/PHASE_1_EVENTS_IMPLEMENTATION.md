# Phase 1: Events Implementation

**Date:** 2025-11-05  
**Purpose:** Add Events throughout the app following the Cases pattern  
**Color:** Yellow (`#FEF3C7` light, `#EAB308` accent)

---

## Overview

Implement Events across the entire app, following the same pattern as Cases:
- Navigator section
- EnhancedSelector support
- Tab support
- Form editor
- Registry service integration

---

## Implementation Checklist

### 1. Type Definitions

**File:** `graph-editor/src/types/index.ts`

```typescript
export type ObjectType = 
  | 'graph' 
  | 'parameter' 
  | 'context' 
  | 'case'
  | 'node'
  | 'event'        // ADD THIS
  | 'credentials'
  | 'settings'
  | 'about'
  | 'markdown';
```

---

### 2. Theme Configuration

**File:** `graph-editor/src/theme/objectTypeTheme.ts`

```typescript
import { 
  // ... existing imports
  Calendar  // ADD for Events icon
} from 'lucide-react';

export type ObjectType = 
  'graph' | 'node' | 'case' | 'context' | 'parameter' | 
  'event' |  // ADD THIS
  'edge' | 'special' | 'credentials' | 'settings' | 'about' | 'markdown';

export const objectTypeTheme: Record<ObjectType, ObjectTypeTheme> = {
  // ... existing types
  event: {
    lightColor: '#FEF3C7',  // light yellow
    accentColor: '#EAB308', // yellow-500
    icon: Calendar,
    label: 'Event',
    emoji: '📅'
  },
  // ... rest
};
```

**Note:** Using `Calendar` icon for events. Alternative options: `Zap`, `Activity`, `Bell`

---

### 3. Navigator Integration

**File:** `graph-editor/src/components/Navigator/NavigatorContent.tsx`

#### A. Update Registry State
```typescript
const [registryItems, setRegistryItems] = useState<{
  parameters: RegistryItem[];
  contexts: RegistryItem[];
  cases: RegistryItem[];
  nodes: RegistryItem[];
  events: RegistryItem[];  // ADD THIS
}>({
  parameters: [],
  contexts: [],
  cases: [],
  nodes: [],
  events: []  // ADD THIS
});
```

#### B. Load Events from Registry
```typescript
const loadAllItems = async () => {
  try {
    console.log('📦 NavigatorContent: Loading registry items...');
    const [parameters, contexts, cases, nodes, events] = await Promise.all([
      registryService.getParameters(tabs),
      registryService.getContexts(tabs),
      registryService.getCases(tabs),
      registryService.getNodes(tabs),
      registryService.getEvents(tabs)  // ADD THIS
    ]);
    
    console.log(`📦 NavigatorContent: Loaded ${parameters.length} parameters, ${contexts.length} contexts, ${cases.length} cases, ${nodes.length} nodes, ${events.length} events`);
    setRegistryItems({ parameters, contexts, cases, nodes, events });
  } catch (error) {
    console.error('Failed to load registry items:', error);
  }
};
```

#### C. Add to Entry Builder
```typescript
// In buildEntries function, add events alongside cases:
// Process Events
registryItems.events.forEach(event => {
  const fileId = `event-${event.id}`;
  const hasFile = !!fileRegistry.getFile(fileId) || tabs.some(t => t.fileId === fileId);
  const isDirty = fileRegistry.getFile(fileId)?.isDirty || false;
  const isOpen = tabs.some(t => t.fileId === fileId);

  entries.push({
    id: event.id,
    name: event.name || event.id,
    type: 'event',
    hasFile,
    isLocal: false,
    inIndex: true,
    isDirty,
    isOpen,
    isOrphan: false
  });
});
```

#### D. Add to Grouped Entries
```typescript
const groupedEntries = useMemo(() => {
  const groups: Record<ObjectType, NavigatorEntry[]> = {
    graph: [],
    parameter: [],
    context: [],
    case: [],
    node: [],
    event: [],  // ADD THIS
    credentials: [],
    settings: [],
    about: [],
    markdown: []
  };
  // ... rest
}, [filteredAndSortedEntries]);
```

#### E. Add Section to Render
```typescript
// In return statement, add Events section:
{groupedEntries.event.length > 0 && (
  <ObjectTypeSection
    title="Events"
    icon={getObjectTypeTheme('event').icon}
    entries={groupedEntries.event}
    onItemClick={handleItemClick}
    onItemContextMenu={handleItemContextMenu}
    onSectionContextMenu={handleSectionContextMenu}
  />
)}
```

---

### 4. Registry Service

**File:** `graph-editor/src/services/registryService.ts`

```typescript
interface RegistryIndexes {
  parameters?: any;
  contexts?: any;
  cases?: any;
  nodes?: any;
  events?: any;  // ADD THIS
}

class RegistryService {
  // ADD getEvents method (following getCases pattern)
  async getEvents(tabs: any[]): Promise<RegistryItem[]> {
    try {
      const indexFile = this.indexes.events;
      if (!indexFile) {
        console.log('📦 RegistryService: No events index loaded yet');
        return [];
      }

      const events = indexFile.events || [];
      
      return events.map((e: any) => ({
        id: e.id,
        name: e.name || e.id,
        type: 'event' as ObjectType,
        status: e.status || 'active',
        file_path: e.file_path,
        tags: e.tags,
        hasFile: !!e.file_path,
        isOpen: tabs.some(t => t.fileId === `event-${e.id}`)
      }));
    } catch (error) {
      console.error('Failed to get events:', error);
      return [];
    }
  }
  
  // ADD loadEventsIndex method
  async loadEventsIndex(): Promise<void> {
    try {
      console.log('📦 RegistryService: Loading events-index.yaml...');
      const yamlText = await paramRegistryService.loadFile('events-index.yaml');
      const data = yaml.load(yamlText) as any;
      this.indexes.events = data;
      console.log(`📦 RegistryService: Loaded ${data.events?.length || 0} events from index`);
    } catch (error) {
      console.warn('Failed to load events-index.yaml:', error);
      this.indexes.events = null;
    }
  }
  
  // UPDATE loadAllIndexes to include events
  async loadAllIndexes(): Promise<void> {
    await Promise.all([
      this.loadParametersIndex(),
      this.loadContextsIndex(),
      this.loadCasesIndex(),
      this.loadNodesIndex(),
      this.loadEventsIndex()  // ADD THIS
    ]);
  }
}
```

---

### 5. EnhancedSelector Integration

**File:** `graph-editor/src/components/EnhancedSelector.tsx`

```typescript
type SelectorType = 
  'parameter' | 
  'node' | 
  'case' | 
  'context' | 
  'event';  // ADD THIS

interface EnhancedSelectorProps {
  type: SelectorType;
  // ... rest
}

// ADD event handling to switch statement:
case 'event':
  items = registryItems.events.map(e => ({
    id: e.id,
    label: e.name || e.id,
    description: e.description,
    tags: e.tags,
    status: e.status,
    type: e.type
  }));
  modalTitle = 'Select Event';
  newItemPlaceholder = 'event-id';
  break;
```

---

### 6. Properties Panel - Node Event Linking

**File:** `graph-editor/src/components/PropertiesPanel.tsx`

Already has event_id support in the schema, but need to add UI:

```typescript
{/* Event ID Selector - ADD THIS SECTION */}
<div className="form-group">
  <label className="form-label">
    <Calendar size={14} /> Linked Event
  </label>
  <EnhancedSelector
    type="event"
    value={node.event_id}
    onChange={(newEventId) => {
      const next = structuredClone(graph);
      const nodeIndex = next.nodes.findIndex(
        (n: any) => n.uuid === selectedNodeId || n.id === selectedNodeId
      );
      if (nodeIndex >= 0) {
        next.nodes[nodeIndex].event_id = newEventId;
        if (next.metadata) {
          next.metadata.updated_at = new Date().toISOString();
        }
        setGraph(next);
        saveHistoryState(newEventId ? 'Link event' : 'Unlink event', selectedNodeId || undefined);
      }
    }}
    onClear={() => {
      // Handled by onChange with null
    }}
    onOpenConnected={() => {
      if (node.event_id) {
        openFileById('event', node.event_id);
      }
    }}
    onOpenItem={(itemId) => {
      openFileById('event', itemId);
    }}
    placeholder="Select event..."
  />
</div>
```

---

### 7. File Operations Service

**File:** `graph-editor/src/services/fileOperationsService.ts`

Already supports generic file types, but verify:

```typescript
// In createFile method, add event default data:
if (!defaultData) {
  if (type === 'graph') {
    // ... graph default
  } else if (type === 'event') {
    defaultData = {
      id: name,
      name,
      description: '',
      event_type: 'conversion',
      properties: [],
      metadata: {
        created_at: new Date().toISOString(),
        author: 'user',
        version: '1.0.0',
        status: 'active'
      }
    };
  } else {
    // ... other defaults
  }
}
```

---

### 8. Form Editor

**File:** `graph-editor/src/components/editors/FormEditor.tsx`

Add event schema handling (should auto-handle if schema is in `/public/param-schemas/`):

```typescript
// Update schema loading to include events:
const schemaUrl = type === 'graph'
  ? '/schemas/schema/conversion-graph-1.0.0.json'
  : `/param-schemas/${type}-schema.yaml`;  // This will handle events automatically
```

---

### 9. Tab Icons

**File:** Anywhere tabs are rendered

Tabs should automatically use the correct icon from `objectTypeTheme`, but verify:

```typescript
const theme = getObjectTypeTheme(tab.type);
<theme.icon size={16} />
```

---

### 10. Context Menu

**File:** `graph-editor/src/components/NavigatorItemContextMenu.tsx`

Should automatically work for events since it's generic, but verify case-specific items don't break:

```typescript
// Ensure event items don't show case-specific menu options
{item.type === 'case' && (
  // Case-specific options
)}

{item.type === 'event' && (
  // Event-specific options (if any)
)}
```

---

## Testing Checklist

After implementation, verify:

- [ ] Events section appears in Navigator
- [ ] Can create new event via Navigator "+ New Event"
- [ ] Event files open in tabs with correct icon (yellow)
- [ ] Form editor loads event-schema.yaml correctly
- [ ] Can edit event properties in form editor
- [ ] EnhancedSelector shows events list
- [ ] Can link node to event via selector
- [ ] node.event_id persists correctly
- [ ] events-index.yaml auto-updates when event file created/modified/deleted
- [ ] Event files show dirty state (orange) when modified
- [ ] Can open event file from node selector's "Open Connected" button
- [ ] Event color (yellow) appears correctly in all locations

---

## File Locations Summary

| Component | File | Change Type |
|-----------|------|-------------|
| Types | `src/types/index.ts` | Add 'event' to ObjectType |
| Theme | `src/theme/objectTypeTheme.ts` | Add event theme (yellow) |
| Navigator | `src/components/Navigator/NavigatorContent.tsx` | Add events section |
| Registry | `src/services/registryService.ts` | Add getEvents(), loadEventsIndex() |
| Selector | `src/components/EnhancedSelector.tsx` | Add 'event' case |
| Properties | `src/components/PropertiesPanel.tsx` | Add event selector for nodes |
| File Ops | `src/services/fileOperationsService.ts` | Add event default data |
| Form Editor | `src/components/editors/FormEditor.tsx` | Verify schema loading |

---

## Dependencies

- ✅ `event-schema.yaml` exists in `/graph-editor/public/param-schemas/`
- ✅ Sample event files exist in `/param-registry/test/events/`
- ✅ `events-index.yaml` exists in `/param-registry/test/`
- ✅ Node schema includes `event_id` field (already done in Phase 0)

---

## Estimated Effort

**Time:** 3-4 hours

- Type definitions: 15 min
- Theme configuration: 15 min
- Navigator integration: 45 min
- Registry service: 30 min
- EnhancedSelector: 30 min
- Properties Panel: 30 min
- Testing & fixes: 60 min

---


