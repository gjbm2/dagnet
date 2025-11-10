import React, { useState, useEffect } from 'react';
import { X, Settings } from 'lucide-react';
import { IndexedDBConnectionProvider } from '../lib/das/IndexedDBConnectionProvider';
import { ConnectionSelector } from './ConnectionSelector';
import type { ConnectionDefinition } from '../lib/das/types';
import './ConnectionSettingsModal.css';

interface ConnectionSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  connectionName: string | undefined;
  currentConnectionString: string | undefined; // JSON string
  onSave: (connectionString: string | undefined, connectionName?: string) => void;
}

/**
 * ConnectionSettingsModal - Dynamically generates form fields from connection_string_schema
 * 
 * When a connection is selected, loads the connection definition and generates
 * form fields based on connection_string_schema (JSON Schema).
 */
export function ConnectionSettingsModal({
  isOpen,
  onClose,
  connectionName,
  currentConnectionString,
  onSave
}: ConnectionSettingsModalProps) {
  const [connection, setConnection] = useState<ConnectionDefinition | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedConnectionName, setSelectedConnectionName] = useState<string | undefined>(connectionName);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Sync selected connection name when prop changes
  useEffect(() => {
    if (isOpen) {
      setSelectedConnectionName(connectionName);
    } else {
      setConnection(null);
      setFormData({});
      setErrors({});
      setSelectedConnectionName(undefined);
    }
  }, [isOpen, connectionName]);

  // Load connection definition when selected connection changes
  useEffect(() => {
    if (isOpen && selectedConnectionName) {
      loadConnection();
    } else {
      setConnection(null);
      setFormData({});
      setErrors({});
    }
  }, [isOpen, selectedConnectionName]);

  // Parse current connection_string into form data when connection matches
  useEffect(() => {
    // Only parse if the connection_string is for the currently selected connection
    if (currentConnectionString && connection && selectedConnectionName === connectionName) {
      try {
        const parsed = JSON.parse(currentConnectionString);
        setFormData(parsed);
      } catch {
        // Invalid JSON - start with empty form
        setFormData({});
      }
    } else if (connection && selectedConnectionName !== connectionName) {
      // Connection changed in modal - clear form data
      setFormData({});
    } else if (!connection) {
      setFormData({});
    }
  }, [currentConnectionString, connection, selectedConnectionName, connectionName]);

  async function loadConnection() {
    if (!selectedConnectionName) return;
    
    setLoading(true);
    try {
      const provider = new IndexedDBConnectionProvider();
      const conn = await provider.getConnection(selectedConnectionName);
      setConnection(conn);
    } catch (error) {
      console.error('Failed to load connection:', error);
      setConnection(null);
    } finally {
      setLoading(false);
    }
  }

  function handleFieldChange(fieldName: string, value: any) {
    setFormData(prev => ({
      ...prev,
      [fieldName]: value === '' ? undefined : value
    }));
    // Clear error for this field
    if (errors[fieldName]) {
      setErrors(prev => {
        const next = { ...prev };
        delete next[fieldName];
        return next;
      });
    }
  }

  function validateForm(): boolean {
    if (!connection?.connection_string_schema) {
      return true; // No schema = no validation needed
    }

    const schema = connection.connection_string_schema;
    const required = schema.required || [];
    const newErrors: Record<string, string> = {};

    // Check required fields
    for (const fieldName of required) {
      if (formData[fieldName] === undefined || formData[fieldName] === '') {
        newErrors[fieldName] = 'This field is required';
      }
    }

    // Type validation
    if (schema.properties) {
      for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
        const value = formData[fieldName];
        if (value === undefined) continue; // Optional fields can be undefined

        const fieldDef = fieldSchema as any;
        if (fieldDef.type === 'number' && typeof value !== 'number') {
          const parsed = parseFloat(value);
          if (isNaN(parsed)) {
            newErrors[fieldName] = 'Must be a number';
          } else {
            formData[fieldName] = parsed; // Auto-correct
          }
        } else if (fieldDef.type === 'integer' && typeof value !== 'number') {
          const parsed = parseInt(value, 10);
          if (isNaN(parsed)) {
            newErrors[fieldName] = 'Must be an integer';
          } else {
            formData[fieldName] = parsed; // Auto-correct
          }
        } else if (fieldDef.type === 'boolean' && typeof value !== 'boolean') {
          // Convert string to boolean
          if (value === 'true' || value === true) {
            formData[fieldName] = true;
          } else if (value === 'false' || value === false) {
            formData[fieldName] = false;
          } else {
            newErrors[fieldName] = 'Must be true or false';
          }
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleSave() {
    if (!validateForm()) {
      return;
    }

    // Remove undefined values
    const cleaned = Object.fromEntries(
      Object.entries(formData).filter(([_, v]) => v !== undefined)
    );

    // If empty, save undefined (no connection_string)
    const connectionString = Object.keys(cleaned).length === 0 
      ? undefined 
      : JSON.stringify(cleaned, null, 2);
    
    // Pass both connection string and connection name (if changed)
    onSave(connectionString, selectedConnectionName);
    onClose();
  }

  function renderField(fieldName: string, fieldSchema: any): React.ReactNode {
    const value = formData[fieldName];
    const error = errors[fieldName];
    const isRequired = connection?.connection_string_schema?.required?.includes(fieldName);

    switch (fieldSchema.type) {
      case 'string':
        return (
          <div key={fieldName} className="connection-settings-field">
            <label className="connection-settings-label">
              {fieldSchema.title || fieldName}
              {isRequired && <span className="required">*</span>}
            </label>
            {fieldSchema.description && (
              <div className="connection-settings-description">{fieldSchema.description}</div>
            )}
            <input
              type="text"
              value={value || ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              placeholder={fieldSchema.default || ''}
              className={error ? 'connection-settings-input error' : 'connection-settings-input'}
            />
            {error && <div className="connection-settings-error">{error}</div>}
          </div>
        );

      case 'number':
      case 'integer':
        return (
          <div key={fieldName} className="connection-settings-field">
            <label className="connection-settings-label">
              {fieldSchema.title || fieldName}
              {isRequired && <span className="required">*</span>}
            </label>
            {fieldSchema.description && (
              <div className="connection-settings-description">{fieldSchema.description}</div>
            )}
            <input
              type="number"
              value={value !== undefined ? value : ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value === '' ? undefined : parseFloat(e.target.value))}
              placeholder={fieldSchema.default?.toString() || ''}
              className={error ? 'connection-settings-input error' : 'connection-settings-input'}
            />
            {error && <div className="connection-settings-error">{error}</div>}
          </div>
        );

      case 'boolean':
        return (
          <div key={fieldName} className="connection-settings-field">
            <label className="connection-settings-checkbox-label">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => handleFieldChange(fieldName, e.target.checked)}
                className="connection-settings-checkbox"
              />
              <span>
                {fieldSchema.title || fieldName}
                {isRequired && <span className="required">*</span>}
              </span>
            </label>
            {fieldSchema.description && (
              <div className="connection-settings-description">{fieldSchema.description}</div>
            )}
            {error && <div className="connection-settings-error">{error}</div>}
          </div>
        );

      default:
        return (
          <div key={fieldName} className="connection-settings-field">
            <label className="connection-settings-label">
              {fieldSchema.title || fieldName}
              {isRequired && <span className="required">*</span>}
            </label>
            {fieldSchema.description && (
              <div className="connection-settings-description">{fieldSchema.description}</div>
            )}
            <textarea
              value={value !== undefined ? JSON.stringify(value, null, 2) : ''}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value);
                  handleFieldChange(fieldName, parsed);
                } catch {
                  // Invalid JSON - store as string for now
                  handleFieldChange(fieldName, e.target.value);
                }
              }}
              placeholder={fieldSchema.default ? JSON.stringify(fieldSchema.default) : ''}
              className={error ? 'connection-settings-textarea error' : 'connection-settings-textarea'}
              rows={3}
            />
            {error && <div className="connection-settings-error">{error}</div>}
          </div>
        );
    }
  }

  if (!isOpen) return null;

  const schema = connection?.connection_string_schema;
  const hasSchema = schema && schema.properties && Object.keys(schema.properties).length > 0;

  return (
    <div className="connection-settings-modal-overlay" onClick={onClose}>
      <div className="connection-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="connection-settings-modal-header">
            <div className="connection-settings-modal-title">
              <Settings size={18} style={{ marginRight: '8px' }} />
              Connection Settings
            </div>
          <button className="connection-settings-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="connection-settings-modal-content">
          {/* Connection Selector (inside modal) */}
          <div style={{ marginBottom: '24px' }}>
            <label className="connection-settings-label" style={{ marginBottom: '8px' }}>
              Connection
            </label>
            <ConnectionSelector
              value={selectedConnectionName}
              onChange={(newConnectionName) => {
                setSelectedConnectionName(newConnectionName || undefined);
                // Clear form data when connection changes
                setFormData({});
                setErrors({});
              }}
              label=""
            />
          </div>

          {loading ? (
            <div className="connection-settings-loading">Loading connection...</div>
          ) : !selectedConnectionName ? (
            <div className="connection-settings-empty">Select a connection to configure settings</div>
          ) : !connection ? (
            <div className="connection-settings-error">Connection not found: {selectedConnectionName}</div>
          ) : !hasSchema ? (
            <div className="connection-settings-empty">
              <p>This connection doesn't define any per-parameter settings.</p>
              <p className="connection-settings-hint">
                Connection-specific settings are configured in the connection definition's <code>connection_string_schema</code>.
              </p>
            </div>
          ) : (
            <>
              {schema.description && (
                <div className="connection-settings-schema-description">
                  {schema.description}
                </div>
              )}
              {Object.entries(schema.properties || {}).map(([fieldName, fieldSchema]) =>
                renderField(fieldName, fieldSchema as any)
              )}
            </>
          )}
        </div>

        <div className="connection-settings-modal-footer">
          <button className="connection-settings-button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="connection-settings-button primary"
            onClick={handleSave}
            disabled={loading || !hasSchema || Object.keys(errors).length > 0}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

