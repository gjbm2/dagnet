import React, { useState, useEffect } from 'react';
import { Info, Clock } from 'lucide-react';
import { EnhancedSelector } from './EnhancedSelector';
import { ConnectionControl } from './ConnectionControl';
import ProbabilityInput from './ProbabilityInput';
import { AutomatableField } from './AutomatableField';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { GraphData, LatencyConfig } from '../types';
import { useTabContext } from '../contexts/TabContext';
import { dataOperationsService } from '../services/dataOperationsService';
import { useGraphStore } from '../contexts/GraphStoreContext';
import { LATENCY_HORIZON_DECIMAL_PLACES } from '../constants/latency';
import { PRECISION_DECIMAL_PLACES } from '../constants/latency';
import { roundToDecimalPlaces } from '../utils/rounding';
import './ParameterSection.css';

interface ParameterSectionProps {
  // Context
  graph: GraphData;
  objectType: 'edge' | 'node';  // For future extensibility
  objectId: string;
  
  // Parameter slot ('p', 'cost_gbp', 'labour_cost')
  paramSlot: 'p' | 'cost_gbp' | 'labour_cost';
  
  // For conditional probabilities: which index in conditional_p array
  conditionalIndex?: number;
  
  // Current parameter data
  param?: {
    id?: string;
    connection?: string;
    connection_string?: string;
    connection_overridden?: boolean;
    mean?: number;
    stdev?: number;
    distribution?: string;
    query?: string;
    mean_overridden?: boolean;
    stdev_overridden?: boolean;
    distribution_overridden?: boolean;
    query_overridden?: boolean;
    // Latency tracking (probability params only)
    latency?: LatencyConfig;
    // Forecast from mature cohorts (display only)
    forecast?: {
      mean?: number;
      stdev?: number;
    };
  };
  
  // Handlers
  onUpdate: (changes: Record<string, any>) => void;
  onRebalance?: () => void;  // Optional rebalancing for probabilities (no value param - uses current graph value)
  
  // Display config
  label: string;  // e.g., "Probability", "Cost (GBP)", "Cost (Time)"
  showQueryEditor?: boolean;  // Default true
  showStdev?: boolean;  // Default true
  showDistribution?: boolean;  // Default true
  showLatency?: boolean;  // Default true for probability, false for cost
  showBalanceButton?: boolean;  // Default false (true for conditional p)
  isUnbalanced?: boolean;  // Show balance button as highlighted
  
  // Optional overrides
  disabled?: boolean;
}

/**
 * ParameterSection - Generalized component for parameter (probability/cost) UI
 * 
 * Encapsulates:
 * - EnhancedSelector for connection
 * - Mean value input (slider/number)
 * - Query expression editor
 * - Stdev input
 * - Distribution dropdown
 * - All AutomatableField wrappers
 * - Override flags management
 */
