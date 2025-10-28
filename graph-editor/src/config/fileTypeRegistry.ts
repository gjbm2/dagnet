/**
 * File Type Registry
 * 
 * Central configuration for all file types in the application.
 * Maps file types to their schemas, directories, index files, and other metadata.
 */

export interface FileTypeConfig {
  /** The type identifier (matches ObjectType) */
  type: 'graph' | 'parameter' | 'context' | 'case';
  
  /** Display name (singular) */
  displayName: string;
  
  /** Display name (plural) */
  displayNamePlural: string;
  
  /** JSON Schema file for validation and form generation */
  schemaFile: string;
  
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
    schemaFile: 'https://raw.githubusercontent.com/gjbm2/dagnet/main/schema/conversion-graph-1.0.0.json',
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
    schemaFile: 'https://raw.githubusercontent.com/gjbm2/dagnet/main/param-registry/schemas/parameter-schema.yaml',
    directory: 'parameters',
    alternativeDirectories: ['params'],
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
    schemaFile: 'https://raw.githubusercontent.com/gjbm2/dagnet/main/param-registry/schemas/context-definition-schema.yaml',
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
    schemaFile: 'https://raw.githubusercontent.com/gjbm2/dagnet/main/param-registry/schemas/case-parameter-schema.yaml',
    directory: 'cases',
    indexFile: 'cases-index.yaml',
    extensions: ['.yaml', '.yml', '.json'],
    icon: '📦',
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

