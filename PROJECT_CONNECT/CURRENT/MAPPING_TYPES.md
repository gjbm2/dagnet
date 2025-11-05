# Mapping Types: Hierarchical Architecture

## All Data Flows

| ID | ORIGIN | SUB-ORIGIN | DESTINATION | SUB-DESTINATION | OPERATION | EXAMPLES | IN SCOPE? |
|----|--------|------------|-------------|-----------------|-----------|----------|-----------|
| A | Graph | - | Graph | - | UPDATE | MSMDC edge query updates, copy/paste, cascade label changes | ✅ Yes |
| B | Graph | - | File | Parameter | CREATE, UPDATE, APPEND | CREATE new file from edge; UPDATE metadata (description, query); APPEND values[] | ✅ Yes |
| C | Graph | - | File | Case | CREATE, UPDATE, APPEND | CREATE new file from case node; UPDATE metadata; APPEND schedules[] | ✅ Yes |
| D | Graph | - | File | Node | CREATE, UPDATE | CREATE new node registry entry (+ button); UPDATE event_id (push from graph) | ✅ Yes |
| E | Graph | - | File | Context | CREATE | CREATE new context registry entry (+ button) - curated, not pushed | ✅ Yes |
| F | Graph | - | File | Event | CREATE | CREATE new event registry entry (+ button) - curated, not pushed | ✅ Yes |
| G | File | Parameter | Graph | - | UPDATE | User "Pull from Param" → sync latest values[] to edge | ✅ Yes |
| H | File | Case | Graph | - | UPDATE | User "Pull from Case" → sync latest schedules[] to case node | ✅ Yes |
| I | File | Node | Graph | - | UPDATE | User links existing node to registry → sync label/description/event_id | ✅ Yes |
| J | File | Context | Graph | - | - | (Future: context-aware parameter selection) | ❌ Not yet |
| K | File | Event | Graph | - | - | (Not a real flow - event_id flows via I when node registry contains it) | ❌ No - covered by I |
| L | External | - | Graph | Parameter | UPDATE | Direct: Amplitude/Sheets → update edge.p (edge must exist) | ✅ Yes |
| M | External | - | Graph | Case | UPDATE | Direct: Statsig/Optimizely → update case weights (node must exist) | ✅ Yes |
| N | External | - | Graph | Node | - | (No external source for node data directly to graph) | ❌ No |
| O | External | - | Graph | Context | - | (No external source for context data directly to graph) | ❌ No |
| P | External | - | Graph | Event | - | (No external source for event data directly to graph) | ❌ No |
| Q | External | - | File | Parameter | APPEND | Retrieve from source → append to values[] (file+connection must exist) | ✅ Yes |
| R | External | - | File | Case | APPEND | Retrieve from source → append to schedules[] (file+connection must exist) | ✅ Yes |
| S | External | - | File | Node | APPEND | (Future: discover events → append to node registry) | ❌ Not yet |
| T | External | - | File | Context | APPEND | (Future: discover contexts → append to context registry) | ❌ Not yet |
| U | External | - | File | Event | APPEND | (Future: discover events → append to event registry) | ❌ Not yet |

---

## Three Levels of Generalization

### Level 1: Direction/Flow Pattern (5 types)
**"What's moving where?"**
- `graph_to_file` - Graph entities write to filesystem
- `file_to_graph` - Files sync to graph entities
- `external_to_graph` - External sources update graph directly
- `external_to_file` - External sources append to file history
- `graph_internal` - Graph-to-graph updates (MSMDC, cascades)

### Level 2: Operation Type (4 types)
**"What kind of change?"**
- `CREATE` - Make new entity on disk/graph
- `UPDATE` - Modify existing entity
- `APPEND` - Add timestamped entry to history array
- `DELETE` - Remove entity (future)

### Level 3: Sub-Destination (5 types)
**"Which schema/structure?"**
- `parameter` - Has values[] array, query, condition
- `case` - Has schedules[] array, variants
- `node` - Has label, description, event_id
- `context` - Has dimensions, rules (future)
- `event` - Has connectors, mappings

---

## Validation: Mapping Coverage

### Flow A: Graph → Graph (UPDATE)
- **Level 1:** `graph_internal`
- **Level 2:** `UPDATE`
- **Level 3:** N/A (no sub-destination)
- **Implementation:** `handleGraphInternal(source, target, 'UPDATE', options)`
- **✅ Covered**

