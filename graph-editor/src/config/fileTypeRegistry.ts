/**
 * File Type Registry
 * 
 * Central configuration for all file types in the application.
 * Maps file types to their schemas, directories, index files, and other metadata.
 */

export interface FileTypeConfig {
  /** The type identifier (matches ObjectType) */
  type: 'graph' | 'parameter' | 'context' | 'case' | 'node' | 'event' | 'credentials' | 'connections' | 'settings' | 'markdown';
  
  /** Display name (singular) */
  displayName: string;
  
  /** Display name (plural) */
  displayNamePlural: string;
  
  /** JSON Schema file for validation and form generation */
  schemaFile: string;
  
  /** UI Schema file for custom form layout/widgets (optional) */
  uiSchemaFile?: string;
  
  /** Primary directory where files are stored */
  directory: string;
  
  /** Alternative directories to check (for backwards compatibility) */
  alternativeDirectories?: string[];
  
  /** Optional index file that lists all files of this type */
  indexFile?: string;
  
  /** File extensions to look for */
  extensions: string[];
  
  /** Icon for display (emoji or icon name) */
  icon: string;
  
  /** Editor component to use for interactive editing */
  interactiveEditor: 'graph' | 'form';
  
  /** Whether this file type supports interactive editing */
  supportsInteractiveEdit: boolean;
  
  /** Whether this file type supports JSON/YAML views */
  supportsRawEdit: boolean;
}

/**
 * Registry of all file types
 */
