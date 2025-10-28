import { ObjectType } from '../../types';
import { GraphEditor } from './GraphEditor';
import { FormEditor } from './FormEditor';
import { RawView } from './RawView';
import { getFileTypeConfig } from '../../config/fileTypeRegistry';

/**
 * Editor Registry
 * 
 * Maps editor type identifiers to actual React components.
 * Uses FILE_TYPE_REGISTRY as the single source of truth for which editor to use.
 */

const EDITOR_COMPONENTS = {
  graph: GraphEditor,
  form: FormEditor,
  raw: RawView
};

/**
 * Get editor component for a given type and view mode.
 * Queries FILE_TYPE_REGISTRY to determine which editor to use.
 */
export function getEditorComponent(type: ObjectType, viewMode: 'interactive' | 'raw-json' | 'raw-yaml') {
  // Raw views always use RawView component
  if (viewMode === 'raw-json' || viewMode === 'raw-yaml') {
    return RawView;
  }
  
  // Interactive views - consult FILE_TYPE_REGISTRY
  const config = getFileTypeConfig(type);
  if (config?.interactiveEditor) {
    return EDITOR_COMPONENTS[config.interactiveEditor];
  }
  
  // Fallback to FormEditor
  return FormEditor;
}

