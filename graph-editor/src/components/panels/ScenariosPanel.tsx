/**
 * ScenariosPanel
 * 
 * Displays and manages scenarios (parameter overlays) for the active graph tab.
 * Allows users to:
 * - Create snapshots (All/Differences)
 * - Create blank scenarios
 * - Toggle visibility (eye icon)
 * - Reorder scenarios (drag-and-drop)
 * - Rename scenarios (inline edit)
 * - Delete scenarios
 * - Open scenarios in editor
 * - Flatten all overlays into Base
 */

import React, { useState, useCallback, useRef } from 'react';
import { useScenariosContext } from '../../contexts/ScenariosContext';
import { useTabContext } from '../../contexts/TabContext';
import { Scenario } from '../../types/scenarios';
import { assignColors } from '../../services/ColorAssigner';
import { ScenarioEditorModal } from '../modals/ScenarioEditorModal';
import { 
  Eye, 
  EyeOff, 
  Edit2, 
  Trash2, 
  GripVertical, 
  Plus, 
  Camera,
  Layers,
  ChevronDown
} from 'lucide-react';
import toast from 'react-hot-toast';
import './ScenariosPanel.css';

interface ScenariosPanelProps {
  tabId?: string;
}

export default function ScenariosPanel({ tabId }: ScenariosPanelProps) {
  const { scenarios, listScenarios, renameScenario, deleteScenario, createSnapshot, createBlank, openInEditor, closeEditor, editorOpenScenarioId, flatten } = useScenariosContext();
  const { operations } = useTabContext();
  
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [editingScenarioId, setEditingScenarioId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggedScenarioId, setDraggedScenarioId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  // Get tab's scenario state
  const scenarioState = tabId ? operations.getScenarioState(tabId) : undefined;
  const visibleScenarioIds = scenarioState?.visibleScenarioIds || [];
  const visibleColorOrderIds = scenarioState?.visibleColorOrderIds || [];
  const selectedScenarioId = scenarioState?.selectedScenarioId;
  
  // Assign colors based on activation order
  const colorMap = assignColors(visibleScenarioIds, visibleColorOrderIds);
  
  // Special entries: Base and Current
  // Note: These track VISIBILITY state, not list display
  // Base: default HIDDEN (per spec: "default hidden; can be shown/hidden")
  // Current: default VISIBLE (live working state)
  const baseVisible = visibleScenarioIds.includes('base');
  const currentVisible = visibleScenarioIds.includes('current');
  
  /**
   * Toggle scenario visibility
   */
  const handleToggleVisibility = useCallback(async (scenarioId: string) => {
    if (!tabId) return;
    
    try {
      await operations.toggleScenarioVisibility(tabId, scenarioId);
    } catch (error) {
      console.error('Failed to toggle scenario visibility:', error);
      toast.error('Failed to toggle visibility');
    }
  }, [tabId, operations]);
  
  /**
   * Start editing scenario name
   */
  const handleStartEdit = useCallback((scenario: Scenario) => {
    setEditingScenarioId(scenario.id);
    setEditingName(scenario.name);
  }, []);
  
  /**
   * Save edited scenario name
   */
  const handleSaveEdit = useCallback(async () => {
    if (!editingScenarioId || !editingName.trim()) {
      setEditingScenarioId(null);
      return;
    }
    
    try {
      await renameScenario(editingScenarioId, editingName.trim());
      setEditingScenarioId(null);
      toast.success('Scenario renamed');
    } catch (error) {
      console.error('Failed to rename scenario:', error);
      toast.error('Failed to rename scenario');
    }
  }, [editingScenarioId, editingName, renameScenario]);
  
  /**
   * Cancel editing scenario name
   */
  const handleCancelEdit = useCallback(() => {
    setEditingScenarioId(null);
    setEditingName('');
  }, []);
  
  /**
   * Delete scenario
   */
  const handleDelete = useCallback(async (scenarioId: string) => {
    try {
      await deleteScenario(scenarioId);
      toast.success('Scenario deleted');
    } catch (error) {
      console.error('Failed to delete scenario:', error);
      toast.error('Failed to delete scenario');
    }
  }, [deleteScenario]);
  
  /**
   * Open scenario in editor
   */
  const handleOpenEditor = useCallback((scenarioId: string) => {
    openInEditor(scenarioId);
  }, [openInEditor]);
  
  /**
   * Create snapshot with timestamp as default name
   */
  const handleCreateSnapshot = useCallback(async (type: 'all' | 'differences', source: 'visible' | 'base') => {
    if (!tabId) {
      toast.error('No active tab');
      return;
    }
    
    // Generate timestamp name (e.g., "2025-11-12 14:30")
    const now = new Date();
    const timestamp = now.toLocaleString('en-CA', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(',', '');
    
    try {
      await createSnapshot({
        name: timestamp,
        type,
        source,
        diffThreshold: 1e-6
      }, tabId);
      
      toast.success('Snapshot created');
      setShowCreateMenu(false);
    } catch (error) {
      console.error('Failed to create snapshot:', error);
      toast.error('Failed to create snapshot');
    }
  }, [tabId, createSnapshot]);
  
  /**
   * Create blank scenario with timestamp as default name
   * Opens editor automatically for immediate editing
   */
  const handleCreateBlank = useCallback(async () => {
    if (!tabId) {
      toast.error('No active tab');
      return;
    }
    
    // Generate timestamp name (e.g., "2025-11-12 14:30")
    const now = new Date();
    const timestamp = now.toLocaleString('en-CA', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(',', '');
    
    try {
      await createBlank(timestamp, tabId);
      toast.success('Blank scenario created');
    } catch (error) {
      console.error('Failed to create scenario:', error);
      toast.error('Failed to create scenario');
    }
  }, [tabId, createBlank]);
  
  /**
   * Flatten all overlays into Base
   */
  const handleFlatten = useCallback(async () => {
    const confirmed = confirm(
      'Flatten will merge all visible scenarios into Base and clear all overlays. This cannot be undone. Continue?'
    );
    
    if (!confirmed) return;
    
    try {
      await flatten();
      toast.success('Flattened scenarios into Base');
    } catch (error) {
      console.error('Failed to flatten:', error);
      toast.error('Failed to flatten');
    }
  }, [flatten]);
  
  /**
   * Drag handlers
   */
  const handleDragStart = useCallback((e: React.DragEvent, scenarioId: string) => {
    setDraggedScenarioId(scenarioId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);
  
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);
  
  const handleDragEnd = useCallback(() => {
    setDraggedScenarioId(null);
    setDragOverIndex(null);
  }, []);
  
  const handleDrop = useCallback(async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    
    if (!draggedScenarioId || !tabId) return;
    
    const currentIndex = scenarios.findIndex(s => s.id === draggedScenarioId);
    if (currentIndex === -1 || currentIndex === targetIndex) return;
    
    // Reorder scenarios in display order (same as storage order)
    const newOrder = [...scenarios.map(s => s.id)];
    newOrder.splice(currentIndex, 1);
    newOrder.splice(targetIndex, 0, draggedScenarioId);
    
    try {
      await operations.reorderScenarios(tabId, newOrder);
    } catch (error) {
      console.error('Failed to reorder scenarios:', error);
      toast.error('Failed to reorder scenarios');
    }
    
    setDraggedScenarioId(null);
    setDragOverIndex(null);
  }, [draggedScenarioId, scenarios, tabId, operations]);
  
  return (
    <>
      <div className="scenarios-panel">
      {/* Header */}
      <div className="scenarios-header">
        <div className="scenarios-title">
          <Layers size={16} />
          <span>Scenarios</span>
        </div>
      </div>
      
      {/* Scenario List */}
      <div className="scenarios-list">
        {/* Current (pinned at TOP, non-draggable, toggleable) */}
        <div className="scenario-row scenario-current">
          <div className="scenario-drag-handle disabled">
            <GripVertical size={14} />
          </div>
          <div
            className="scenario-color-swatch"
            style={{ backgroundColor: '#4A90E2' }}
            title="Current color"
          />
          <div className="scenario-name">Current</div>
          <button
            className="scenario-action-btn"
            onClick={() => handleToggleVisibility('current')}
            title="Toggle visibility"
          >
            {currentVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </div>
        
        {/* Divider */}
        {scenarios.length > 0 && <div className="scenarios-divider" />}
        
        {/* User Scenarios (draggable) */}
        {/* Scenarios are stored in display order: newest first (just below Current) */}
        {scenarios.map((scenario, index) => {
          const isVisible = visibleScenarioIds.includes(scenario.id);
          const isSelected = selectedScenarioId === scenario.id;
          const color = colorMap.get(scenario.id) || scenario.color;
          const isEditing = editingScenarioId === scenario.id;
          const isDragging = draggedScenarioId === scenario.id;
          const isDragOver = dragOverIndex === index;
          
          return (
            <div
              key={scenario.id}
              className={`scenario-row ${isSelected ? 'selected' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, scenario.id)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, index)}
            >
              <div className="scenario-drag-handle">
                <GripVertical size={14} />
              </div>
              <div
                className="scenario-color-swatch"
                style={{ backgroundColor: color }}
                title={`Color: ${color} (${isVisible ? 'visible' : 'hidden'})`}
              />
              {isEditing ? (
                <input
                  type="text"
                  className="scenario-name-input"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={handleSaveEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveEdit();
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  autoFocus
                />
              ) : (
                <div
                  className="scenario-name"
                  onDoubleClick={() => handleStartEdit(scenario)}
                  title={scenario.meta?.note || 'Double-click to rename'}
                >
                  {scenario.name}
                </div>
              )}
              <button
                className="scenario-action-btn"
                onClick={() => handleToggleVisibility(scenario.id)}
                title="Toggle visibility"
              >
                {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                className="scenario-action-btn"
                onClick={() => handleOpenEditor(scenario.id)}
                title="Open in editor"
              >
                <Edit2 size={14} />
              </button>
              <button
                className="scenario-action-btn danger"
                onClick={() => handleDelete(scenario.id)}
                title="Delete scenario"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
        
        {scenarios.length === 0 && (
          <div className="scenarios-empty">
            <p>No scenarios yet</p>
            <p className="scenarios-empty-hint">Create a snapshot or new scenario to get started</p>
          </div>
        )}
        
        {/* Divider before Base */}
        {scenarios.length > 0 && <div className="scenarios-divider" />}
        
        {/* Base (pinned at BOTTOM, non-draggable, toggleable) */}
        <div className="scenario-row scenario-base">
          <div className="scenario-drag-handle disabled">
            <GripVertical size={14} />
          </div>
          <div
            className="scenario-color-swatch"
            style={{ backgroundColor: '#808080' }}
            title="Base color"
          />
          <div className="scenario-name">Base</div>
          <button
            className="scenario-action-btn"
            onClick={() => handleToggleVisibility('base')}
            title="Toggle visibility"
          >
            {baseVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          <button
            className="scenario-action-btn"
            onClick={() => handleOpenEditor('base')}
            title="Edit Base"
          >
            <Edit2 size={14} />
          </button>
        </div>
      </div>
      
      {/* Footer Actions */}
      <div className="scenarios-footer">
        <div className="scenarios-footer-row">
          {/* Create Snapshot (with dropdown) */}
          <div className="scenarios-dropdown-container">
            <button
              className="scenarios-btn scenarios-btn-primary"
              onClick={() => handleCreateSnapshot('all', 'visible')}
              title="Create snapshot from visible layers"
            >
              <Camera size={14} />
              <span>Snapshot</span>
            </button>
            <button
              className="scenarios-btn scenarios-btn-dropdown"
              onClick={() => setShowCreateMenu(!showCreateMenu)}
              title="More snapshot options"
            >
              <ChevronDown size={14} />
            </button>
            
            {showCreateMenu && (
              <div className="scenarios-dropdown-menu">
                <button onClick={() => handleCreateSnapshot('all', 'visible')}>
                  All from visible
                </button>
                <button onClick={() => handleCreateSnapshot('all', 'base')}>
                  All from Base
                </button>
                <button onClick={() => handleCreateSnapshot('differences', 'visible')}>
                  Diff from visible
                </button>
                <button onClick={() => handleCreateSnapshot('differences', 'base')}>
                  Diff from Base
                </button>
              </div>
            )}
          </div>
          
          {/* New Blank */}
          <button
            className="scenarios-btn"
            onClick={handleCreateBlank}
            title="Create blank scenario"
          >
            <Plus size={14} />
            <span>New</span>
          </button>
        </div>
        
        {/* Flatten */}
        <button
          className="scenarios-btn scenarios-btn-flatten"
          onClick={handleFlatten}
          disabled={scenarios.length === 0}
          title="Flatten all visible scenarios into Base"
        >
          <Layers size={14} />
          <span>Flatten</span>
        </button>
      </div>
    </div>
    
    {/* Editor Modal */}
    <ScenarioEditorModal
      isOpen={editorOpenScenarioId !== null}
      scenarioId={editorOpenScenarioId}
      onClose={closeEditor}
    />
  </>
  );
}