export const FILE_TYPE_REGISTRY: Record<string, FileTypeConfig> = {
  graph: {
    type: 'graph',
    displayName: 'Graph',
    displayNamePlural: 'Graphs',
    schemaFile: '/schemas/conversion-graph-1.0.0.json',
    directory: 'graphs',
    extensions: ['.json'],
    icon: '📊',
    interactiveEditor: 'graph',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  parameter: {
    type: 'parameter',
    displayName: 'Parameter',
    displayNamePlural: 'Parameters',
    schemaFile: '/param-schemas/parameter-schema.yaml',
    directory: 'params',
    alternativeDirectories: ['parameters'],
    indexFile: 'parameters-index.yaml',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '📋',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  context: {
    type: 'context',
    displayName: 'Context',
    displayNamePlural: 'Contexts',
    schemaFile: '/param-schemas/context-definition-schema.yaml',
    directory: 'contexts',
    indexFile: 'contexts-index.yaml',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '🏷️',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  case: {
    type: 'case',
    displayName: 'Case',
    displayNamePlural: 'Cases',
    schemaFile: '/param-schemas/case-parameter-schema.yaml',
    directory: 'cases',
    indexFile: 'cases-index.yaml',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '📦',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  node: {
    type: 'node',
    displayName: 'Node',
    displayNamePlural: 'Nodes',
    schemaFile: '/param-schemas/node-schema.yaml',
    directory: 'nodes',
    indexFile: 'nodes-index.yaml',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '🔵',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  event: {
    type: 'event',
    displayName: 'Event',
    displayNamePlural: 'Events',
    schemaFile: '/param-schemas/event-schema.yaml',
    directory: 'events',
    indexFile: 'events-index.yaml',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '📅',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  credentials: {
    type: 'credentials',
    displayName: 'Credentials',
    displayNamePlural: 'Credentials',
    schemaFile: '/schemas/credentials-schema.json',
    directory: 'credentials',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '🔐',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  connections: {
    type: 'connections',
    displayName: 'Connections',
    displayNamePlural: 'Connections',
    schemaFile: '/schemas/connections-schema.json',
    uiSchemaFile: '/ui-schemas/connections-ui-schema.json',
    directory: 'connections',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '🔌',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },

  markdown: {
    type: 'markdown',
    displayName: 'Markdown',
    displayNamePlural: 'Markdown',
    schemaFile: '', // No schema needed for markdown
    directory: 'docs',
    extensions: ['.md', '.markdown'],
    icon: '📝',
    interactiveEditor: 'form', // Will use RawView for markdown
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  // Index file types - use existing schemas from param-schemas/
  'parameter-index': {
    type: 'parameter' as any,
    displayName: 'Parameters Index',
    displayNamePlural: 'Parameters Index',
    schemaFile: '/param-schemas/registry-schema.yaml', // Use existing registry schema
    directory: '',
    extensions: ['.yaml', '.yml'],
    icon: '📋',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  'context-index': {
    type: 'context' as any,
    displayName: 'Contexts Index',
    displayNamePlural: 'Contexts Index',
    schemaFile: '/param-schemas/contexts-index-schema.yaml',
    directory: '',
    extensions: ['.yaml', '.yml'],
    icon: '🏷️',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  'case-index': {
    type: 'case' as any,
    displayName: 'Cases Index',
    displayNamePlural: 'Cases Index',
    schemaFile: '/param-schemas/cases-index-schema.yaml',
    directory: '',
    extensions: ['.yaml', '.yml'],
    icon: '📦',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  'node-index': {
    type: 'node' as any,
    displayName: 'Nodes Index',
    displayNamePlural: 'Nodes Index',
    schemaFile: '/param-schemas/nodes-index-schema.yaml',
    directory: '',
    extensions: ['.yaml', '.yml'],
    icon: '🔵',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  },
  
  'events-index': {
    type: 'event' as any,
    displayName: 'Events Index',
    displayNamePlural: 'Events Index',
    schemaFile: '/param-schemas/events-index-schema.yaml',
    directory: '',
    extensions: ['.yaml', '.yml'],
    icon: '📅',
    interactiveEditor: 'form',
    supportsInteractiveEdit: true,
    supportsRawEdit: true
  }
};

/**
 * Get configuration for a file type
 */
export function getFileTypeConfig(type: string): FileTypeConfig | undefined {
  return FILE_TYPE_REGISTRY[type];
}

/**
 * Get schema file for a file type
 */
export function getSchemaFile(type: string): string | undefined {
  return FILE_TYPE_REGISTRY[type]?.schemaFile;
}

/**
 * Get UI schema file for a file type (optional)
 */
export function getUiSchemaFile(type: string): string | undefined {
  return FILE_TYPE_REGISTRY[type]?.uiSchemaFile;
}

/**
 * Get directory for a file type
 */
export function getDirectory(type: string): string | undefined {
  return FILE_TYPE_REGISTRY[type]?.directory;
}

/**
 * Get all directories to search for a file type (primary + alternatives)
 */
export function getAllDirectories(type: string): string[] {
  const config = FILE_TYPE_REGISTRY[type];
  if (!config) return [];
  
  return [
    config.directory,
    ...(config.alternativeDirectories || [])
  ];
}

/**
 * Get index file for a file type
 */
export function getIndexFile(type: string): string | undefined {
  return FILE_TYPE_REGISTRY[type]?.indexFile;
}

/**
 * Get file extensions for a file type
 */
export function getExtensions(type: string): string[] {
  return FILE_TYPE_REGISTRY[type]?.extensions || [];
}

/**
 * Determine file type from a file path
 */
export function inferFileTypeFromPath(path: string): string | undefined {
  for (const [type, config] of Object.entries(FILE_TYPE_REGISTRY)) {
    if (path.startsWith(config.directory + '/')) {
      return type;
    }
    if (config.alternativeDirectories) {
      for (const altDir of config.alternativeDirectories) {
        if (path.startsWith(altDir + '/')) {
          return type;
        }
      }
    }
  }
  return undefined;
}

/**
 * Check if a filename matches the extensions for a file type
 */
export function matchesFileType(filename: string, type: string): boolean {
  const extensions = getExtensions(type);
  return extensions.some(ext => filename.endsWith(ext));
}