### Flow B: Graph → File/Parameter (CREATE, UPDATE, APPEND)
- **Level 1:** `graph_to_file`
- **Level 2:** `CREATE` | `UPDATE` | `APPEND`
- **Level 3:** `parameter`
- **Implementation:** 
  - `handleGraphToFile(source, target, 'CREATE', 'parameter', options)`
  - `handleGraphToFile(source, target, 'UPDATE', 'parameter', options)`
  - `handleGraphToFile(source, target, 'APPEND', 'parameter', options)`
- **✅ Covered (all 3 operations)**

### Flow C: Graph → File/Case (CREATE, UPDATE, APPEND)
- **Level 1:** `graph_to_file`
- **Level 2:** `CREATE` | `UPDATE` | `APPEND`
- **Level 3:** `case`
- **Implementation:**
  - `handleGraphToFile(source, target, 'CREATE', 'case', options)`
  - `handleGraphToFile(source, target, 'UPDATE', 'case', options)`
  - `handleGraphToFile(source, target, 'APPEND', 'case', options)`
- **✅ Covered (all 3 operations)**

### Flow D: Graph → File/Node (CREATE, UPDATE)
- **Level 1:** `graph_to_file`
- **Level 2:** `CREATE` | `UPDATE`
- **Level 3:** `node`
- **Implementation:**
  - `handleGraphToFile(source, target, 'CREATE', 'node', options)`
  - `handleGraphToFile(source, target, 'UPDATE', 'node', options)`
- **✅ Covered (both operations, no APPEND)**

### Flow E: Graph → File/Context (CREATE)
- **Level 1:** `graph_to_file`
- **Level 2:** `CREATE`
- **Level 3:** `context`
- **Implementation:** `handleGraphToFile(source, null, 'CREATE', 'context', options)`
- **✅ Covered (CREATE only)**

### Flow F: Graph → File/Event (CREATE)
- **Level 1:** `graph_to_file`
- **Level 2:** `CREATE`
- **Level 3:** `event`
- **Implementation:** `handleGraphToFile(source, null, 'CREATE', 'event', options)`
- **✅ Covered (CREATE only)**

### Flow G: File/Parameter → Graph (UPDATE)
- **Level 1:** `file_to_graph`
- **Level 2:** `UPDATE`
- **Level 3:** `parameter`
- **Implementation:** `handleFileToGraph(source, target, 'UPDATE', 'parameter', options)`
- **✅ Covered**

### Flow H: File/Case → Graph (UPDATE)
- **Level 1:** `file_to_graph`
- **Level 2:** `UPDATE`
- **Level 3:** `case`
- **Implementation:** `handleFileToGraph(source, target, 'UPDATE', 'case', options)`
- **✅ Covered**

### Flow I: File/Node → Graph (UPDATE)
- **Level 1:** `file_to_graph`
- **Level 2:** `UPDATE`
- **Level 3:** `node`
- **Implementation:** `handleFileToGraph(source, target, 'UPDATE', 'node', options)`
- **✅ Covered**

### Flow K: File/Event → Graph (NOT A REAL FLOW)
- **Clarification:** Event registry data does NOT flow to graph
- **What actually happens:** Node registry contains `event_id` field, which flows to graph via Flow I
- **Implementation:** No separate handling needed - Flow I already syncs `event_id` from node registry to graph
- **❌ Not a distinct flow - covered by I**

### Flow L: External → Graph/Parameter (UPDATE)
- **Level 1:** `external_to_graph`
- **Level 2:** `UPDATE`
- **Level 3:** `parameter`
- **Implementation:** `handleExternalToGraph(source, target, 'UPDATE', 'parameter', options)`
- **✅ Covered**

### Flow M: External → Graph/Case (UPDATE)
- **Level 1:** `external_to_graph`
- **Level 2:** `UPDATE`
- **Level 3:** `case`
- **Implementation:** `handleExternalToGraph(source, target, 'UPDATE', 'case', options)`
- **✅ Covered**

### Flow Q: External → File/Parameter (APPEND)
- **Level 1:** `external_to_file`
- **Level 2:** `APPEND`
- **Level 3:** `parameter`
- **Implementation:** `handleExternalToFile(source, target, 'APPEND', 'parameter', options)`
- **✅ Covered**

