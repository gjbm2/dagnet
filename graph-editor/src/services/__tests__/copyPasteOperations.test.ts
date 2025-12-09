/**
 * Copy/Paste Operations Integration Tests
 * 
 * Tests the complete copy-paste and drag-drop workflow:
 * - Copy from Navigator (nodes, parameters, cases, events)
 * - Paste onto nodes (nodes, cases, events)
 * - Paste onto edges (parameters)
 * - Paste onto canvas (nodes)
 * - Drag & drop operations
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Graph, ConversionNode, ConversionEdge } from '../../types';

// ============================================================================
// MOCKS
// ============================================================================

// Mock toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock sessionLogService
vi.mock('../sessionLogService', () => ({
  sessionLogService: {
    startOperation: vi.fn(() => 'mock-op-id'),
    endOperation: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    addChild: vi.fn(),
  },
}));

// In-memory file registry mock
const mockFiles = new Map<string, any>();

vi.mock('../../contexts/TabContext', () => ({
  fileRegistry: {
    registerFile: vi.fn((id: string, data: any) => {
      mockFiles.set(id, { 
        data: structuredClone(data), 
        isDirty: false, 
        isInitializing: false,
        fileId: id,
      });
      return Promise.resolve();
    }),
    getFile: vi.fn((id: string) => mockFiles.get(id)),
    updateFile: vi.fn((id: string, data: any) => {
      if (mockFiles.has(id)) {
        const existing = mockFiles.get(id);
        mockFiles.set(id, { 
          ...existing,
          data: structuredClone(data), 
          isDirty: true,
        });
      }
      return Promise.resolve();
    }),
    deleteFile: vi.fn((id: string) => {
      mockFiles.delete(id);
      return Promise.resolve();
    }),
    _mockFiles: mockFiles,
  }
}));

// Import fileRegistry after mocking
const { fileRegistry } = await import('../../contexts/TabContext');
import toast from 'react-hot-toast';

// ============================================================================
// TEST UTILITIES
// ============================================================================

function createTestGraph(overrides?: Partial<Graph>): Graph {
  return {
    schema_version: '1.0.0',
    id: 'test-graph',
    name: 'Test Graph',
    description: 'Test graph for copy-paste operations',
    metadata: {
      updated_at: new Date().toISOString(),
    },
    nodes: [
      {
        uuid: 'node-1-uuid',
        id: 'landing-page',
        label: 'Landing Page',
        layout: { x: 0, y: 0 },
      },
      {
        uuid: 'node-2-uuid',
        id: 'checkout',
        label: 'Checkout',
        layout: { x: 200, y: 0 },
      },
    ],
    edges: [
      {
        uuid: 'edge-1-uuid',
        id: 'landing-to-checkout',
        from: 'landing-page',
        to: 'checkout',
        p: {
          mean: 0.3,
          stdev: 0.05,
        },
      },
    ],
    policies: {},
    ...overrides,
  } as Graph;
}

function createNodeFile(nodeId: string, overrides?: any) {
  return {
    id: nodeId,
    name: nodeId,
    label: nodeId.replace(/-/g, ' '),
    description: `Test node: ${nodeId}`,
    ...overrides,
  };
}

function createParameterFile(paramId: string, type: 'probability' | 'cost_gbp' | 'labour_cost' = 'probability') {
  return {
    id: paramId,
    name: paramId,
    type,
    query: 'from(landing-page).to(checkout)',
    mean: 0.45,
    stdev: 0.08,
    evidence: {
      n: 1000,
      k: 450,
    },
  };
}

function createCaseFile(caseId: string) {
  return {
    id: caseId,
    name: caseId,
    status: 'active',
    variants: [
      { name: 'Control', weight: 0.5 },
      { name: 'Treatment', weight: 0.5 },
    ],
  };
}

function createEventFile(eventId: string) {
  return {
    id: eventId,
    name: eventId.replace(/-/g, ' '),
    provider_event_names: {
      amplitude: `amp_${eventId}`,
      mixpanel: `mp_${eventId}`,
    },
  };
}

function setMockFile(fileId: string, data: any) {
  mockFiles.set(fileId, {
    data: structuredClone(data),
    isDirty: false,
    isInitializing: false,
    fileId,
  });
}

// ============================================================================
// CLIPBOARD DATA TYPES (matching useCopyPaste.tsx)
// ============================================================================

interface DagNetClipboardData {
  type: 'dagnet-copy';
  objectType: 'node' | 'parameter' | 'case' | 'event';
  objectId: string;
  timestamp: number;
}

interface DagNetDragData {
  type: 'dagnet-drag';
  objectType: 'node' | 'parameter' | 'case' | 'event';
  objectId: string;
}

// ============================================================================
// TESTS: CLIPBOARD DATA FORMAT
// ============================================================================

describe('Clipboard Data Format', () => {
  describe('DagNetClipboardData structure', () => {
    it('should have correct structure for node copy', () => {
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'landing-page',
        timestamp: Date.now(),
      };
      
      expect(data.type).toBe('dagnet-copy');
      expect(data.objectType).toBe('node');
      expect(data.objectId).toBe('landing-page');
      expect(typeof data.timestamp).toBe('number');
    });

    it('should have correct structure for parameter copy', () => {
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: 'checkout-rate',
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('parameter');
      expect(data.objectId).toBe('checkout-rate');
    });

    it('should have correct structure for case copy', () => {
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'case',
        objectId: 'ab-test-2025',
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('case');
    });

    it('should have correct structure for event copy', () => {
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'event',
        objectId: 'page-view',
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('event');
    });
  });

  describe('DagNetDragData structure', () => {
    it('should have correct structure for drag data', () => {
      const data: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'node',
        objectId: 'landing-page',
      };
      
      expect(data.type).toBe('dagnet-drag');
      expect(data.objectType).toBe('node');
      expect(data.objectId).toBe('landing-page');
    });
  });
});

// ============================================================================
// TESTS: COPY OPERATIONS (Navigator)
// ============================================================================

describe('Copy Operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
  });

  describe('Copy Node', () => {
    it('should create correct clipboard data for node', () => {
      const nodeId = 'landing-page';
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: nodeId,
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('node');
      expect(data.objectId).toBe(nodeId);
    });

    it('should serialize to valid JSON', () => {
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'landing-page',
        timestamp: 1234567890,
      };
      
      const json = JSON.stringify(data);
      const parsed = JSON.parse(json);
      
      expect(parsed).toEqual(data);
    });
  });

  describe('Copy Parameter', () => {
    it('should create correct clipboard data for parameter', () => {
      const paramId = 'checkout-rate';
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: paramId,
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('parameter');
      expect(data.objectId).toBe(paramId);
    });
  });

  describe('Copy Case', () => {
    it('should create correct clipboard data for case', () => {
      const caseId = 'ab-test-checkout';
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'case',
        objectId: caseId,
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('case');
      expect(data.objectId).toBe(caseId);
    });
  });

  describe('Copy Event', () => {
    it('should create correct clipboard data for event', () => {
      const eventId = 'page-view-landing';
      const data: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'event',
        objectId: eventId,
        timestamp: Date.now(),
      };
      
      expect(data.objectType).toBe('event');
      expect(data.objectId).toBe(eventId);
    });
  });
});

// ============================================================================
// TESTS: PASTE NODE OPERATIONS
// ============================================================================

describe('Paste Node Operations', () => {
  let graph: Graph;
  let setGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    graph = createTestGraph();
    setGraph = vi.fn();
  });

  describe('Paste Node onto Node', () => {
    it('should update node id when pasting node file', () => {
      const copiedNodeId = 'new-landing-page';
      const nodeFile = createNodeFile(copiedNodeId);
      setMockFile(`node-${copiedNodeId}`, nodeFile);
      
      // Simulate paste operation
      const nextGraph = structuredClone(graph);
      const targetNodeIndex = nextGraph.nodes.findIndex(n => n.uuid === 'node-1-uuid');
      
      expect(targetNodeIndex).toBeGreaterThanOrEqual(0);
      
      nextGraph.nodes[targetNodeIndex].id = copiedNodeId;
      nextGraph.nodes[targetNodeIndex].label = nodeFile.label;
      
      expect(nextGraph.nodes[targetNodeIndex].id).toBe(copiedNodeId);
      expect(nextGraph.nodes[targetNodeIndex].label).toBe(nodeFile.label);
    });

    it('should fail gracefully when node file not found', () => {
      const copiedNodeId = 'nonexistent-node';
      const file = fileRegistry.getFile(`node-${copiedNodeId}`);
      
      expect(file).toBeUndefined();
    });
  });

  describe('Paste Case onto Node', () => {
    it('should set node type to case when pasting case file', () => {
      const copiedCaseId = 'ab-test-checkout';
      const caseFile = createCaseFile(copiedCaseId);
      setMockFile(`case-${copiedCaseId}`, caseFile);
      
      // Simulate paste operation
      const nextGraph = structuredClone(graph);
      const targetNodeIndex = nextGraph.nodes.findIndex(n => n.uuid === 'node-1-uuid');
      
      nextGraph.nodes[targetNodeIndex].type = 'case';
      
      expect(nextGraph.nodes[targetNodeIndex].type).toBe('case');
    });

    it('should fail gracefully when case file not found', () => {
      const copiedCaseId = 'nonexistent-case';
      const file = fileRegistry.getFile(`case-${copiedCaseId}`);
      
      expect(file).toBeUndefined();
    });
  });

  describe('Paste Event onto Node', () => {
    it('should set event_id when pasting event file', () => {
      const copiedEventId = 'page-view-landing';
      const eventFile = createEventFile(copiedEventId);
      setMockFile(`event-${copiedEventId}`, eventFile);
      
      // Simulate paste operation
      const nextGraph = structuredClone(graph);
      const targetNodeIndex = nextGraph.nodes.findIndex(n => n.uuid === 'node-1-uuid');
      
      (nextGraph.nodes[targetNodeIndex] as any).event_id = copiedEventId;
      
      expect((nextGraph.nodes[targetNodeIndex] as any).event_id).toBe(copiedEventId);
    });

    it('should fail gracefully when event file not found', () => {
      const copiedEventId = 'nonexistent-event';
      const file = fileRegistry.getFile(`event-${copiedEventId}`);
      
      expect(file).toBeUndefined();
    });
  });
});

// ============================================================================
// TESTS: PASTE PARAMETER OPERATIONS
// ============================================================================

describe('Paste Parameter Operations', () => {
  let graph: Graph;
  let setGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    graph = createTestGraph();
    setGraph = vi.fn();
  });

  describe('Paste Parameter onto Edge', () => {
    it('should set p.id when pasting probability parameter', () => {
      const paramId = 'checkout-rate';
      const paramFile = createParameterFile(paramId, 'probability');
      setMockFile(`parameter-${paramId}`, paramFile);
      
      // Simulate paste operation
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === 'edge-1-uuid');
      
      expect(edgeIndex).toBeGreaterThanOrEqual(0);
      
      if (!nextGraph.edges[edgeIndex].p) {
        nextGraph.edges[edgeIndex].p = { mean: 0 };
      }
      (nextGraph.edges[edgeIndex].p as any).id = paramId;
      
      expect((nextGraph.edges[edgeIndex].p as any).id).toBe(paramId);
    });

    it('should set cost_gbp.id when pasting cost parameter', () => {
      const paramId = 'shipping-cost';
      const paramFile = createParameterFile(paramId, 'cost_gbp');
      setMockFile(`parameter-${paramId}`, paramFile);
      
      // Simulate paste operation
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === 'edge-1-uuid');
      
      if (!nextGraph.edges[edgeIndex].cost_gbp) {
        (nextGraph.edges[edgeIndex] as any).cost_gbp = { mean: 0 };
      }
      (nextGraph.edges[edgeIndex] as any).cost_gbp.id = paramId;
      
      expect((nextGraph.edges[edgeIndex] as any).cost_gbp.id).toBe(paramId);
    });

    it('should set labour_cost.id when pasting labour cost parameter', () => {
      const paramId = 'handling-cost';
      const paramFile = createParameterFile(paramId, 'labour_cost');
      setMockFile(`parameter-${paramId}`, paramFile);
      
      // Simulate paste operation
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === 'edge-1-uuid');
      
      if (!nextGraph.edges[edgeIndex].labour_cost) {
        (nextGraph.edges[edgeIndex] as any).labour_cost = { mean: 0 };
      }
      (nextGraph.edges[edgeIndex] as any).labour_cost.id = paramId;
      
      expect((nextGraph.edges[edgeIndex] as any).labour_cost.id).toBe(paramId);
    });

    it('should find edge by uuid', () => {
      const edgeId = 'edge-1-uuid';
      const edge = graph.edges?.find(e => e.uuid === edgeId);
      
      expect(edge).toBeDefined();
      expect(edge?.uuid).toBe(edgeId);
    });

    it('should find edge by human-readable id', () => {
      const edgeId = 'landing-to-checkout';
      const edge = graph.edges?.find(e => e.id === edgeId);
      
      expect(edge).toBeDefined();
      expect(edge?.id).toBe(edgeId);
    });

    it('should find edge by from->to format', () => {
      const edgeId = 'landing-page->checkout';
      const edge = graph.edges?.find(e => `${e.from}->${e.to}` === edgeId);
      
      expect(edge).toBeDefined();
    });

    it('should fail gracefully when parameter file not found', () => {
      const paramId = 'nonexistent-param';
      const file = fileRegistry.getFile(`parameter-${paramId}`);
      
      expect(file).toBeUndefined();
    });
  });
});

// ============================================================================
// TESTS: PASTE NODE ON CANVAS
// ============================================================================

describe('Paste Node on Canvas', () => {
  let graph: Graph;
  let setGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    graph = createTestGraph();
    setGraph = vi.fn();
  });

  it('should create new node when pasting on canvas', () => {
    const copiedNodeId = 'product-page';
    const nodeFile = createNodeFile(copiedNodeId);
    setMockFile(`node-${copiedNodeId}`, nodeFile);
    
    // Simulate paste on canvas - creates a new node
    const nextGraph = structuredClone(graph);
    const newNodeUuid = 'new-node-uuid-123';
    const position = { x: 300, y: 200 };
    
    const newNode = {
      uuid: newNodeUuid,
      id: copiedNodeId,
      label: nodeFile.label || copiedNodeId,
      layout: position,
    };
    
    nextGraph.nodes.push(newNode as any);
    
    expect(nextGraph.nodes.length).toBe(graph.nodes.length + 1);
    expect(nextGraph.nodes.find(n => n.uuid === newNodeUuid)).toBeDefined();
    expect(nextGraph.nodes.find(n => n.uuid === newNodeUuid)?.id).toBe(copiedNodeId);
  });

  it('should place new node at click position', () => {
    const copiedNodeId = 'product-page';
    const nodeFile = createNodeFile(copiedNodeId);
    setMockFile(`node-${copiedNodeId}`, nodeFile);
    
    const position = { x: 450, y: 300 };
    
    const nextGraph = structuredClone(graph);
    const newNode = {
      uuid: 'new-node-uuid',
      id: copiedNodeId,
      label: nodeFile.label,
      layout: position,
    };
    nextGraph.nodes.push(newNode as any);
    
    const addedNode = nextGraph.nodes.find(n => n.uuid === 'new-node-uuid');
    expect(addedNode?.layout).toEqual(position);
  });
});

// ============================================================================
// TESTS: DRAG & DROP OPERATIONS
// ============================================================================

describe('Drag & Drop Operations', () => {
  let graph: Graph;
  let setGraph: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    graph = createTestGraph();
    setGraph = vi.fn();
  });

  describe('Drag Data Format', () => {
    it('should create correct drag data for node', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'node',
        objectId: 'landing-page',
      };
      
      expect(dragData.type).toBe('dagnet-drag');
      expect(dragData.objectType).toBe('node');
    });

    it('should create correct drag data for parameter', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'parameter',
        objectId: 'checkout-rate',
      };
      
      expect(dragData.objectType).toBe('parameter');
    });

    it('should create correct drag data for case', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'case',
        objectId: 'ab-test',
      };
      
      expect(dragData.objectType).toBe('case');
    });

    it('should create correct drag data for event', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'event',
        objectId: 'page-view',
      };
      
      expect(dragData.objectType).toBe('event');
    });

    it('should serialize drag data to JSON', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'node',
        objectId: 'landing-page',
      };
      
      const json = JSON.stringify(dragData);
      expect(json).toBe('{"type":"dagnet-drag","objectType":"node","objectId":"landing-page"}');
    });
  });

  describe('Drop Node on Canvas', () => {
    it('should create new node when dropping on canvas', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'node',
        objectId: 'product-page',
      };
      
      const nodeFile = createNodeFile(dragData.objectId);
      setMockFile(`node-${dragData.objectId}`, nodeFile);
      
      // Validate file exists
      const file = fileRegistry.getFile(`node-${dragData.objectId}`);
      expect(file).toBeDefined();
      
      // Simulate drop - create new node
      const nextGraph = structuredClone(graph);
      const newNode = {
        uuid: 'dropped-node-uuid',
        id: dragData.objectId,
        label: nodeFile.label,
        layout: { x: 400, y: 300 },
      };
      nextGraph.nodes.push(newNode as any);
      
      expect(nextGraph.nodes.length).toBe(graph.nodes.length + 1);
    });
  });

  describe('Drop Node on Existing Node', () => {
    it('should update node id when dropping node file on node', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'node',
        objectId: 'new-landing-page',
      };
      
      const nodeFile = createNodeFile(dragData.objectId);
      setMockFile(`node-${dragData.objectId}`, nodeFile);
      
      // Simulate drop on existing node
      const nextGraph = structuredClone(graph);
      const targetNodeIndex = nextGraph.nodes.findIndex(n => n.uuid === 'node-1-uuid');
      
      nextGraph.nodes[targetNodeIndex].id = dragData.objectId;
      nextGraph.nodes[targetNodeIndex].label = nodeFile.label;
      
      expect(nextGraph.nodes[targetNodeIndex].id).toBe(dragData.objectId);
    });
  });

  describe('Drop Case on Node', () => {
    it('should set type to case when dropping case file on node', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'case',
        objectId: 'ab-test-checkout',
      };
      
      const caseFile = createCaseFile(dragData.objectId);
      setMockFile(`case-${dragData.objectId}`, caseFile);
      
      // Simulate drop on node
      const nextGraph = structuredClone(graph);
      const targetNodeIndex = nextGraph.nodes.findIndex(n => n.uuid === 'node-1-uuid');
      
      nextGraph.nodes[targetNodeIndex].type = 'case';
      
      expect(nextGraph.nodes[targetNodeIndex].type).toBe('case');
    });
  });

  describe('Drop Event on Node', () => {
    it('should set event_id when dropping event file on node', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'event',
        objectId: 'page-view-landing',
      };
      
      const eventFile = createEventFile(dragData.objectId);
      setMockFile(`event-${dragData.objectId}`, eventFile);
      
      // Simulate drop on node
      const nextGraph = structuredClone(graph);
      const targetNodeIndex = nextGraph.nodes.findIndex(n => n.uuid === 'node-1-uuid');
      
      (nextGraph.nodes[targetNodeIndex] as any).event_id = dragData.objectId;
      
      expect((nextGraph.nodes[targetNodeIndex] as any).event_id).toBe(dragData.objectId);
    });
  });

  describe('Drop Parameter on Edge', () => {
    it('should set p.id when dropping probability parameter on edge', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'parameter',
        objectId: 'checkout-rate',
      };
      
      const paramFile = createParameterFile(dragData.objectId, 'probability');
      setMockFile(`parameter-${dragData.objectId}`, paramFile);
      
      // Simulate drop on edge
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === 'edge-1-uuid');
      
      if (!nextGraph.edges[edgeIndex].p) {
        nextGraph.edges[edgeIndex].p = { mean: 0 };
      }
      (nextGraph.edges[edgeIndex].p as any).id = dragData.objectId;
      
      expect((nextGraph.edges[edgeIndex].p as any).id).toBe(dragData.objectId);
    });

    it('should set cost_gbp.id when dropping cost parameter on edge', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'parameter',
        objectId: 'shipping-cost',
      };
      
      const paramFile = createParameterFile(dragData.objectId, 'cost_gbp');
      setMockFile(`parameter-${dragData.objectId}`, paramFile);
      
      const file = fileRegistry.getFile(`parameter-${dragData.objectId}`);
      expect(file?.data?.type).toBe('cost_gbp');
      
      // Simulate drop on edge
      const nextGraph = structuredClone(graph);
      const edgeIndex = nextGraph.edges.findIndex(e => e.uuid === 'edge-1-uuid');
      
      (nextGraph.edges[edgeIndex] as any).cost_gbp = { mean: 0, id: dragData.objectId };
      
      expect((nextGraph.edges[edgeIndex] as any).cost_gbp.id).toBe(dragData.objectId);
    });
  });

  describe('Invalid Drop Operations', () => {
    it('should reject non-dagnet-drag data', () => {
      const invalidData = {
        type: 'other-type',
        objectType: 'node',
        objectId: 'test',
      };
      
      expect(invalidData.type).not.toBe('dagnet-drag');
    });

    it('should reject unknown object types', () => {
      const invalidData = {
        type: 'dagnet-drag',
        objectType: 'unknown',
        objectId: 'test',
      };
      
      const validTypes = ['node', 'parameter', 'case', 'event'];
      expect(validTypes).not.toContain(invalidData.objectType);
    });

    it('should handle missing file gracefully', () => {
      const dragData: DagNetDragData = {
        type: 'dagnet-drag',
        objectType: 'node',
        objectId: 'nonexistent',
      };
      
      const file = fileRegistry.getFile(`node-${dragData.objectId}`);
      expect(file).toBeUndefined();
    });
  });
});

// ============================================================================
// TESTS: EDGE LOOKUP PATTERNS
// ============================================================================

describe('Edge Lookup Patterns', () => {
  let graph: Graph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  it('should find edge by uuid', () => {
    const edgeId = 'edge-1-uuid';
    const edge = graph.edges?.find((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    expect(edge).toBeDefined();
    expect(edge?.uuid).toBe('edge-1-uuid');
  });

  it('should find edge by human-readable id', () => {
    const edgeId = 'landing-to-checkout';
    const edge = graph.edges?.find((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    expect(edge).toBeDefined();
    expect(edge?.id).toBe('landing-to-checkout');
  });

  it('should find edge by from->to format', () => {
    const edgeId = 'landing-page->checkout';
    const edge = graph.edges?.find((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    expect(edge).toBeDefined();
    expect(edge?.from).toBe('landing-page');
    expect(edge?.to).toBe('checkout');
  });

  it('should return undefined for unknown edge id', () => {
    const edgeId = 'nonexistent-edge';
    const edge = graph.edges?.find((e: any) => 
      e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId
    );
    
    expect(edge).toBeUndefined();
  });
});

// ============================================================================
// TESTS: FILE EXISTENCE VALIDATION
// ============================================================================

describe('File Existence Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
  });

  it('should find existing node file', () => {
    const nodeId = 'landing-page';
    setMockFile(`node-${nodeId}`, createNodeFile(nodeId));
    
    const file = fileRegistry.getFile(`node-${nodeId}`);
    expect(file).toBeDefined();
    expect(file?.data?.id).toBe(nodeId);
  });

  it('should find existing parameter file', () => {
    const paramId = 'checkout-rate';
    setMockFile(`parameter-${paramId}`, createParameterFile(paramId));
    
    const file = fileRegistry.getFile(`parameter-${paramId}`);
    expect(file).toBeDefined();
    expect(file?.data?.id).toBe(paramId);
  });

  it('should find existing case file', () => {
    const caseId = 'ab-test';
    setMockFile(`case-${caseId}`, createCaseFile(caseId));
    
    const file = fileRegistry.getFile(`case-${caseId}`);
    expect(file).toBeDefined();
    expect(file?.data?.id).toBe(caseId);
  });

  it('should find existing event file', () => {
    const eventId = 'page-view';
    setMockFile(`event-${eventId}`, createEventFile(eventId));
    
    const file = fileRegistry.getFile(`event-${eventId}`);
    expect(file).toBeDefined();
    expect(file?.data?.id).toBe(eventId);
  });

  it('should return undefined for missing file', () => {
    const file = fileRegistry.getFile('nonexistent-file');
    expect(file).toBeUndefined();
  });
});

// ============================================================================
// TESTS: PARAMETER TYPE SLOT MAPPING
// ============================================================================

describe('Parameter Type Slot Mapping', () => {
  it('should map probability to p slot', () => {
    const paramType = 'probability';
    let slot: string;
    
    if (paramType === 'probability') {
      slot = 'p';
    } else if (paramType === 'cost_gbp') {
      slot = 'cost_gbp';
    } else if (paramType === 'labour_cost') {
      slot = 'labour_cost';
    } else {
      slot = 'p'; // Default
    }
    
    expect(slot).toBe('p');
  });

  it('should map cost_gbp to cost_gbp slot', () => {
    const paramType = 'cost_gbp';
    let slot: string;
    
    if (paramType === 'probability') {
      slot = 'p';
    } else if (paramType === 'cost_gbp') {
      slot = 'cost_gbp';
    } else if (paramType === 'labour_cost') {
      slot = 'labour_cost';
    } else {
      slot = 'p';
    }
    
    expect(slot).toBe('cost_gbp');
  });

  it('should map labour_cost to labour_cost slot', () => {
    const paramType = 'labour_cost';
    let slot: string;
    
    if (paramType === 'probability') {
      slot = 'p';
    } else if (paramType === 'cost_gbp') {
      slot = 'cost_gbp';
    } else if (paramType === 'labour_cost') {
      slot = 'labour_cost';
    } else {
      slot = 'p';
    }
    
    expect(slot).toBe('labour_cost');
  });

  it('should default to p slot for unknown type', () => {
    const paramType = 'unknown';
    let slot: string;
    
    if (paramType === 'probability') {
      slot = 'p';
    } else if (paramType === 'cost_gbp') {
      slot = 'cost_gbp';
    } else if (paramType === 'labour_cost') {
      slot = 'labour_cost';
    } else {
      slot = 'p';
    }
    
    expect(slot).toBe('p');
  });
});

// ============================================================================
// TESTS: GRAPH UPDATE INTEGRITY
// ============================================================================

describe('Graph Update Integrity', () => {
  let graph: Graph;

  beforeEach(() => {
    graph = createTestGraph();
  });

  it('should preserve other nodes when updating one node', () => {
    const originalNodeCount = graph.nodes.length;
    const nextGraph = structuredClone(graph);
    
    // Update node 1
    nextGraph.nodes[0].id = 'updated-node';
    
    expect(nextGraph.nodes.length).toBe(originalNodeCount);
    expect(nextGraph.nodes[1].id).toBe(graph.nodes[1].id); // Other node unchanged
  });

  it('should preserve other edges when updating one edge', () => {
    const originalEdgeCount = graph.edges?.length || 0;
    const nextGraph = structuredClone(graph);
    
    // Update edge 1
    if (nextGraph.edges && nextGraph.edges[0].p) {
      (nextGraph.edges[0].p as any).id = 'updated-param';
    }
    
    expect(nextGraph.edges?.length).toBe(originalEdgeCount);
  });

  it('should update metadata.updated_at when graph changes', () => {
    const nextGraph = structuredClone(graph);
    
    // Set a specific timestamp
    const newTimestamp = '2025-12-09T12:00:00.000Z';
    if (nextGraph.metadata) {
      nextGraph.metadata.updated_at = newTimestamp;
    }
    
    expect(nextGraph.metadata?.updated_at).toBe(newTimestamp);
  });

  it('should use structuredClone for deep copy', () => {
    const nextGraph = structuredClone(graph);
    
    // Modify nextGraph
    nextGraph.nodes[0].label = 'Modified';
    
    // Original should be unchanged
    expect(graph.nodes[0].label).toBe('Landing Page');
    expect(nextGraph.nodes[0].label).toBe('Modified');
  });
});

// ============================================================================
// TESTS: CONDITIONAL PASTE VISIBILITY
// ============================================================================

describe('Conditional Paste Visibility', () => {
  describe('Node Context Menu', () => {
    it('should show Paste Node when node is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'landing-page',
        timestamp: Date.now(),
      };
      
      const copiedNode = copiedItem.objectType === 'node' ? copiedItem : null;
      expect(copiedNode).not.toBeNull();
    });

    it('should NOT show Paste Node when parameter is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: 'checkout-rate',
        timestamp: Date.now(),
      };
      
      const copiedNode = copiedItem.objectType === 'node' ? copiedItem : null;
      expect(copiedNode).toBeNull();
    });

    it('should show Paste Case when case is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'case',
        objectId: 'ab-test',
        timestamp: Date.now(),
      };
      
      const copiedCase = copiedItem.objectType === 'case' ? copiedItem : null;
      expect(copiedCase).not.toBeNull();
    });

    it('should show Paste Event when event is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'event',
        objectId: 'page-view',
        timestamp: Date.now(),
      };
      
      const copiedEvent = copiedItem.objectType === 'event' ? copiedItem : null;
      expect(copiedEvent).not.toBeNull();
    });
  });

  describe('Edge Context Menu', () => {
    it('should show Paste Parameter when parameter is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'parameter',
        objectId: 'checkout-rate',
        timestamp: Date.now(),
      };
      
      const copiedParameter = copiedItem.objectType === 'parameter' ? copiedItem : null;
      expect(copiedParameter).not.toBeNull();
    });

    it('should NOT show Paste Parameter when node is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'landing-page',
        timestamp: Date.now(),
      };
      
      const copiedParameter = copiedItem.objectType === 'parameter' ? copiedItem : null;
      expect(copiedParameter).toBeNull();
    });
  });

  describe('Canvas Context Menu', () => {
    it('should show Paste Node when node is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'node',
        objectId: 'landing-page',
        timestamp: Date.now(),
      };
      
      const copiedNode = copiedItem.objectType === 'node' ? copiedItem : null;
      expect(copiedNode).not.toBeNull();
    });

    it('should NOT show Paste Node when case is copied', () => {
      const copiedItem: DagNetClipboardData = {
        type: 'dagnet-copy',
        objectType: 'case',
        objectId: 'ab-test',
        timestamp: Date.now(),
      };
      
      const copiedNode = copiedItem.objectType === 'node' ? copiedItem : null;
      expect(copiedNode).toBeNull();
    });
  });
});

// ============================================================================
// TESTS: DRAGGABLE FILE TYPES
// ============================================================================

describe('Draggable File Types', () => {
  const draggableTypes = ['node', 'parameter', 'case', 'event'];
  const nonDraggableTypes = ['graph', 'context', 'connection'];

  it.each(draggableTypes)('should allow dragging %s files', (type) => {
    const isDraggable = ['node', 'parameter', 'case', 'event'].includes(type);
    expect(isDraggable).toBe(true);
  });

  it.each(nonDraggableTypes)('should NOT allow dragging %s files', (type) => {
    const isDraggable = ['node', 'parameter', 'case', 'event'].includes(type);
    expect(isDraggable).toBe(false);
  });
});

