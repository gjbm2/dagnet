/**
 * ConnectionSelector Component
 * 
 * Dropdown selector for DAS connections from connections.yaml
 * Used in edge properties panel for selecting data sources
 */

import React, { useState, useEffect } from 'react';
import { IndexedDBConnectionProvider } from '../lib/das/IndexedDBConnectionProvider';
import type { ConnectionDefinition } from '../lib/das/types';
import './ConnectionSelector.css';

interface ConnectionSelectorProps {
  value: string | undefined;
  onChange: (connectionName: string | undefined) => void;
  label?: string;
  disabled?: boolean;
}

export function ConnectionSelector({
  value,
  onChange,
  label = 'Connection',
  disabled = false
}: ConnectionSelectorProps) {
  const [connections, setConnections] = useState<ConnectionDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  async function loadConnections() {
    try {
      setLoading(true);
      setError(null);
      const provider = new IndexedDBConnectionProvider();
      const allConnections = await provider.getAllConnections();
      // Filter to enabled connections only
      setConnections(allConnections.filter(c => c.enabled !== false));
    } catch (err: any) {
      console.error('Failed to load connections:', err);
      setError(err.message || 'Failed to load connections');
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="connection-selector">
      <label className="connection-selector-label">{label}</label>
      <select
        className="connection-selector-select"
        value={value || ''}
        onChange={(e) => {
          const newValue = e.target.value === '' ? undefined : e.target.value;
          onChange(newValue);
        }}
        disabled={disabled || loading}
      >
        <option value="">None (manual input)</option>
        {connections.map(conn => (
          <option key={conn.name} value={conn.name}>
            {conn.name} {conn.provider ? `(${conn.provider})` : ''}
          </option>
        ))}
      </select>
      {error && (
        <div className="connection-selector-error">
          {error}
        </div>
      )}
      {connections.length === 0 && !loading && !error && (
        <div className="connection-selector-hint">
          No connections configured. Go to File &gt; Connections to add one.
        </div>
      )}
    </div>
  );
}

