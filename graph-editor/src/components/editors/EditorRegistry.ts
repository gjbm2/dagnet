import { ObjectType } from '../../types';
import { GraphEditor } from './GraphEditor';
import { FormEditor } from './FormEditor';
import { RawView } from './RawView';

/**
 * Editor Registry
 * 
 * Maps object types and view modes to editor components
 */

export const editorRegistry = {
  // Interactive editors
  interactive: {
    graph: GraphEditor,
    parameter: FormEditor,
    context: FormEditor,
    case: FormEditor,
    settings: FormEditor,
    about: FormEditor
  },
  
  // Raw editors (JSON/YAML)
  'raw-json': {
    graph: RawView,
    parameter: RawView,
    context: RawView,
    case: RawView,
    settings: RawView,
    about: RawView
  },
  
  'raw-yaml': {
    graph: RawView,
    parameter: RawView,
    context: RawView,
    case: RawView,
    settings: RawView,
    about: RawView
  }
};

/**
 * Get editor component for a given type and view mode
 */
export function getEditorComponent(type: ObjectType, viewMode: 'interactive' | 'raw-json' | 'raw-yaml') {
  return editorRegistry[viewMode][type] || FormEditor;
}