### Flow R: External → File/Case (APPEND)
- **Level 1:** `external_to_file`
- **Level 2:** `APPEND`
- **Level 3:** `case`
- **Implementation:** `handleExternalToFile(source, target, 'APPEND', 'case', options)`
- **✅ Covered**

---

## Summary: Coverage Validation

| Level 1 | Level 2 | Level 3 | Flows Covered | Status |
|---------|---------|---------|---------------|--------|
| `graph_internal` | UPDATE | - | A | ✅ |
| `graph_to_file` | CREATE | parameter | B.CREATE | ✅ |
| `graph_to_file` | UPDATE | parameter | B.UPDATE | ✅ |
| `graph_to_file` | APPEND | parameter | B.APPEND | ✅ |
| `graph_to_file` | CREATE | case | C.CREATE | ✅ |
| `graph_to_file` | UPDATE | case | C.UPDATE | ✅ |
| `graph_to_file` | APPEND | case | C.APPEND | ✅ |
| `graph_to_file` | CREATE | node | D.CREATE | ✅ |
| `graph_to_file` | UPDATE | node | D.UPDATE | ✅ |
| `graph_to_file` | CREATE | context | E.CREATE | ✅ |
| `graph_to_file` | CREATE | event | F.CREATE | ✅ |
| `file_to_graph` | UPDATE | parameter | G | ✅ |
| `file_to_graph` | UPDATE | case | H | ✅ |
| `file_to_graph` | UPDATE | node | I (includes event_id) | ✅ |
| `external_to_graph` | UPDATE | parameter | L | ✅ |
| `external_to_graph` | UPDATE | case | M | ✅ |
| `external_to_file` | APPEND | parameter | Q | ✅ |
| `external_to_file` | APPEND | case | R | ✅ |

**Total: 18 mapping combinations covering 13 in-scope flows (A-I, L-M, Q-R)** ✅

**Note:** Flow K is not a distinct flow - event_id is synced via Flow I when present in node registry.

---

## Architecture

### UpdateManager Structure

