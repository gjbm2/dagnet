/**
 * UpdateManager Rebalancing Tests
 * 
 * Tests probability mass function (PMF) rebalancing logic:
 * - Force rebalance: ignores ALL locks and overrides
 * - Normal rebalance: respects parameter locks and overrides
 * - Edge probabilities
 * - Conditional probabilities
 * - Variant weights
 * 
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UpdateManager } from '../UpdateManager';

describe('UpdateManager - Rebalancing', () => {
  let updateManager: UpdateManager;
  
  beforeEach(() => {
    updateManager = new UpdateManager();
    updateManager.clearAuditLog();
  });
  
  // ============================================================
  // TEST SUITE 1: Edge Probability Rebalancing
  // ============================================================
  
  describe('rebalanceEdgeProbabilities', () => {
    describe('Force Rebalance (forceRebalance=true)', () => {
      it('should rebalance ALL siblings, ignoring overrides', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              p: { mean: 0.3, mean_overridden: false }
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              p: { mean: 0.4, mean_overridden: true } // ← Overridden, but force should still touch it
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              p: { mean: 0.3, mean_overridden: false }
            }
          ]
        };
        
        // Change edge-1 to 0.6, should force rebalance edge-2 and edge-3
        graph.edges[0].p.mean = 0.6;
        
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', true);
        
        // Origin edge unchanged
        expect(result.edges[0].p.mean).toBe(0.6);
        
        // Siblings rebalanced proportionally (0.4 total remaining)
        // edge-2: 0.4 * (0.4 / 0.7) ≈ 0.229
        // edge-3: 0.4 * (0.3 / 0.7) ≈ 0.171
        const edge2Mean = result.edges[1].p.mean;
        const edge3Mean = result.edges[2].p.mean;
        
        expect(edge2Mean).toBeCloseTo(0.229, 2);
        expect(edge3Mean).toBeCloseTo(0.171, 2);
        
        // Override flags CLEARED by force rebalance
        expect(result.edges[1].p.mean_overridden).toBeUndefined();
        expect(result.edges[2].p.mean_overridden).toBeUndefined();
        
        // PMF sums to 1.0
        const total = result.edges[0].p.mean + edge2Mean + edge3Mean;
        expect(total).toBeCloseTo(1.0, 10);
      });
      
      it('should rebalance ALL siblings, ignoring parameter locks', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              p: { mean: 0.3 }
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              p: { 
                mean: 0.4,
                id: 'param-alpha', // ← Has parameter reference
                connection: 'amplitude-prod' // ← Has connection
              }
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              p: { 
                mean: 0.3,
                id: 'param-beta' // ← Has parameter reference
              }
            }
          ]
        };
        
        // Change edge-1 to 0.7, should force rebalance edge-2 and edge-3 despite params
        graph.edges[0].p.mean = 0.7;
        
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', true);
        
        // Origin edge unchanged
        expect(result.edges[0].p.mean).toBe(0.7);
        
        // Siblings rebalanced despite having parameter references
        const edge2Mean = result.edges[1].p.mean;
        const edge3Mean = result.edges[2].p.mean;
        
        expect(edge2Mean).toBeCloseTo(0.171, 2);
        expect(edge3Mean).toBeCloseTo(0.129, 2);
        
        // PMF sums to 1.0
        const total = result.edges[0].p.mean + edge2Mean + edge3Mean;
        expect(total).toBeCloseTo(1.0, 10);
      });
    });
    
    describe('Normal Rebalance (forceRebalance=false)', () => {
      it('should rebalance p.mean without clobbering p.forecast.mean (no cross-layer rebalance)', () => {
        const graph = {
          nodes: [{ uuid: 'node-a', id: 'node-a' }],
          edges: [
            {
              uuid: 'edge-1',
              from: 'node-a',
              to: 'node-b',
              p: { mean: 0.6, forecast: { mean: 0.1 } }, // origin edge forecast baseline
            },
            {
              uuid: 'edge-2',
              from: 'node-a',
              to: 'node-c',
              p: { mean: 0.2, forecast: { mean: 0.7 } }, // sibling forecast baseline
            },
            {
              uuid: 'edge-3',
              from: 'node-a',
              to: 'node-d',
              p: { mean: 0.2, forecast: { mean: 0.2 } }, // sibling forecast baseline
            },
          ],
        };

        // Rebalance siblings given origin mean=0.6 → siblings should sum to 0.4
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', false);

        // Means rebalanced (edge-2 and edge-3 remain proportional 0.2:0.2 → equal split)
        expect(result.edges[1].p.mean).toBeCloseTo(0.2, 6);
        expect(result.edges[2].p.mean).toBeCloseTo(0.2, 6);

        // Forecasts must be unchanged
        expect(result.edges[0].p.forecast.mean).toBeCloseTo(0.1, 10);
        expect(result.edges[1].p.forecast.mean).toBeCloseTo(0.7, 10);
        expect(result.edges[2].p.forecast.mean).toBeCloseTo(0.2, 10);
      });

      it('should respect override flags', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              p: { mean: 0.3, mean_overridden: false }
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              p: { mean: 0.4, mean_overridden: true } // ← Overridden, should NOT touch
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              p: { mean: 0.3, mean_overridden: false }
            }
          ]
        };
        
        // Change edge-1 to 0.6, should only rebalance edge-3 (edge-2 is overridden)
        graph.edges[0].p.mean = 0.6;
        
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', false);
        
        // Origin edge unchanged
        expect(result.edges[0].p.mean).toBe(0.6);
        
        // Overridden edge unchanged
        expect(result.edges[1].p.mean).toBe(0.4);
        expect(result.edges[1].p.mean_overridden).toBe(true);
        
        // Free edge absorbs all remaining weight (1.0 - 0.6 - 0.4 = 0)
        expect(result.edges[2].p.mean).toBeCloseTo(0.0, 10);
        
        // PMF sums to 1.0
        const total = result.edges[0].p.mean + result.edges[1].p.mean + result.edges[2].p.mean;
        expect(total).toBeCloseTo(1.0, 10);
      });
      
      it('should respect parameter locks (p.id)', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              p: { mean: 0.3 }
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              p: { 
                mean: 0.4,
                id: 'param-alpha' // ← Has parameter file reference, should NOT touch
              }
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              p: { mean: 0.3 }
            }
          ]
        };
        
        // Change edge-1 to 0.6, should only rebalance edge-3 (edge-2 is locked)
        graph.edges[0].p.mean = 0.6;
        
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', false);
        
        // Origin edge unchanged
        expect(result.edges[0].p.mean).toBe(0.6);
        
        // Locked edge unchanged
        expect(result.edges[1].p.mean).toBe(0.4);
        expect(result.edges[1].p.id).toBe('param-alpha');
        
        // Free edge absorbs all remaining weight (1.0 - 0.6 - 0.4 = 0)
        expect(result.edges[2].p.mean).toBeCloseTo(0.0, 10);
        
        // PMF sums to 1.0
        const total = result.edges[0].p.mean + result.edges[1].p.mean + result.edges[2].p.mean;
        expect(total).toBeCloseTo(1.0, 10);
      });
      
      it('should respect parameter locks (p.connection)', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              p: { mean: 0.3 }
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              p: { 
                mean: 0.5,
                connection: 'amplitude-prod' // ← Has direct connection, should NOT touch
              }
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              p: { mean: 0.2 }
            }
          ]
        };
        
        // Change edge-1 to 0.4, should only rebalance edge-3
        graph.edges[0].p.mean = 0.4;
        
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', false);
        
        // Origin edge unchanged
        expect(result.edges[0].p.mean).toBe(0.4);
        
        // Locked edge unchanged
        expect(result.edges[1].p.mean).toBe(0.5);
        expect(result.edges[1].p.connection).toBe('amplitude-prod');
        
        // Free edge gets remaining (1.0 - 0.4 - 0.5 = 0.1)
        expect(result.edges[2].p.mean).toBeCloseTo(0.1, 10);
        
        // PMF sums to 1.0
        const total = result.edges[0].p.mean + result.edges[1].p.mean + result.edges[2].p.mean;
        expect(total).toBeCloseTo(1.0, 10);
      });
      
      it('should handle multiple locked and overridden edges', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              p: { mean: 0.2 }
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              p: { mean: 0.3, id: 'param-alpha' } // Locked
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              p: { mean: 0.25, mean_overridden: true } // Overridden
            },
            { 
              uuid: 'edge-4', 
              from: 'node-a', 
              to: 'node-e',
              p: { mean: 0.15 } // Free
            },
            { 
              uuid: 'edge-5', 
              from: 'node-a', 
              to: 'node-f',
              p: { mean: 0.1 } // Free
            }
          ]
        };
        
        // Change edge-1 to 0.3
        graph.edges[0].p.mean = 0.3;
        
        const result = updateManager.rebalanceEdgeProbabilities(graph, 'edge-1', false);
        
        // Origin unchanged
        expect(result.edges[0].p.mean).toBe(0.3);
        
        // Locked unchanged
        expect(result.edges[1].p.mean).toBe(0.3);
        
        // Overridden unchanged
        expect(result.edges[2].p.mean).toBe(0.25);
        
        // Free edges share remaining: 1.0 - 0.3 - 0.3 - 0.25 = 0.15
        // Split proportionally: edge-4 gets 0.15 * (0.15 / 0.25) = 0.09
        //                        edge-5 gets 0.15 * (0.10 / 0.25) = 0.06
        expect(result.edges[3].p.mean).toBeCloseTo(0.09, 10);
        expect(result.edges[4].p.mean).toBeCloseTo(0.06, 10);
        
        // PMF sums to 1.0
        const total = result.edges.reduce((sum, e) => sum + e.p.mean, 0);
        expect(total).toBeCloseTo(1.0, 10);
      });
    });
  });
  
  // ============================================================
  // TEST SUITE 2: Conditional Probability Rebalancing
  // ============================================================
  
  describe('rebalanceConditionalProbabilities', () => {
    describe('Force Rebalance', () => {
      it('should rebalance ALL siblings with same condition, ignoring locks', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { mean: 0.4 }
                }
              ]
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { 
                    mean: 0.6,
                    id: 'param-cond-1', // ← Has parameter, but force should still touch
                    mean_overridden: true
                  }
                }
              ]
            }
          ]
        };
        
        // The rebalancing preserves origin edge - we call it AFTER the value changed in the graph
        // Simulate: user changed edge-1's conditional to 0.7, now rebalance siblings
        const graphWithChange = structuredClone(graph);
        const edge1Index = graphWithChange.edges.findIndex((e: any) => e.uuid === 'edge-1');
        graphWithChange.edges[edge1Index].conditional_p[0].p.mean = 0.7;
        
        const result = updateManager.rebalanceConditionalProbabilities(graphWithChange, 'edge-1', 0, true);
        
        // Find edges by uuid
        const resultEdge1 = result.edges.find((e: any) => e.uuid === 'edge-1');
        const resultEdge2 = result.edges.find((e: any) => e.uuid === 'edge-2');
        
        // Origin preserved at new value (0.7)
        expect(resultEdge1.conditional_p[0].p.mean).toBe(0.7);
        
        // Sibling rebalanced despite lock (force mode): gets remaining 0.3
        expect(resultEdge2.conditional_p[0].p.mean).toBeCloseTo(0.3, 10);
        
        // Override flag cleared on sibling
        expect(resultEdge2.conditional_p[0].p.mean_overridden).toBeUndefined();
        
        // PMF sums to 1.0
        const total = resultEdge1.conditional_p[0].p.mean + resultEdge2.conditional_p[0].p.mean;
        expect(total).toBeCloseTo(1.0, 10);
      });
    });
    
    describe('Normal Rebalance', () => {
      it('should respect parameter locks on conditional probabilities', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { mean: 0.3 }
                }
              ]
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { 
                    mean: 0.5,
                    connection: 'amplitude-prod' // ← Locked
                  }
                }
              ]
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { mean: 0.2 }
                }
              ]
            }
          ]
        };
        
        // Change edge-1 to 0.4, should only rebalance edge-3
        const graphWithChange = structuredClone(graph);
        graphWithChange.edges[0].conditional_p[0].p.mean = 0.4;
        
        const result = updateManager.rebalanceConditionalProbabilities(graphWithChange, 'edge-1', 0, false);
        
        // Find edges by uuid
        const resultEdge1 = result.edges.find((e: any) => e.uuid === 'edge-1');
        const resultEdge2 = result.edges.find((e: any) => e.uuid === 'edge-2');
        const resultEdge3 = result.edges.find((e: any) => e.uuid === 'edge-3');
        
        // Origin preserved at new value
        expect(resultEdge1.conditional_p[0].p.mean).toBe(0.4);
        
        // Locked unchanged
        expect(resultEdge2.conditional_p[0].p.mean).toBe(0.5);
        
        // Free edge gets remaining: 1.0 - 0.4 - 0.5 = 0.1
        expect(resultEdge3.conditional_p[0].p.mean).toBeCloseTo(0.1, 10);
        
        // PMF sums to 1.0
        const total = result.edges.reduce((sum, e) => sum + e.conditional_p[0].p.mean, 0);
        expect(total).toBeCloseTo(1.0, 10);
      });
      
      it('should only rebalance same condition (not different contexts)', () => {
        const graph = {
          nodes: [
            { uuid: 'node-a', id: 'node-a' }
          ],
          edges: [
            { 
              uuid: 'edge-1', 
              from: 'node-a', 
              to: 'node-b',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { mean: 0.4 }
                }
              ]
            },
            { 
              uuid: 'edge-2', 
              from: 'node-a', 
              to: 'node-c',
              conditional_p: [
                { 
                  condition: 'context(channel:google)',
                  p: { mean: 0.6 }
                }
              ]
            },
            { 
              uuid: 'edge-3', 
              from: 'node-a', 
              to: 'node-d',
              conditional_p: [
                { 
                  condition: 'context(channel:meta)', // Different condition!
                  p: { mean: 0.5 }
                }
              ]
            }
          ]
        };
        
        // Change edge-1 google condition to 0.7
        const graphWithChange = structuredClone(graph);
        graphWithChange.edges[0].conditional_p[0].p.mean = 0.7;
        
        const result = updateManager.rebalanceConditionalProbabilities(graphWithChange, 'edge-1', 0, false);
        
        // Find edges by uuid
        const resultEdge1 = result.edges.find((e: any) => e.uuid === 'edge-1');
        const resultEdge2 = result.edges.find((e: any) => e.uuid === 'edge-2');
        const resultEdge3 = result.edges.find((e: any) => e.uuid === 'edge-3');
        
        // Origin preserved at new value
        expect(resultEdge1.conditional_p[0].p.mean).toBe(0.7);
        
        // Same condition rebalanced
        expect(resultEdge2.conditional_p[0].p.mean).toBeCloseTo(0.3, 10);
        
        // Different condition unchanged
        expect(resultEdge3.conditional_p[0].p.mean).toBe(0.5);
      });
    });
  });
  
  // ============================================================
  // TEST SUITE 3: Variant Weight Rebalancing
  // ============================================================
  
  describe('rebalanceVariantWeights', () => {
    it('should rebalance variant weights with force', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5, weight_overridden: true },
                { name: 'treatment-a', weight: 0.3 },
                { name: 'treatment-b', weight: 0.2 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Change control to 0.6 and force rebalance
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 0.6;
      
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, true);
      
      // Origin preserved at new weight
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.6);
      
      // Origin variant keeps its override flag (not cleared, origin is preserved)
      expect(result.graph.nodes[0].case.variants[0].weight_overridden).toBe(true);
      
      // Others rebalanced: 0.4 remaining, split 3:2 ratio
      expect(result.graph.nodes[0].case.variants[1].weight).toBeCloseTo(0.24, 10);
      expect(result.graph.nodes[0].case.variants[2].weight).toBeCloseTo(0.16, 10);
      
      // Other variants have override flags cleared
      expect(result.graph.nodes[0].case.variants[1].weight_overridden).toBeUndefined();
      expect(result.graph.nodes[0].case.variants[2].weight_overridden).toBeUndefined();
      
      // PMF sums to 1.0
      const total = result.graph.nodes[0].case.variants.reduce((sum: number, v: any) => sum + v.weight, 0);
      expect(total).toBeCloseTo(1.0, 10);
    });

    it('should respect weight_overridden without force (forceRebalance=false)', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment-a', weight: 0.3, weight_overridden: true },  // Should NOT change
                { name: 'treatment-b', weight: 0.2 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Change control to 0.6
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 0.6;
      
      // Non-force rebalance
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, false);
      
      // Origin preserved at 0.6
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.6);
      
      // Overridden treatment-a stays at 0.3
      expect(result.graph.nodes[0].case.variants[1].weight).toBe(0.3);
      expect(result.graph.nodes[0].case.variants[1].weight_overridden).toBe(true);
      
      // treatment-b gets remaining: 1.0 - 0.6 - 0.3 = 0.1
      expect(result.graph.nodes[0].case.variants[2].weight).toBeCloseTo(0.1, 10);
      
      // Report overridden count
      expect(result.overriddenCount).toBe(1);
    });

    it('should handle 2-variant rebalance (simple A/B test)', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment', weight: 0.5 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Change control to 0.7
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 0.7;
      
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, true);
      
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.7);
      expect(result.graph.nodes[0].case.variants[1].weight).toBeCloseTo(0.3, 10);
      
      // PMF sums to 1.0
      const total = result.graph.nodes[0].case.variants.reduce((sum: number, v: any) => sum + v.weight, 0);
      expect(total).toBeCloseTo(1.0, 10);
    });

    it('should handle origin at 0%', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment-a', weight: 0.3 },
                { name: 'treatment-b', weight: 0.2 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Set control to 0
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 0;
      
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, true);
      
      // Origin stays at 0
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0);
      
      // Others get remaining 1.0, split 3:2
      expect(result.graph.nodes[0].case.variants[1].weight).toBeCloseTo(0.6, 10);
      expect(result.graph.nodes[0].case.variants[2].weight).toBeCloseTo(0.4, 10);
      
      // PMF sums to 1.0
      const total = result.graph.nodes[0].case.variants.reduce((sum: number, v: any) => sum + v.weight, 0);
      expect(total).toBeCloseTo(1.0, 10);
    });

    it('should handle origin at 100%', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment-a', weight: 0.3 },
                { name: 'treatment-b', weight: 0.2 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Set control to 1.0 (100%)
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 1.0;
      
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, true);
      
      // Origin stays at 1.0
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(1.0);
      
      // Others get 0
      expect(result.graph.nodes[0].case.variants[1].weight).toBe(0);
      expect(result.graph.nodes[0].case.variants[2].weight).toBe(0);
      
      // PMF sums to 1.0
      const total = result.graph.nodes[0].case.variants.reduce((sum: number, v: any) => sum + v.weight, 0);
      expect(total).toBeCloseTo(1.0, 10);
    });

    it('should handle all other variants having weight_overridden (skip rebalance)', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment-a', weight: 0.3, weight_overridden: true },
                { name: 'treatment-b', weight: 0.2, weight_overridden: true }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Change control to 0.6 (but others are all overridden)
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 0.6;
      
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, false);
      
      // Origin at 0.6
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.6);
      
      // Others unchanged (all overridden)
      expect(result.graph.nodes[0].case.variants[1].weight).toBe(0.3);
      expect(result.graph.nodes[0].case.variants[2].weight).toBe(0.2);
      
      // Report both as overridden
      expect(result.overriddenCount).toBe(2);
      
      // Note: PMF will NOT sum to 1.0 in this case (1.1) - this is expected
      // when user overrides cause invalid state
    });

    it('should handle case node not found', () => {
      const graph = {
        nodes: [
          { uuid: 'other-node', type: 'normal' }
        ],
        edges: []
      };
      
      const result = updateManager.rebalanceVariantWeights(graph, 'nonexistent-case', 0, true);
      
      // Should return unchanged graph
      expect(result.graph).toEqual(graph);
      expect(result.overriddenCount).toBe(0);
    });

    it('should handle invalid variant index', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.5 },
                { name: 'treatment', weight: 0.5 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Invalid index (out of bounds)
      const result = updateManager.rebalanceVariantWeights(graph, 'case-node-1', 99, true);
      
      // Should return unchanged graph
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.5);
      expect(result.graph.nodes[0].case.variants[1].weight).toBe(0.5);
    });

    it('should maintain precision for small weights', () => {
      const graph = {
        nodes: [
          { 
            uuid: 'case-node-1',
            type: 'case',
            case: {
              variants: [
                { name: 'control', weight: 0.01 },
                { name: 'treatment-a', weight: 0.495 },
                { name: 'treatment-b', weight: 0.495 }
              ]
            }
          }
        ],
        edges: []
      };
      
      // Change control to 0.02
      const graphWithChange = structuredClone(graph);
      graphWithChange.nodes[0].case.variants[0].weight = 0.02;
      
      const result = updateManager.rebalanceVariantWeights(graphWithChange, 'case-node-1', 0, true);
      
      // Origin at 0.02
      expect(result.graph.nodes[0].case.variants[0].weight).toBe(0.02);
      
      // Others split 0.98 equally (0.49 each)
      expect(result.graph.nodes[0].case.variants[1].weight).toBeCloseTo(0.49, 10);
      expect(result.graph.nodes[0].case.variants[2].weight).toBeCloseTo(0.49, 10);
      
      // PMF sums to 1.0
      const total = result.graph.nodes[0].case.variants.reduce((sum: number, v: any) => sum + v.weight, 0);
      expect(total).toBeCloseTo(1.0, 10);
    });
  });
});

