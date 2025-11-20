/**
 * ScenarioEditorModal
 * 
 * Monaco editor modal for viewing/editing scenario parameters.
 * Features:
 * - YAML/JSON syntax toggle
 * - Nested/Flat structure toggle
 * - Metadata panel (read-only + editable note)
 * - Apply/Cancel/Export actions
 * - Validation with inline error display
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import * as yaml from 'js-yaml';
import { useScenariosContext } from '../../contexts/ScenariosContext';
import { useTabContext } from '../../contexts/TabContext';
import { Scenario, ScenarioContentFormat } from '../../types/scenarios';
import { toYAML, toJSON, toCSV, fromYAML, fromJSON } from '../../services/ParamPackDSLService';
import { X, FileText, Download, AlertCircle, CheckCircle2, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useGraphStore } from '../../contexts/GraphStoreContext';
import './Modal.css';
import './ScenarioEditorModal.css';

interface ScenarioEditorModalProps {
  isOpen: boolean;
  scenarioId: string | null;
  tabId: string | null;
  onClose: () => void;
  onSave?: () => void;
}

export function ScenarioEditorModal({ isOpen, scenarioId, tabId, onClose, onSave }: ScenarioEditorModalProps) {
  const { scenarios, getScenario, applyContent, validateContent, baseParams, currentParams, setBaseParams, createSnapshot, createBlank } = useScenariosContext();
  const { operations } = useTabContext();
  const graphStore = useGraphStore();
  const graph = graphStore?.getState().graph || null;
  
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [format, setFormat] = useState<ScenarioContentFormat>({ syntax: 'yaml', structure: 'flat' });
  const [isDirty, setIsDirty] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [editableNote, setEditableNote] = useState('');
  
  const editorRef = useRef<any>(null);
  
  // Load scenario when modal opens
  useEffect(() => {
    if (isOpen && scenarioId) {
      // Special handling for Base and Current
      if (scenarioId === 'base') {
        // Load Base params
        const pseudoScenario: Scenario = {
          id: 'base',
          name: 'Base',
          colour: '#808080',
          createdAt: new Date().toISOString(),
          version: 1,
          params: baseParams,
          meta: { note: 'Session baseline parameters' }
        };
        setScenario(pseudoScenario);
        setEditableNote(pseudoScenario.meta?.note || '');
        
        const content = format.syntax === 'yaml'
          ? toYAML(pseudoScenario.params, format.structure)
          : toJSON(pseudoScenario.params, format.structure);
        
        setEditorValue(content);
        setIsDirty(false);
        setValidationErrors([]);
        setValidationWarnings([]);
      } else if (scenarioId === 'current') {
        // Load Current params
        const pseudoScenario: Scenario = {
          id: 'current',
          name: 'Current',
          colour: '#4A90E2',
          createdAt: new Date().toISOString(),
          version: 1,
          params: currentParams,
          meta: { note: 'Live working state' }
        };
        setScenario(pseudoScenario);
        setEditableNote(pseudoScenario.meta?.note || '');
        
        const content = format.syntax === 'yaml'
          ? toYAML(pseudoScenario.params, format.structure)
          : toJSON(pseudoScenario.params, format.structure);
        
        setEditorValue(content);
        setIsDirty(false);
        setValidationErrors([]);
        setValidationWarnings([]);
      } else {
        // Load normal scenario
        const loadedScenario = getScenario(scenarioId);
        if (loadedScenario) {
          setScenario(loadedScenario);
          setEditableNote(loadedScenario.meta?.note || '');
          
          // Convert params to editor format
          const content = format.syntax === 'yaml'
            ? toYAML(loadedScenario.params, format.structure)
            : toJSON(loadedScenario.params, format.structure);
          
          setEditorValue(content);
          setIsDirty(false);
          setValidationErrors([]);
          setValidationWarnings([]);
        }
      }
    }
  }, [isOpen, scenarioId, getScenario, baseParams, currentParams, format]);
  
  // Update editor content when format changes
  useEffect(() => {
    if (scenario) {
      try {
        const content = format.syntax === 'yaml'
          ? toYAML(scenario.params, format.structure)
          : toJSON(scenario.params, format.structure);
        
        setEditorValue(content);
        setIsDirty(false);
      } catch (error) {
        console.error('Failed to convert format:', error);
        toast.error('Failed to convert format');
      }
    }
  }, [format, scenario]);
  
  /**
   * Handle editor content change
   */
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      setEditorValue(value);
      setIsDirty(true);
      setValidationErrors([]);
      setValidationWarnings([]);
    }
  }, []);
  
  /**
   * Handle Apply button
   */
  const handleApply = useCallback(async () => {
    if (!scenario) return;
    
    setIsSaving(true);
    setValidationErrors([]);
    setValidationWarnings([]);
    
    try {
      // Validate first
      setIsValidating(true);
      const validation = await validateContent(editorValue, {
        format: format.syntax,
        structure: format.structure
      });
      
      setIsValidating(false);
      
      if (!validation.valid) {
        setValidationErrors(validation.errors.map(e => `${e.path}: ${e.message}`));
        setValidationWarnings(validation.warnings.map(w => `${w.path}: ${w.message}`));
        toast.error('Validation failed');
        setIsSaving(false);
        return;
      }
      
      // Show warnings but allow apply
      if (validation.warnings.length > 0) {
        setValidationWarnings(validation.warnings.map(w => `${w.path}: ${w.message}`));
      }
      
      // Special handling for Base and Current
      if (scenario.id === 'base') {
        // Apply edits to Base: mutate Base directly
        const parsed = format.syntax === 'yaml'
          ? fromYAML(editorValue, format.structure, graph)
          : fromJSON(editorValue, format.structure, graph);
        setBaseParams(parsed);
        toast.success('Base updated');
        setIsDirty(false);
        onClose();
      } else if (scenario.id === 'current') {
        // Apply edits to Current: create NEW scenario with edited params
        // Generate timestamp name
        const now = new Date();
        const timestamp = now.toISOString().replace('T', ' ').substring(0, 16);
        const name = `Edited ${timestamp}`;
        
        // Create blank scenario
        if (!tabId) {
          toast.error('Cannot create scenario: tab ID is missing');
          return;
        }
        const newScenario = await createBlank(name, tabId);
        
        // Apply the edited content to it
        await applyContent(newScenario.id, editorValue, {
          format: format.syntax,
          structure: format.structure,
          validate: false // Already validated above
        });
        
        // Make the new scenario visible by default
        if (tabId) {
          await operations.toggleScenarioVisibility(tabId, newScenario.id);
        }
        
        toast.success(`Created new scenario: ${name}`);
        setIsDirty(false);
        onSave?.(); // Notify parent that save was successful
        onClose();
      } else {
        // Normal scenario: apply edits
        await applyContent(scenario.id, editorValue, {
          format: format.syntax,
          structure: format.structure,
          validate: false // Already validated above
        });
        
        toast.success('Scenario updated');
        setIsDirty(false);
        onSave?.(); // Notify parent that save was successful
        onClose();
      }
    } catch (error: any) {
      console.error('Failed to apply changes:', error);
      setValidationErrors([error.message || 'Failed to apply changes']);
      toast.error('Failed to apply changes');
    } finally {
      setIsSaving(false);
      setIsValidating(false);
    }
  }, [scenario, editorValue, format, validateContent, applyContent, fromYAML, fromJSON, setBaseParams, createBlank, tabId, operations, onClose]);
  
  /**
   * Handle Cancel button
   */
  const handleCancel = useCallback(() => {
    if (isDirty) {
      const confirmed = confirm('You have unsaved changes. Are you sure you want to close?');
      if (!confirmed) return;
    }
    
    onClose();
  }, [isDirty, onClose]);
  
  /**
   * Export as CSV
   */
  const handleExportCSV = useCallback(() => {
    if (!scenario) return;
    
    try {
      const csv = toCSV(scenario.params);
      
      // Create download
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${scenario.name}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast.success('Exported as CSV');
    } catch (error) {
      console.error('Failed to export CSV:', error);
      toast.error('Failed to export CSV');
    }
  }, [scenario]);
  
  /**
   * Format/prettify content
   */
  const handleFormat = useCallback(() => {
    try {
      if (format.syntax === 'yaml') {
        const parsed = yaml.load(editorValue);
        const formatted = yaml.dump(parsed, { indent: 2, lineWidth: 120 });
        setEditorValue(formatted);
      } else {
        const parsed = JSON.parse(editorValue);
        const formatted = JSON.stringify(parsed, null, 2);
        setEditorValue(formatted);
      }
      
      toast.success('Formatted');
    } catch (error) {
      toast.error('Invalid syntax - cannot format');
    }
  }, [editorValue, format]);
  
  if (!isOpen || !scenario) return null;
  
  const language = format.syntax === 'yaml' ? 'yaml' : 'json';
  
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleCancel()}>
      <div className="modal-container scenario-editor-modal">
        {/* Header */}
        <div className="modal-header">
          <h2 className="modal-title">
            <FileText size={20} style={{ marginRight: 8 }} />
            Edit Scenario: {scenario.name}
          </h2>
          <button className="modal-close-btn" onClick={handleCancel}>
            <X size={20} />
          </button>
        </div>
        
        {/* Body */}
        <div className="modal-body scenario-editor-body">
          {/* Metadata Panel */}
          <div className="scenario-metadata-panel">
            <div className="metadata-row">
              <strong>Created:</strong>
              <span>{new Date(scenario.createdAt).toLocaleString()}</span>
            </div>
            {scenario.updatedAt && (
              <div className="metadata-row">
                <strong>Updated:</strong>
                <span>{new Date(scenario.updatedAt).toLocaleString()}</span>
              </div>
            )}
            {scenario.meta?.source && (
              <div className="metadata-row">
                <strong>Source:</strong>
                <span>{scenario.meta.source} ({scenario.meta.sourceDetail || 'unknown'})</span>
              </div>
            )}
            {scenario.meta?.window && (
              <div className="metadata-row">
                <strong>Window:</strong>
                <span>{scenario.meta.window.start} to {scenario.meta.window.end}</span>
              </div>
            )}
            {scenario.meta?.whatIfDSL && (
              <div className="metadata-row">
                <strong>What-If:</strong>
                <span>{scenario.meta.whatIfDSL}</span>
              </div>
            )}
            
            {/* Editable Note */}
            <div className="metadata-note">
              <label>
                <strong>Note:</strong>
              </label>
              <textarea
                value={editableNote}
                onChange={(e) => setEditableNote(e.target.value)}
                placeholder="Add a note about this scenario..."
                rows={2}
              />
            </div>
          </div>
          
          {/* Format Controls */}
          <div className="editor-controls">
            <div className="control-group">
              <label>Syntax:</label>
              <button
                className={`control-btn ${format.syntax === 'yaml' ? 'active' : ''}`}
                onClick={() => setFormat({ ...format, syntax: 'yaml' })}
              >
                YAML
              </button>
              <button
                className={`control-btn ${format.syntax === 'json' ? 'active' : ''}`}
                onClick={() => setFormat({ ...format, syntax: 'json' })}
              >
                JSON
              </button>
            </div>
            
            <div className="control-group">
              <label>Structure:</label>
              <button
                className={`control-btn ${format.structure === 'flat' ? 'active' : ''}`}
                onClick={() => setFormat({ ...format, structure: 'flat' })}
              >
                Flat
              </button>
              <button
                className={`control-btn ${format.structure === 'nested' ? 'active' : ''}`}
                onClick={() => setFormat({ ...format, structure: 'nested' })}
              >
                Nested
              </button>
            </div>
            
            <div className="control-group">
              <button className="control-btn" onClick={handleFormat} title="Format/prettify">
                Format
              </button>
              <button className="control-btn" onClick={handleExportCSV} title="Export as CSV">
                <Download size={14} />
                CSV
              </button>
            </div>
          </div>
          
          {/* Validation Messages */}
          {validationErrors.length > 0 && (
            <div className="validation-errors">
              <AlertCircle size={16} />
              <div>
                <strong>Errors:</strong>
                <ul>
                  {validationErrors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          
          {validationWarnings.length > 0 && (
            <div className="validation-warnings">
              <AlertCircle size={16} />
              <div>
                <strong>Warnings:</strong>
                <ul>
                  {validationWarnings.map((warn, i) => (
                    <li key={i}>{warn}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          
          {/* Monaco Editor */}
          <div className="scenario-editor-container">
            <Editor
              height="500px"
              language={language}
              value={editorValue}
              onChange={handleEditorChange}
              onMount={(editor) => {
                editorRef.current = editor;
              }}
              theme="vs"
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                wrappingIndent: 'indent',
                automaticLayout: true,
                fontSize: 13,
                tabSize: 2,
                insertSpaces: true,
              }}
            />
          </div>
        </div>
        
        {/* Footer */}
        <div className="modal-footer">
          <button
            className="modal-btn modal-btn-secondary"
            onClick={handleCancel}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleApply}
            disabled={isSaving || isValidating || !isDirty}
          >
            {isSaving ? 'Saving...' : isValidating ? 'Validating...' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}