```typescript
class UpdateManager extends EventEmitter {
  
  // ============================================================
  // LEVEL 1: Direction Handlers (5 methods)
  // ============================================================
  
  private async handleGraphInternal(
    source: any, 
    target: any, 
    operation: 'UPDATE',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // MSMDC query regeneration, label cascades, copy/paste
    const mappings = this.getMappings('graph_internal', operation);
    return this.applyMappings(source, target, mappings, options);
  }
  
  private async handleGraphToFile(
    source: any,
    target: any | null,
    operation: 'CREATE' | 'UPDATE' | 'APPEND',
    subDest: 'parameter' | 'case' | 'node' | 'context' | 'event',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    switch (operation) {
      case 'CREATE':
        return this.createFileFromGraph(source, subDest, options);
      case 'UPDATE':
        return this.updateFileMetadata(source, target, subDest, options);
      case 'APPEND':
        return this.appendToFileHistory(source, target, subDest, options);
    }
  }
  
  private async handleFileToGraph(
    source: any,
    target: any,
    operation: 'UPDATE',
    subDest: 'parameter' | 'case' | 'node',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Always UPDATE - pull latest from file to graph
    // Note: 'event' is NOT a valid subDest here - event_id flows via 'node'
    return this.syncFileToGraph(source, target, subDest, options);
  }
  
  private async handleExternalToGraph(
    source: any,
    target: any,
    operation: 'UPDATE',
    subDest: 'parameter' | 'case',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Always UPDATE - direct update to graph
    return this.updateGraphFromExternal(source, target, subDest, options);
  }
  
  private async handleExternalToFile(
    source: any,
    target: any,
    operation: 'APPEND',
    subDest: 'parameter' | 'case',
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Always APPEND - add to file history
    return this.appendExternalToFile(source, target, subDest, options);
  }
  
  // ============================================================
  // LEVEL 2: Operation Implementations (shared logic)
  // ============================================================
  
  private async createFileFromGraph(
    graphEntity: any,
    subDest: string,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // 1. Generate new file ID
    const fileId = this.generateId();
    
    // 2. Get base file structure (Level 3 data)
    const structure = this.getBaseStructure(subDest);
    
    // 3. Get field mappings (Level 3 data)
    const mappings = this.getMappings('graph_to_file', 'CREATE', subDest);
    
    // 4. Populate structure from graph entity
    const populated = this.mapFields(graphEntity, structure, mappings);
    
    // 5. Validate
    this.validate(populated, subDest);
    
    // 6. Write to filesystem
    const filePath = this.getFilePath(subDest, fileId);
    await writeFile(filePath, yaml.stringify(populated));
    
    // 7. Audit trail
    this.recordUpdate('CREATE', 'graph_to_file', subDest, graphEntity, populated);
    
    return { success: true, fileId, filePath };
  }
  
  private async updateFileMetadata(
    graphEntity: any,
    existingFile: any,
    subDest: string,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // 1. Load existing file
    const file = await this.loadFile(existingFile.path);
    
    // 2. Get field mappings for metadata only (Level 3 data)
    const mappings = this.getMappings('graph_to_file', 'UPDATE', subDest);
    
    // 3. Compute updates (respecting overrides)
    const updates = this.computeUpdates(graphEntity, file, mappings, options);
    
    // 4. Apply updates (metadata only, not history arrays)
    this.applyUpdates(file, updates);
    
    // 5. Write back
    await writeFile(existingFile.path, yaml.stringify(file));
    
    // 6. Audit trail
    this.recordUpdate('UPDATE', 'graph_to_file', subDest, graphEntity, file, updates);
    
    return { success: true, updates };
  }
  
  private async appendToFileHistory(
    graphEntity: any,
    existingFile: any,
    subDest: string,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // 1. Load existing file
    const file = await this.loadFile(existingFile.path);
    
    // 2. Get field mappings (Level 3 data)
    const mappings = this.getMappings('graph_to_file', 'APPEND', subDest);
    
    // 3. Create timestamped entry
    const entry = {
      ...this.mapFields(graphEntity, {}, mappings),
      window_from: new Date().toISOString(),
      // ... additional timestamp metadata
    };
    
    // 4. Get array name (Level 3 data: 'values' or 'schedules')
    const arrayName = this.getHistoryArrayName(subDest);
    
    // 5. Prepend to array (most recent first)
    file[arrayName].unshift(entry);
    
    // 6. Write back
    await writeFile(existingFile.path, yaml.stringify(file));
    
    // 7. Audit trail
    this.recordUpdate('APPEND', 'graph_to_file', subDest, graphEntity, file, entry);
    
    return { success: true, entry };
  }
  
  private async syncFileToGraph(
    fileEntity: any,
    graphEntity: any,
    subDest: string,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // 1. Get field mappings (Level 3 data)
    const mappings = this.getMappings('file_to_graph', 'UPDATE', subDest);
    
    // 2. Extract "latest" value from file
    const latest = this.getLatestValue(fileEntity, subDest);
    
    // 3. Compute updates (respecting overrides)
    const updates = this.computeUpdates(latest, graphEntity, mappings, options);
    
    // 4. Handle conflicts (if interactive)
    if (options.interactive && this.detectConflicts(updates, graphEntity)) {
      const resolution = await this.showConflictModal(updates, graphEntity);
      if (resolution.cancelled) return { success: false, reason: 'User cancelled' };
      // Apply resolution...
    }
    
    // 5. Apply updates
    this.applyUpdates(graphEntity, updates);
    
    // 6. Audit trail
    this.recordUpdate('UPDATE', 'file_to_graph', subDest, fileEntity, graphEntity, updates);
    
    return { success: true, updates };
  }
  
  private async updateGraphFromExternal(
    externalData: any,
    graphEntity: any,
    subDest: string,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Same as syncFileToGraph but with external source
    const mappings = this.getMappings('external_to_graph', 'UPDATE', subDest);
    const updates = this.computeUpdates(externalData, graphEntity, mappings, options);
    
    // Handle conflicts, apply updates, audit trail...
    
    return { success: true, updates };
  }
  
  private async appendExternalToFile(
    externalData: any,
    fileEntity: any,
    subDest: string,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    // Same as appendToFileHistory but with external source
    const mappings = this.getMappings('external_to_file', 'APPEND', subDest);
    const entry = {
      ...this.mapFields(externalData, {}, mappings),
      window_from: externalData.window_from,
      retrieved_at: new Date().toISOString(),
      source: externalData.source // 'amplitude', 'sheets', etc.
    };
    
    const arrayName = this.getHistoryArrayName(subDest);
    fileEntity[arrayName].unshift(entry);
    
    // Write, audit...
    
    return { success: true, entry };
  }
  
  // ============================================================
  // LEVEL 3: Field Mapping Registry (configuration data)
  // ============================================================
  
  private mappingRegistry = {
    // Graph Internal
    'graph_internal.UPDATE': {
      fields: [
        { source: 'msmdc.query', target: 'edge.query', override: 'query_overridden' },
        { source: 'node.label', target: 'edge.from_label', override: 'label_overridden' },
        // ... more internal mappings
      ]
    },
    
    // Graph → File
    'graph_to_file.CREATE.parameter': {
      fields: [
        { source: 'edge.parameter_id', target: 'id' },
        { source: 'edge.label', target: 'name' },
        { source: 'edge.description', target: 'description' },
        // ... more fields
      ]
    },
    
    'graph_to_file.UPDATE.parameter': {
      fields: [
        { source: 'edge.description', target: 'description', override: 'description_overridden' },
        { source: 'edge.query', target: 'query', override: 'query_overridden' },
        // ... metadata only
      ]
    },
    
    'graph_to_file.APPEND.parameter': {
      fields: [
        { source: 'edge.p.p', target: 'mean' },
        { source: 'edge.p.stdev', target: 'stdev' },
        { source: 'edge.p.evidence.n', target: 'n' },
        { source: 'edge.p.evidence.k', target: 'k' },
        { source: 'edge.p.evidence.window_from', target: 'window_from' },
        { source: 'edge.p.evidence.window_to', target: 'window_to' },
        // ... values[] entry fields
      ]
    },
    
    'graph_to_file.CREATE.case': {
      fields: [
        { source: 'caseNode.id', target: 'id' },
        { source: 'caseNode.label', target: 'name' },
        // ... case file creation
      ]
    },
    
    'graph_to_file.APPEND.case': {
      fields: [
        { source: 'caseNode.variants', target: 'variants' },
        { source: 'caseNode.window_from', target: 'window_from' },
        // ... schedules[] entry fields
      ]
    },
    
    'graph_to_file.CREATE.node': {
      fields: [
        { source: 'node.id', target: 'id' },
        { source: 'node.label', target: 'label' },
        { source: 'node.description', target: 'description' },
        { source: 'node.event_id', target: 'event_id' },
        // ... node registry fields
      ]
    },
    
    'graph_to_file.UPDATE.node': {
      fields: [
        { source: 'node.event_id', target: 'event_id' },
        // ... push event_id from graph to registry
      ]
    },
    
    'graph_to_file.CREATE.context': {
      fields: [
        { source: 'context.id', target: 'id' },
        { source: 'context.name', target: 'name' },
        // ... context registry fields
      ]
    },
    
    'graph_to_file.CREATE.event': {
      fields: [
        { source: 'event.id', target: 'event_id' },
        { source: 'event.name', target: 'name' },
        // ... event registry fields
      ]
    },
    
    // File → Graph
    'file_to_graph.UPDATE.parameter': {
      fields: [
        { source: 'parameter.values[0].mean', target: 'edge.p.p', override: 'p.p_overridden' },
        { source: 'parameter.values[0].stdev', target: 'edge.p.stdev', override: 'p.stdev_overridden' },
        { source: 'parameter.values[0].n', target: 'edge.p.evidence.n' },
        { source: 'parameter.values[0].k', target: 'edge.p.evidence.k' },
        { source: 'parameter.query', target: 'edge.query', override: 'query_overridden' },
        // ... pull from file to graph
      ]
    },
    
    'file_to_graph.UPDATE.case': {
      fields: [
        { source: 'case.schedules[0].variants', target: 'caseNode.variants' },
        // ... pull case data
      ]
    },
    
    'file_to_graph.UPDATE.node': {
      fields: [
        { source: 'nodeRegistry.label', target: 'node.label', override: 'label_overridden' },
        { source: 'nodeRegistry.description', target: 'node.description', override: 'description_overridden' },
        { source: 'nodeRegistry.event_id', target: 'node.event_id', override: 'event_id_overridden' },
        // ... sync from registry (includes event_id when present)
      ]
    },
    
    // Note: No 'file_to_graph.UPDATE.event' - event data never flows to graph
    // event_id is stored in node registry and synced via 'file_to_graph.UPDATE.node'
    
    // External → Graph
    'external_to_graph.UPDATE.parameter': {
      fields: [
        { source: 'external.n', target: 'edge.p.evidence.n' },
        { source: 'external.k', target: 'edge.p.evidence.k' },
        { source: 'external.p', target: 'edge.p.p', override: 'p.p_overridden' },
        { source: 'external.window_from', target: 'edge.p.evidence.window_from' },
        // ... direct external → graph
      ]
    },
    
    'external_to_graph.UPDATE.case': {
      fields: [
        { source: 'external.variants', target: 'caseNode.variants' },
        // ... direct external → case
      ]
    },
    
    // External → File
    'external_to_file.APPEND.parameter': {
      fields: [
        { source: 'external.n', target: 'n' },
        { source: 'external.k', target: 'k' },
        { source: 'external.p', target: 'mean' },
        { source: 'external.window_from', target: 'window_from' },
        { source: 'external.window_to', target: 'window_to' },
        // ... append external to values[]
      ]
    },
    
    'external_to_file.APPEND.case': {
      fields: [
        { source: 'external.variants', target: 'variants' },
        { source: 'external.window_from', target: 'window_from' },
        // ... append external to schedules[]
      ]
    }
  };
  
  // Helper: Get mappings for a specific combination
  private getMappings(direction: string, operation: string, subDest?: string): any {
    const key = subDest 
      ? `${direction}.${operation}.${subDest}`
      : `${direction}.${operation}`;
    return this.mappingRegistry[key];
  }
  
  // Helper: Get history array name
  private getHistoryArrayName(subDest: string): string {
    switch (subDest) {
      case 'parameter': return 'values';
      case 'case': return 'schedules';
      default: throw new Error(`No history array for ${subDest}`);
    }
  }
  
  // Helper: Get base file structure
  private getBaseStructure(subDest: string): any {
    // Return empty template for each file type
    // ...
  }
  
  // Helper: Get latest value from file
  private getLatestValue(file: any, subDest: string): any {
    switch (subDest) {
      case 'parameter': return file.values[0]; // Most recent
      case 'case': return file.schedules[0];
      case 'node': return file; // No array, entire file
      case 'event': return file;
      default: return file;
    }
  }
  
  // ============================================================
  // Public API
  // ============================================================
  
  async updateEntity(
    source: any,
    target: any,
    direction: 'graph_internal' | 'graph_to_file' | 'file_to_graph' | 'external_to_graph' | 'external_to_file',
    operation: 'CREATE' | 'UPDATE' | 'APPEND',
    subDest?: 'parameter' | 'case' | 'node' | 'context' | 'event',
    options: UpdateOptions = { interactive: false }
  ): Promise<UpdateResult> {
    
    // Route to appropriate Level 1 handler
    switch (direction) {
      case 'graph_internal':
        return this.handleGraphInternal(source, target, 'UPDATE', options);
        
      case 'graph_to_file':
        return this.handleGraphToFile(source, target, operation as any, subDest!, options);
        
      case 'file_to_graph':
        return this.handleFileToGraph(source, target, 'UPDATE', subDest as any, options);
        
      case 'external_to_graph':
        return this.handleExternalToGraph(source, target, 'UPDATE', subDest as any, options);
        
      case 'external_to_file':
        return this.handleExternalToFile(source, target, 'APPEND', subDest as any, options);
        
      default:
        throw new Error(`Unknown direction: ${direction}`);
    }
  }
}
```

---

## Key Insights

1. **5 Level-1 handlers** - One per direction, handles routing
2. **Shared Level-2 logic** - CREATE/UPDATE/APPEND operations reused across sub-destinations
3. **18 Level-3 mapping configs** - Field mappings are pure data, not code
4. **All 13 in-scope flows covered** - Validated individually above (A-I, L-M, Q-R)

**Important clarification on Flow K:**
- Event registry data does NOT flow to graph
- `event_id` is stored in node registry and flows to graph via Flow I
- There is no separate "event→graph" mapping - it's just Flow I working normally

The architecture cleanly separates:
- **Direction logic** (5 handlers)
- **Operation logic** (shared implementations)
- **Schema-specific data** (mapping registry)

This gives maximum code reuse while maintaining clarity and debuggability.
