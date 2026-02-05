import { ObjectType } from '../../types';
import { GraphEditor } from './GraphEditor';
import { FormEditor } from './FormEditor';
import { RawView } from './RawView';
import { MarkdownViewer } from './MarkdownViewer';
import { SessionLogViewer } from './SessionLogViewer';
import { GraphIssuesViewer } from './GraphIssuesViewer';
import { ChartViewer } from './ChartViewer';
import { SignatureLinksViewer } from './SignatureLinksViewer';
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
  raw: RawView,
  markdown: MarkdownViewer,
  sessionLog: SessionLogViewer,
  graphIssues: GraphIssuesViewer,
  chart: ChartViewer,
};

/**
 * Get editor component for a given type and view mode.
 * Queries FILE_TYPE_REGISTRY to determine which editor to use.
 */
export function getEditorComponent(type: ObjectType | 'settings' | 'session-log' | 'issues', viewMode: 'interactive' | 'raw-json' | 'raw-yaml') {
  // Raw views always use RawView component (including settings)
  if (viewMode === 'raw-json' || viewMode === 'raw-yaml') {
    return RawView;
  }
  
  // Special case for settings interactive view
  if (type === 'settings') {
    return FormEditor;
  }
  
  // Special case for session log viewer
  if (type === 'session-log') {
    return SessionLogViewer;
  }
  
  // Special case for graph issues viewer
  if (type === 'issues') {
    return GraphIssuesViewer;
  }

  // Special case for signature links viewer
  if (type === 'signature-links') {
    return SignatureLinksViewer;
  }
  
  // Special case for markdown - always use MarkdownViewer for read-only display
  if (type === 'markdown') {
    return MarkdownViewer;
  }
  
  // Interactive views - consult FILE_TYPE_REGISTRY
  const config = getFileTypeConfig(type as ObjectType);
  if (config?.interactiveEditor) {
    return EDITOR_COMPONENTS[config.interactiveEditor];
  }
  
  // Fallback to FormEditor
  return FormEditor;
}

