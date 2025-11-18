/**
 * ConnectionControl Component
 * 
 * Reusable component for connection dropdown + settings modal pattern.
 * Used for both parameters and cases, with AutomatableField wrapper.
 * 
 * Pattern extracted from ParameterSection.tsx to ensure consistency
 * across all connection UI instances.
 */

import React, { useState } from 'react';
import { Database } from 'lucide-react';
import { ConnectionSelector } from './ConnectionSelector';
import { ConnectionSettingsModal } from './ConnectionSettingsModal';
import { AutomatableField } from './AutomatableField';

interface ConnectionControlProps {
  // Data
  connection?: string;
  connectionString?: string;
  overriddenFlag?: boolean;
  
  // Callbacks
  onConnectionChange: (connection: string | undefined) => void;
  onConnectionStringChange: (connectionString: string | undefined, newConnectionName?: string) => void;
  onOverriddenChange?: (overridden: boolean) => void;
  
  // Display options
  label?: string;
  hideOverride?: boolean;
  disabled?: boolean;
}

/**
 * ConnectionControl - Reusable connection UI
 * 
 * Features:
 * - Database icon button to open settings modal
 * - Connection dropdown (ConnectionSelector)
 * - Settings modal for connection_string configuration
 * - AutomatableField wrapper for override flags (optional)
 * 
 * Usage:
 * ```tsx
 * <ConnectionControl
 *   connection={param?.connection}
 *   connectionString={param?.connection_string}
 *   overriddenFlag={param?.connection_overridden}
 *   onConnectionChange={(conn) => onUpdate({ connection: conn })}
 *   onConnectionStringChange={(str, name) => onUpdate({ connection_string: str, connection: name })}
 *   onOverriddenChange={(flag) => onUpdate({ connection_overridden: flag })}
 * />
 * ```
 */
export function ConnectionControl({
  connection,
  connectionString,
  overriddenFlag = false,
  onConnectionChange,
  onConnectionStringChange,
  onOverriddenChange,
  label = "Data Connection",
  hideOverride = false,
  disabled = false
}: ConnectionControlProps) {
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  
  const connectionUI = (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      {/* Connection Settings Button */}
      <button
        className="icon-button"
        onClick={() => setIsSettingsModalOpen(true)}
        title="Connection Settings"
        disabled={disabled}
        style={{
          cursor: disabled ? 'not-allowed' : 'pointer',
          border: '1px solid #D1D5DB',
          borderRadius: '6px',
          background: 'white',
          color: connection ? '#374151' : '#6B7280',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          transition: 'all 0.2s',
          flexShrink: 0,
          height: '28px',
          width: '28px',
          margin: 0,
          opacity: disabled ? 0.5 : 1
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
            e.currentTarget.style.color = connection ? '#374151' : '#6B7280';
          }
        }}
      >
        <Database size={16} />
      </button>
      
      {/* Connection Dropdown */}
      <div style={{ flex: '1 1 0', minWidth: 0, margin: 0 }}>
        <ConnectionSelector
          value={connection}
          onChange={onConnectionChange}
          hideLabel={true}
          disabled={disabled}
        />
      </div>
    </div>
  );
  
  return (
    <>
      {hideOverride ? (
        /* Cases: No override flags, just render with a simple label */
        <div style={{ marginBottom: '20px' }}>
          <label style={{ 
            display: 'block',
            fontSize: '12px', 
            fontWeight: '600', 
            color: '#6B7280',
            marginBottom: '8px'
          }}>
            {label}
          </label>
          {connectionUI}
        </div>
      ) : (
        /* Parameters: Use AutomatableField for override flags */
        <AutomatableField
          label={label}
          value={connection || ''}
          overridden={overriddenFlag}
          onClearOverride={() => {
            if (onOverriddenChange) {
              onOverriddenChange(false);
            }
          }}
          disabled={disabled}
        >
          {connectionUI}
        </AutomatableField>
      )}
      
      {/* Connection Settings Modal */}
      <ConnectionSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        connectionName={connection}
        currentConnectionString={connectionString}
        onSave={(newConnectionString, newConnectionName) => {
          onConnectionStringChange(newConnectionString, newConnectionName);
          setIsSettingsModalOpen(false);
        }}
      />
    </>
  );
}

