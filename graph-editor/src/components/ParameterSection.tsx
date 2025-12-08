import React, { useState, useEffect } from 'react';
import { Info } from 'lucide-react';
import { EnhancedSelector } from './EnhancedSelector';
import { ConnectionControl } from './ConnectionControl';
import ProbabilityInput from './ProbabilityInput';
import { AutomatableField } from './AutomatableField';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { GraphData } from '../types';
import { useTabContext } from '../contexts/TabContext';
import { dataOperationsService } from '../services/dataOperationsService';
import { useGraphStore } from '../contexts/GraphStoreContext';
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
  };
  
  // Handlers
  onUpdate: (changes: Record<string, any>) => void;
  onRebalance?: () => void;  // Optional rebalancing for probabilities (no value param - uses current graph value)
  
  // Display config
  label: string;  // e.g., "Probability", "Cost (GBP)", "Cost (Time)"
  showQueryEditor?: boolean;  // Default true
  showStdev?: boolean;  // Default true
  showDistribution?: boolean;  // Default true
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
  showBalanceButton = false,
  isUnbalanced = false,
  disabled = false
}: ParameterSectionProps) {
  const { tabs, operations: tabOps } = useTabContext();
  const { graph: currentGraph, setGraph } = useGraphStore();
  
  // Local state for immediate input feedback
  const [localQuery, setLocalQuery] = useState(param?.query || '');
  // Note: isSettingsModalOpen state moved into ConnectionControl component
  
  // Sync local state when param changes externally
  useEffect(() => {
    setLocalQuery(param?.query || '');
  }, [param?.query]);
  
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
    
    // Call putParameterToFile to copy all edge data to the new file
    // This includes connection settings, mean, stdev, distribution, etc.
    await dataOperationsService.putParameterToFile({
      paramId,
      edgeId: objectId,
      graph: currentGraph,
      setGraph: setGraphWrapper
    });
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
                value={param?.stdev !== undefined ? param.stdev : ''}
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

