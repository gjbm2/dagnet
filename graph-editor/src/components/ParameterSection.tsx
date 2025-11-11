import React, { useState, useEffect } from 'react';
import { Info, Database } from 'lucide-react';
import { EnhancedSelector } from './EnhancedSelector';
import { ConnectionSelector } from './ConnectionSelector';
import { ConnectionSettingsModal } from './ConnectionSettingsModal';
import ProbabilityInput from './ProbabilityInput';
import { AutomatableField } from './AutomatableField';
import { QueryExpressionEditor } from './QueryExpressionEditor';
import { GraphData } from '../types';
import './ParameterSection.css';

interface ParameterSectionProps {
  // Context
  graph: GraphData;
  objectType: 'edge' | 'node';  // For future extensibility
  objectId: string;
  
  // Parameter slot ('p', 'cost_gbp', 'cost_time')
  paramSlot: 'p' | 'cost_gbp' | 'cost_time';
  
  // Current parameter data
  param?: {
    id?: string;
    connection?: string;
    connection_string?: string;
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
  onRebalance?: (newValue: number) => void;  // Optional rebalancing for probabilities
  
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
  // Local state for immediate input feedback
  const [localQuery, setLocalQuery] = useState(param?.query || '');
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  
  // Sync local state when param changes externally
  useEffect(() => {
    setLocalQuery(param?.query || '');
  }, [param?.query]);
  
  return (
    <div style={{ marginBottom: '20px' }}>
      {/* Parameter ID Selector */}
      <EnhancedSelector
        type="parameter"
        parameterType={paramSlot === 'p' ? 'probability' : paramSlot}
        value={param?.id || ''}
        targetInstanceUuid={objectId}
        paramSlot={paramSlot}
        onChange={(newParamId) => {
          if (!newParamId) {
            onUpdate({ id: undefined });
          } else {
            onUpdate({ id: newParamId });
          }
        }}
        disabled={disabled}
        label=""
        placeholder={`Select or enter ${label.toLowerCase()} parameter ID...`}
      />
      
      {/* External Data Connection Section */}
      <div style={{ marginTop: '16px', marginBottom: '16px', paddingTop: '16px', borderTop: '1px solid #E5E7EB' }}>
        <AutomatableField
          label="External Data Source"
          value={param?.connection || ''}
          overridden={false}
          onClearOverride={() => {
            // Connection override not yet implemented
          }}
        >
          {/* Connection Controls Row */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '8px', 
            width: '100%',
            flex: '1 1 auto',
            minWidth: 0
          }}>
            {/* Database Icon Button */}
            <button
              type="button"
              onClick={() => setIsSettingsModalOpen(true)}
              disabled={disabled}
              title="Edit connection and settings"
              style={{
                padding: '6px',
                background: 'white',
                border: '1px solid #D1D5DB',
                borderRadius: '6px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: param?.connection ? '#374151' : '#6B7280',
                transition: 'all 0.2s',
                flexShrink: 0,
                height: '28px',
                width: '28px',
                margin: 0
              }}
              onMouseEnter={(e) => {
                if (!disabled) {
                  e.currentTarget.style.background = '#F9FAFB';
                  e.currentTarget.style.borderColor = '#9CA3AF';
                  e.currentTarget.style.color = '#374151';
                }
              }}
              onMouseLeave={(e) => {
                if (!disabled) {
                  e.currentTarget.style.background = 'white';
                  e.currentTarget.style.borderColor = '#D1D5DB';
                  e.currentTarget.style.color = param?.connection ? '#374151' : '#6B7280';
                }
              }}
            >
              <Database size={16} />
            </button>
            
            {/* Connection Dropdown */}
            <div style={{ flex: '1 1 0', minWidth: 0, margin: 0 }}>
              <ConnectionSelector
                value={param?.connection}
                onChange={(connectionName) => {
                  onUpdate({ connection: connectionName, connection_overridden: true });
                }}
                hideLabel={true}
                disabled={disabled}
              />
            </div>
          </div>
        </AutomatableField>
      </div>
      
      {/* Connection Settings Modal */}
      <ConnectionSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        connectionName={param?.connection}
        currentConnectionString={param?.connection_string}
        onSave={(connectionString, newConnectionName) => {
          onUpdate({ 
            connection_string: connectionString,
            connection: newConnectionName || param?.connection,
            connection_overridden: true
          });
        }}
      />
      
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
                onUpdate({ mean: newValue, mean_overridden: true });
              }}
              onCommit={(newValue) => {
                // Commit is called on mouse release (same update, just ensures consistency)
                onUpdate({ mean: newValue, mean_overridden: true });
              }}
              onRebalance={onRebalance}
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
                placeholder={paramSlot === 'cost_time' ? '120' : '0.00'}
                title={paramSlot === 'cost_time' ? 'Enter minutes (future: 2d, 10m formats)' : 'Enter cost in £'}
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

