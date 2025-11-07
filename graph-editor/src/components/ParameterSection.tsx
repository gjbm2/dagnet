import React, { useState } from 'react';
import { Info } from 'lucide-react';
import { EnhancedSelector } from './EnhancedSelector';
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
  
  return (
    <div style={{ marginBottom: '20px' }}>
      {/* Connection Selector */}
      <EnhancedSelector
        type="parameter"
        parameterType={paramSlot === 'p' ? 'probability' : paramSlot}
        value={param?.id || ''}
        targetInstanceUuid={objectId}
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
      
      {/* Query Expression Editor */}
      {showQueryEditor && (
        <div style={{ marginTop: '16px', marginBottom: '16px' }}>
          <AutomatableField
            label={`${label} Query`}
            labelExtra={
              <span title="Define constraints for retrieving data from external sources. Uses node IDs to specify path constraints.">
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
                // Optional: Update local state
              }}
              onCommit={(newValue) => {
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
    </div>
  );
}