export function ParameterSection({
  graph,
  objectType,
  objectId,
  paramSlot,
  conditionalIndex,
  param,
  onUpdate,
  onRebalance,
  label,
  showQueryEditor = true,
  showStdev = true,
  showDistribution = true,
  showLatency = paramSlot === 'p',  // Default true for probability, false for cost
  showBalanceButton = false,
  isUnbalanced = false,
  disabled = false
}: ParameterSectionProps) {
  const { tabs, operations: tabOps } = useTabContext();
  const { graph: currentGraph, setGraph } = useGraphStore();

  const formatOptionalNumber = (value: number | undefined, dp: number): string => {
    if (value === undefined) return '';
    return String(roundToDecimalPlaces(value, dp));
  };
  
  // Local state for immediate input feedback
  const [localQuery, setLocalQuery] = useState(param?.query || '');
  const [localT95, setLocalT95] = useState<string>(
    formatOptionalNumber(param?.latency?.t95, LATENCY_HORIZON_DECIMAL_PLACES)
  );
  const [localPathT95, setLocalPathT95] = useState<string>(
    formatOptionalNumber(param?.latency?.path_t95, LATENCY_HORIZON_DECIMAL_PLACES)
  );
  // Note: isSettingsModalOpen state moved into ConnectionControl component
  
  // Sync local state when param changes externally
  useEffect(() => {
    setLocalQuery(param?.query || '');
  }, [param?.query]);
  
  useEffect(() => {
    setLocalT95(formatOptionalNumber(param?.latency?.t95, LATENCY_HORIZON_DECIMAL_PLACES));
  }, [param?.latency?.t95]);
  
  useEffect(() => {
    setLocalPathT95(formatOptionalNumber(param?.latency?.path_t95, LATENCY_HORIZON_DECIMAL_PLACES));
  }, [param?.latency?.path_t95]);
  
  // Callback to initialize a newly created parameter file from current edge data
  const handleCreateAndInitialize = async (paramId: string) => {
    if (objectType !== 'edge' || !currentGraph) {
      console.warn('[ParameterSection] Cannot initialize file: not in edge context or no graph');
      return;
    }
    
    console.log('[ParameterSection] Initializing new parameter file from edge data:', {
      paramId,
      edgeId: objectId,
      paramSlot
    });
    
    // Wrap setGraph to handle null (putParameterToFile expects a function that accepts null)
    const setGraphWrapper = (graph: GraphData | null) => {
      if (graph !== null) {
        setGraph(graph);
      }
    };
    
    // Open the same modal used for batch operations, but with a single target.
    // This lets the user choose whether to copy values/metadata/permissions.
    globalThis.window.dispatchEvent(new CustomEvent('dagnet:openBatchOperationsModal', {
      detail: {
        operationType: 'put-to-files',
        singleTarget: {
          type: 'parameter',
          objectId: paramId,
          targetId: objectId,
          paramSlot,
          conditionalIndex,
        },
      },
    }));
  };
  
  return (
    <div style={{ marginBottom: '20px' }}>
      {/* Parameter ID Selector */}
      <EnhancedSelector
        type="parameter"
        parameterType={paramSlot === 'p' ? 'probability' : paramSlot}
        value={param?.id || ''}
        targetInstanceUuid={objectId}
        paramSlot={paramSlot}
        conditionalIndex={conditionalIndex}
        onChange={(newParamId) => {
          if (!newParamId) {
            onUpdate({ id: undefined });
          } else {
            onUpdate({ id: newParamId });
          }
        }}
        onCreateAndInitialize={handleCreateAndInitialize}
        onOpenConnected={() => {
          const id = param?.id;
          if (!id) return;

          const fileId = `parameter-${id}`;
          const existingTab = tabs.find(tab => tab.fileId === fileId);

          if (existingTab) {
            tabOps.switchTab(existingTab.id);
          } else {
            tabOps.openTab(
              {
                id,
                type: 'parameter',
                name: id,
                path: `parameter/${id}`,
              } as any,
              'interactive',
              false
            );
          }
        }}
        onOpenItem={(itemId) => {
          if (!itemId) return;

          const fileId = `parameter-${itemId}`;
          const existingTab = tabs.find(tab => tab.fileId === fileId);

          if (existingTab) {
            tabOps.switchTab(existingTab.id);
          } else {
            tabOps.openTab(
              {
                id: itemId,
                type: 'parameter',
                name: itemId,
                path: `parameter/${itemId}`,
              } as any,
              'interactive',
              false
            );
          }
        }}
        disabled={disabled}
        label=""
        placeholder={`Select or enter ${label.toLowerCase()} parameter ID...`}
      />
      
      {/* External Data Connection Section */}
      <div style={{ marginTop: '16px', marginBottom: '16px', paddingTop: '16px', borderTop: '1px solid #E5E7EB' }}>
        <ConnectionControl
          connection={param?.connection}
          connectionString={param?.connection_string}
          overriddenFlag={param?.connection_overridden}
          onConnectionChange={(connectionName) => {
                  onUpdate({ connection: connectionName, connection_overridden: true });
                }}
          onConnectionStringChange={(connectionString, newConnectionName) => {
          onUpdate({ 
            connection_string: connectionString,
            connection: newConnectionName || param?.connection,
            connection_overridden: true
          });
        }}
          onOverriddenChange={(overridden) => {
            onUpdate({ connection_overridden: overridden });
          }}
          label="External Data Source"
          disabled={disabled}
      />
      </div>
      
      {/* Mean Value (Probability slider OR Cost input) */}
      <div style={{ marginBottom: '20px' }}>
        <AutomatableField
          label=""
          value={param?.mean ?? 0}
          overridden={param?.mean_overridden || false}
          onClearOverride={() => {
            onUpdate({ mean_overridden: false });
          }}
        >
          {paramSlot === 'p' ? (
            // Probability: Show slider without label (obvious what it is)
            <ProbabilityInput
              value={param?.mean ?? 0}
              onChange={(newValue) => {
                // Update graph immediately while dragging (provides real-time feedback)
                // NO history entry - only visual update
                onUpdate({ mean: newValue, mean_overridden: true, _noHistory: true });
              }}
              onCommit={(newValue) => {
                // Commit is called on mouse release - THIS creates the history entry
                onUpdate({ mean: newValue, mean_overridden: true });
              }}
              onRebalance={onRebalance ? async () => {
                // Ignore value from ProbabilityInput - handler uses current graph value
                if (onRebalance) {
                  await onRebalance();
                }
              } : undefined}
              isUnbalanced={isUnbalanced}
              showBalanceButton={showBalanceButton}
              disabled={disabled}
              min={0}
              max={1}
              step={0.01}
            />
          ) : (
            // Cost: Show number input with inline label
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <label className="parameter-section-label">
                {paramSlot === 'cost_gbp' ? '£ cost' : 'Time cost'}
              </label>
              <input
                type="number"
                min="0"
                step={paramSlot === 'cost_gbp' ? '0.01' : '1'}
                value={param?.mean !== undefined ? param.mean : ''}
                onChange={(e) => {
                  const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                  onUpdate({ mean: value });
                }}
                onBlur={() => {
                  onUpdate({ mean_overridden: true });
                }}
                placeholder={paramSlot === 'labour_cost' ? '120' : '0.00'}
                title={paramSlot === 'labour_cost' ? 'Enter minutes (future: 2d, 10m formats)' : 'Enter cost in £'}
                disabled={disabled}
                className="parameter-input"
              />
            </div>
          )}
        </AutomatableField>
      </div>
      
      {/* Standard Deviation and Distribution - separate lines */}
      
      {/* Std Dev */}
      {showStdev && (
        <div style={{ marginBottom: '16px' }}>
          <AutomatableField
            label=""
            value={param?.stdev || ''}
            overridden={param?.stdev_overridden || false}
            onClearOverride={() => {
              onUpdate({ stdev_overridden: false });
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <label className="parameter-section-label">Std Dev</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={param?.stdev !== undefined ? roundToDecimalPlaces(param.stdev, PRECISION_DECIMAL_PLACES) : ''}
                onChange={(e) => {
                  const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                  onUpdate({ stdev: value });
                }}
                onBlur={() => {
                  onUpdate({ stdev_overridden: true });
                }}
                placeholder="Optional"
                disabled={disabled}
                className="parameter-input"
              />
            </div>
          </AutomatableField>
        </div>
      )}
      
      {/* Distribution */}
      {showDistribution && (
        <div style={{ marginBottom: '16px' }}>
          <AutomatableField
            label=""
            value={param?.distribution || 'beta'}
            overridden={param?.distribution_overridden || false}
            onClearOverride={() => {
              onUpdate({ distribution_overridden: false });
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <label className="parameter-section-label">Distribution</label>
              <select
                value={param?.distribution || 'beta'}
                onChange={(e) => {
                  onUpdate({ distribution: e.target.value, distribution_overridden: true });
                }}
                disabled={disabled}
                className="parameter-input"
              >
                <option value="beta">Beta</option>
                <option value="normal">Normal</option>
                <option value="lognormal">Log-Normal</option>
                <option value="gamma">Gamma</option>
                <option value="uniform">Uniform</option>
              </select>
            </div>
          </AutomatableField>
        </div>
      )}
      
      {/* Latency Tracking (probability params only) */}
      {showLatency && (
        <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Enable Latency checkbox with override toggle */}
          <AutomatableField
            label=""
            labelExtra={
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  id={`latency-track-${objectId}-${paramSlot}`}
                  checked={param?.latency?.latency_parameter === true}
                  onChange={(e) => {
                    const trackLatency = e.target.checked;
                    onUpdate({
                      latency: {
                        ...param?.latency,
                        latency_parameter: trackLatency,
                        latency_parameter_overridden: true,
                      }
                    });
                  }}
                  disabled={disabled}
                  style={{ width: '14px', height: '14px', cursor: 'pointer', flexShrink: 0 }}
                />
                <label 
                  htmlFor={`latency-track-${objectId}-${paramSlot}`}
                  style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: '#333', whiteSpace: 'nowrap' }}
                >
                  Latency Tracking
                </label>
                <span title="Enable latency tracking to forecast conversions for immature cohorts. When enabled, uses cohort-based queries to measure conversion lag.">
                  <Info size={14} style={{ color: '#9CA3AF', cursor: 'help' }} />
                </span>
              </div>
            }
            layout="label-above"
            value={param?.latency?.latency_parameter ?? false}
            overridden={param?.latency?.latency_parameter_overridden || false}
            onClearOverride={() => {
              onUpdate({ 
                latency: { 
                  ...param?.latency,
                  latency_parameter_overridden: false 
                } 
              });
            }}
          >
            <div style={{ display: 'none' }} />
          </AutomatableField>
          
          {/* t95 and path_t95 fields (only shown when latency tracking is enabled) */}
          {(param?.latency?.latency_parameter === true) && (
            <>
              {/* Edge t95 */}
              <AutomatableField
                label=""
                value={param?.latency?.t95 ?? ''}
                overridden={param?.latency?.t95_overridden || false}
                onClearOverride={() => {
                  onUpdate({ 
                    latency: { 
                      ...param?.latency,
                      t95_overridden: false 
                    } 
                  });
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label className="parameter-section-label" style={{ minWidth: '65px' }}>Edge t95</label>
                  <input
                    type="number"
                    value={localT95}
                    onChange={(e) => setLocalT95(e.target.value)}
                    onBlur={() => {
                      const value = parseFloat(localT95);
                      const t95Raw = isNaN(value) || value < 0 ? undefined : value;
                      const t95 =
                        t95Raw === undefined
                          ? undefined
                          : roundToDecimalPlaces(t95Raw, LATENCY_HORIZON_DECIMAL_PLACES);
                      setLocalT95(t95 === undefined ? '' : String(t95));
                      onUpdate({
                        latency: {
                          ...param?.latency,
                          t95,
                          t95_overridden: true,
                        }
                      });
                    }}
                    min={0}
                    step={0.01}
                    disabled={disabled}
                    className="parameter-input"
                    style={{ width: '70px' }}
                    placeholder="(computed)"
                    title="95th percentile lag in days for this edge (computed from historical data or set manually)"
                  />
                  <span style={{ fontSize: '12px', color: '#6B7280' }}>days</span>
                </div>
              </AutomatableField>
              
              {/* Path t95 */}
              <AutomatableField
                label=""
                value={param?.latency?.path_t95 ?? ''}
                overridden={param?.latency?.path_t95_overridden || false}
                onClearOverride={() => {
                  onUpdate({ 
                    latency: { 
                      ...param?.latency,
                      path_t95_overridden: false 
                    } 
                  });
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label className="parameter-section-label" style={{ minWidth: '65px' }}>Path t95</label>
                  <input
                    type="number"
                    value={localPathT95}
                    onChange={(e) => setLocalPathT95(e.target.value)}
                    onBlur={() => {
                      const value = parseFloat(localPathT95);
                      const pathT95Raw = isNaN(value) || value < 0 ? undefined : value;
                      const path_t95 =
                        pathT95Raw === undefined
                          ? undefined
                          : roundToDecimalPlaces(pathT95Raw, LATENCY_HORIZON_DECIMAL_PLACES);
                      setLocalPathT95(path_t95 === undefined ? '' : String(path_t95));
                      onUpdate({
                        latency: {
                          ...param?.latency,
                          path_t95,
                          path_t95_overridden: true,
                        }
                      });
                    }}
                    min={0}
                    step={0.01}
                    disabled={disabled}
                    className="parameter-input"
                    style={{ width: '70px' }}
                    placeholder="(computed)"
                    title="Cumulative path latency from anchor to this edge (computed from topo pass or set manually)"
                  />
                  <span style={{ fontSize: '12px', color: '#6B7280' }}>days</span>
                </div>
              </AutomatableField>
            </>
          )}
          
          {/* Anchor Node (only shown when latency tracking is enabled) */}
          {(param?.latency?.latency_parameter === true) && (
            <AutomatableField
              label=""
              value={param?.latency?.anchor_node_id || ''}
              overridden={param?.latency?.anchor_node_id_overridden || false}
              onClearOverride={() => {
                onUpdate({ 
                  latency: { 
                    ...param?.latency,
                    anchor_node_id_overridden: false 
                  } 
                });
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label className="parameter-section-label">Cohort anchor</label>
                <input
                  type="text"
                  value={param?.latency?.anchor_node_id || ''}
                  onChange={(e) => {
                    onUpdate({
                      latency: {
                        ...param?.latency,
                        anchor_node_id: e.target.value || undefined,
                      }
                    });
                  }}
                  onBlur={() => {
                    onUpdate({
                      latency: {
                        ...param?.latency,
                        anchor_node_id_overridden: true,
                      }
                    });
                  }}
                  disabled={disabled}
                  className="parameter-input"
                  placeholder="(auto)"
                  title="Cohort entry point for this edge. Defaults to furthest upstream START node."
                />
              </div>
            </AutomatableField>
          )}
        </div>
      )}
      
      {/* Query Expression Editor (at bottom - usually auto-generated) */}
      {showQueryEditor && (
        <div style={{ marginTop: '20px', marginBottom: '0px' }}>
          <AutomatableField
            label="Data Retrieval Query"
            labelExtra={
              <span title="Query expression for retrieving data from external sources. Usually auto-generated by MSMDC algorithm from graph topology. Can be manually edited if needed.">
                <Info 
                  size={14} 
                  style={{ color: '#9CA3AF', cursor: 'help' }}
                />
              </span>
            }
            layout="label-above"
            value={param?.query || ''}
            overridden={param?.query_overridden || false}
            onClearOverride={() => {
              onUpdate({ query: '', query_overridden: false });
            }}
          >
            <QueryExpressionEditor
              value={param?.query || ''}
              onChange={(newQuery) => {
                setLocalQuery(newQuery);
              }}
              onBlur={() => {
                onUpdate({ query: localQuery, query_overridden: true });
              }}
              graph={graph}
              edgeId={objectType === 'edge' ? objectId : undefined}
              placeholder="from(node).to(node).exclude(...)"
              height="60px"
            />
          </AutomatableField>
        </div>
      )}
    </div>
  );
}

