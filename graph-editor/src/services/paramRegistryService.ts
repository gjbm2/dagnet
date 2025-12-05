import yaml from 'js-yaml';
import { gitService } from './gitService';
import { gitConfig } from '../config/gitConfig';
import { getFileTypeConfig, getAllDirectories, getIndexFile } from '../config/fileTypeRegistry';

// Base URL for registry - defaults to local development
const REGISTRY_BASE_URL = import.meta.env.VITE_PARAM_REGISTRY_URL || '/param-registry';

export type RegistrySource = 'local' | 'git';

export interface RegistryConfig {
  source: RegistrySource;
  gitBranch?: string;
  gitBasePath?: string;  // e.g., 'params' or 'param-registry'
  gitRepoOwner?: string;
  gitRepoName?: string;
  gitToken?: string;  // GitHub token for authentication
}

export interface Context {
  id: string;
  name: string;
  description?: string;
  type: 'categorical' | 'ordinal' | 'continuous';
  values: Array<{
    id: string;
    label: string;
    description?: string;
    order?: number;
    aliases?: string[];
  }>;
  comparison_support?: boolean;
  default_value?: string;
  metadata?: any;
}

export interface ParameterValue {
  mean: number;
  stdev?: number;
  distribution?: 'normal' | 'beta' | 'gamma' | 'lognormal' | 'uniform';
  n?: number; // Aggregate sample size (sum of n_daily if present)
  k?: number; // Aggregate successes (sum of k_daily if present)
  
  // Daily breakdown (optional - if source supports daily data)
  n_daily?: number[]; // Daily sample sizes
  k_daily?: number[]; // Daily successes
  dates?: string[]; // Dates (YYYY-MM-DD) corresponding to n_daily/k_daily
  
  // Slice identification (PRIMARY INDEX KEY for data lookup)
  sliceDSL?: string; // Canonical DSL for this data slice (e.g., "context(channel:google)")
                     // Empty string or undefined = uncontexted, all-time slice
                     // Used for filtering to specific context/window combinations
  
  // Query signature (for consistency checking - NOT for indexing)
  query_signature?: string; // SHA-256 hash of query configuration
                            // Used to detect if query config changed (topology, connection, mappings)
                            // Multiple slices can share same signature
  
  window_from?: string; // ISO 8601 timestamp
  window_to?: string; // ISO 8601 timestamp
  context_id?: string;
  data_source?: {
    type: 'sheets' | 'api' | 'file' | 'manual' | 'calculated' | 'analytics' | 'amplitude' | 'statsig' | 'optimizely';
    retrieved_at?: string; // ISO date-time
    edited_at?: string; // ISO date-time
    query?: any; // Query configuration object
    full_query?: string; // Complete DSL query string
    debug_trace?: string; // Complete execution trace as JSON string
    experiment_id?: string; // Experiment/gate ID for A/B test sources (e.g., Statsig gate_id)
  };
}

export interface Parameter {
  id: string;
  name: string;
  type: 'probability' | 'cost_gbp' | 'cost_time';
  values: ParameterValue[];
  // Query strings - mastered on graph edge, copied here for standalone use
  query?: string; // Main query DSL (e.g., "from(A).to(B).visited(C)")
  query_overridden?: boolean; // If true, query was manually edited
  n_query?: string; // Optional: explicit query for n (denominator) when it differs from k query
  n_query_overridden?: boolean; // If true, n_query was manually edited
  metadata: {
    description: string;
    units?: string;
    constraints?: any;
    data_source?: any;
    analytics?: any;
    tags?: string[];
    created_at: string;
    updated_at?: string;
    author: string;
    version: string;
    status?: 'active' | 'deprecated' | 'draft' | 'archived';
    aliases?: string[];
    references?: any[];
  };
}

export interface RegistryEntry {
  id: string;
  file_path: string;
  type: string;
  status: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  author?: string;
  version?: string;
}

export interface Registry {
  version: string;
  created_at: string;
  updated_at?: string;
  parameters: RegistryEntry[];
  contexts?: RegistryEntry[];
  cases?: RegistryEntry[];
}

export interface ContextEntry {
  id: string;
  file_path: string;
  type: string;
  status: string;
  category?: string;
  created_at?: string;
  updated_at?: string;
  version?: string;
  usage_count?: number;
}

export interface ContextsIndex {
  version: string;
  created_at: string;
  updated_at?: string;
  contexts: ContextEntry[];
}

export interface Graph {
  nodes: any[];
  edges: any[];
  policies: any;
  metadata: any;
}

export interface CaseEntry {
  id: string;
  file_path: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  version?: string;
}

export interface CasesIndex {
  version: string;
  created_at: string;
  updated_at?: string;
  cases: CaseEntry[];
}

export interface Case {
  // Canonical case identifier (matches root-level id in case files)
  id: string;
  parameter_type: string;
  name: string;
  description?: string;
  case: {
    uuid?: string;
    status: string;
    platform?: any;
    variants: any[];
  };
  metadata?: any;
}

export interface NodeEntry {
  id: string;
  file_path?: string | null;
  status: string;
  type?: string;
  category?: string;
  tags?: string[];
  graphs_using?: string[];
  usage_count?: number;
  created_at?: string;
  updated_at?: string;
  author?: string;
  version?: string;
}

export interface NodesIndex {
  version: string;
  created_at: string;
  updated_at?: string;
  nodes: NodeEntry[];
}

export interface Node {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  resources?: Array<{
    type: string;
    url: string;
    title?: string;
    description?: string;
  }>;
  url?: string;
  images?: Array<{
    image_id: string;
    caption: string;
    file_extension: 'png' | 'jpg' | 'jpeg';
    uploaded_at?: string;
    uploaded_by?: string;
  }>;
  metadata?: any;
}

class ParamRegistryService {
  private baseUrl: string;
  private config: RegistryConfig;
  
  // Schema configuration - always from dagnet repo
  private readonly SCHEMA_REPO_OWNER = 'gjbm2';
  private readonly SCHEMA_REPO_NAME = 'dagnet';
  private readonly SCHEMA_BASE_PATH = 'param-registry/schemas';
  private readonly SCHEMA_BRANCH = 'main';

  constructor(baseUrl: string = REGISTRY_BASE_URL, config?: RegistryConfig) {
    this.baseUrl = baseUrl;
    this.config = config || { source: 'local' };
  }

  // Update configuration
  setConfig(config: RegistryConfig) {
    this.config = config;
  }

  private async loadFromGit(path: string): Promise<string> {
    const branch = this.config.gitBranch || gitConfig.branch;
    const basePath = this.config.gitBasePath;
    const fullPath = basePath ? `${basePath}/${path}` : path;
    
    // Use config repo or fall back to default
    const repoOwner = this.config.gitRepoOwner || gitConfig.repoOwner;
    const repoName = this.config.gitRepoName || gitConfig.repoName;
    
    // Make direct GitHub API call to support different repos
    const apiUrl = `${gitConfig.githubApiBase}/repos/${repoOwner}/${repoName}/contents/${fullPath}?ref=${branch}`;
    
    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    
    // Use provided token first, then fall back to gitConfig
    const token = this.config.gitToken || gitConfig.githubToken;
    if (token && token.trim() !== '') {
      headers['Authorization'] = `token ${token}`;
    }
    
    console.log(`Loading from GitHub: ${repoOwner}/${repoName} - ${fullPath}`);
    
    const response = await fetch(apiUrl, { 
      headers
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Git API Error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    // Decode base64 content
    const content = atob(data.content.replace(/\n/g, ''));
    
    return content;
  }

  private async loadFromLocal(path: string): Promise<string> {
    const url = `${this.baseUrl}/${path}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to load from ${url}: ${response.statusText}`);
    }
    
    return await response.text();
  }

  private async loadFile(path: string): Promise<string> {
    if (this.config.source === 'git') {
      return this.loadFromGit(path);
    } else {
      return this.loadFromLocal(path);
    }
  }

  // Load contexts-index.yaml
  async loadContextsIndex(): Promise<ContextsIndex> {
    const yamlText = await this.loadFile('contexts-index.yaml');
    const data = yaml.load(yamlText) as ContextsIndex;
    return data;
  }

  // Load a specific context by ID
  async loadContext(contextId: string): Promise<Context> {
    try {
      const index = await this.loadContextsIndex();
      const entry = index.contexts.find(c => c.id === contextId);
      
      if (entry) {
        const yamlText = await this.loadFile(entry.file_path);
        const context = yaml.load(yamlText) as Context;
        return context;
      }
    } catch (indexError) {
      console.log(`Context index not available, trying direct file load:`, indexError);
    }
    
    // Fallback: try loading directly using directory config from registry
    const config = getFileTypeConfig('context');
    const directory = config?.directory || 'contexts';
    const filePath = contextId.includes('/') ? contextId : `${directory}/${contextId}`;
    console.log(`Loading context directly from: ${filePath}`);
    
    const yamlText = await this.loadFile(filePath);
    const context = yaml.load(yamlText) as Context;
    
    return context;
  }

  // Load graphs index (list of available graphs)
  async loadGraphs(): Promise<any[]> {
    // For now, get directory contents from GitHub
    if (this.config.source === 'git') {
      const repoOwner = this.config.gitRepoOwner || gitConfig.repoOwner;
      const repoName = this.config.gitRepoName || gitConfig.repoName;
      const branch = this.config.gitBranch || gitConfig.branch;
      const basePath = this.config.gitBasePath;
      const graphsPath = basePath ? `${basePath}/${gitConfig.graphsPath}` : gitConfig.graphsPath;
      
      const apiUrl = `${gitConfig.githubApiBase}/repos/${repoOwner}/${repoName}/contents/${graphsPath}?ref=${branch}`;
      
      const headers: HeadersInit = {
        'Accept': 'application/vnd.github.v3+json',
      };
      
      if (gitConfig.githubToken) {
        headers['Authorization'] = `token ${gitConfig.githubToken}`;
      }
      
      const response = await fetch(apiUrl, { headers });
      
      if (!response.ok) {
        throw new Error(`Failed to load graphs directory: ${response.status}`);
      }
      
      const files = await response.json();
      return files.filter((f: any) => f.name.endsWith('.json'));
    }
    
    return [];
  }

  // Load a specific graph by filename
  async loadGraph(filename: string): Promise<Graph> {
    const yamlText = await this.loadFile(`graphs/${filename}`);
    const graph = JSON.parse(yamlText) as Graph;
    return graph;
  }

  // Load cases-index.yaml
  async loadCasesIndex(): Promise<CasesIndex> {
    const yamlText = await this.loadFile('cases-index.yaml');
    const data = yaml.load(yamlText) as CasesIndex;
    return data;
  }

  // Load a specific case by ID
  async loadCase(caseId: string): Promise<Case> {
    try {
      const index = await this.loadCasesIndex();
      const entry = index.cases.find(c => c.id === caseId);
      
      if (entry) {
        const yamlText = await this.loadFile(entry.file_path);
        const caseData = yaml.load(yamlText) as Case;
        return caseData;
      }
    } catch (indexError) {
      console.log(`Case index not available, trying direct file load:`, indexError);
    }
    
    // Fallback: try loading directly using directory config from registry
    const config = getFileTypeConfig('case');
    const directory = config?.directory || 'cases';
    const filePath = caseId.includes('/') ? caseId : `${directory}/${caseId}`;
    console.log(`Loading case directly from: ${filePath}`);
    
    const yamlText = await this.loadFile(filePath);
    const caseData = yaml.load(yamlText) as Case;
    
    return caseData;
  }

  // Load nodes-index.yaml
  async loadNodesIndex(): Promise<NodesIndex> {
    const yamlText = await this.loadFile('nodes-index.yaml');
    const data = yaml.load(yamlText) as NodesIndex;
    return data;
  }

  // Load a specific node by ID
  async loadNode(nodeId: string): Promise<Node> {
    // Strip extension if present
    const cleanId = nodeId.replace(/\.(yaml|yml|json)$/, '');
    
    try {
      const index = await this.loadNodesIndex();
      const entry = index.nodes.find(n => n.id === cleanId);
      
      if (entry && entry.file_path) {
        const yamlText = await this.loadFile(entry.file_path);
        const nodeData = yaml.load(yamlText) as Node;
        return nodeData;
      }
      
      // Node exists in index but has no file (planned node) - return minimal node
      if (entry) {
        console.log(`Node ${cleanId} exists in index but has no file (planned), returning minimal node`);
        return {
          id: cleanId,
          name: cleanId,
          description: 'Planned node (no detail file yet)',
          tags: entry.tags || []
        };
      }
    } catch (indexError) {
      console.log(`Node index not available, trying direct file load:`, indexError);
    }
    
    // Fallback: try loading directly using directory config from registry
    const config = getFileTypeConfig('node');
    const directory = config?.directory || 'nodes';
    
    // Try with different extensions
    const extensions = ['.yaml', '.yml', '.json'];
    for (const ext of extensions) {
      const filePath = nodeId.includes('/') ? nodeId : `${directory}/${cleanId}${ext}`;
      console.log(`Trying to load node from: ${filePath}`);
      
      try {
        const yamlText = await this.loadFile(filePath);
        const nodeData = yaml.load(yamlText) as Node;
        return nodeData;
      } catch (error) {
        // Try next extension
        continue;
      }
    }
    
    // If all else fails, return a minimal node object
    console.warn(`Could not load node ${cleanId}, returning minimal default`);
    return {
      id: cleanId,
      name: cleanId,
      description: 'Node definition not found',
      tags: []
    };
  }

  // Load events-index.yaml
  async loadEventsIndex(): Promise<any> {
    const yamlText = await this.loadFile('events-index.yaml');
    const data = yaml.load(yamlText) as any;
    return data;
  }

  // Load a specific event by ID
  async loadEvent(eventId: string): Promise<any> {
    // Strip extension if present
    const cleanId = eventId.replace(/\.(yaml|yml|json)$/, '');
    
    try {
      const index = await this.loadEventsIndex();
      const entry = index.events?.find((e: any) => e.id === cleanId);
      
      if (entry && entry.file_path) {
        const yamlText = await this.loadFile(entry.file_path);
        const eventData = yaml.load(yamlText) as any;
        return eventData;
      }
      
      // Event exists in index but has no file (planned event) - return minimal event
      if (entry) {
        console.log(`Event ${cleanId} exists in index but has no file (planned), returning minimal event`);
        return {
          id: cleanId,
          name: cleanId,
          description: 'Planned event (no detail file yet)',
          tags: entry.tags || []
        };
      }
    } catch (indexError) {
      console.log(`Event index not available, trying direct file load:`, indexError);
    }
    
    // Fallback: try loading directly using directory config from registry
    const config = getFileTypeConfig('event');
    const directory = config?.directory || 'events';
    
    // Try with different extensions
    const extensions = ['.yaml', '.yml', '.json'];
    for (const ext of extensions) {
      const filePath = eventId.includes('/') ? eventId : `${directory}/${cleanId}${ext}`;
      console.log(`Trying to load event from: ${filePath}`);
      
      try {
        const yamlText = await this.loadFile(filePath);
        const eventData = yaml.load(yamlText) as any;
        return eventData;
      } catch (error) {
        // Try next extension
        continue;
      }
    }
    
    // If all else fails, return a minimal event object without provider_event_names
    console.warn(`Could not load event ${cleanId}, returning minimal default`);
    return {
      id: cleanId,
      name: cleanId,
      description: 'Event definition not found',
      tags: []
    };
  }

  // Load parameters-index.yaml
  async loadRegistry(): Promise<Registry> {
    try {
      const yamlText = await this.loadFile('parameters-index.yaml');
      const data = yaml.load(yamlText) as Registry;
      return data;
    } catch (error) {
      // Registry file doesn't exist, return empty registry
      return {
        version: '1.0.0',
        created_at: new Date().toISOString(),
        parameters: [],
        contexts: [],
        cases: []
      };
    }
  }

  // Load a specific parameter by ID
  async loadParameter(parameterId: string): Promise<Parameter> {
    try {
      const registry = await this.loadRegistry();
      const entry = registry.parameters.find(p => p.id === parameterId);
      
      if (entry) {
        const yamlText = await this.loadFile(entry.file_path);
        const param = yaml.load(yamlText) as Parameter;
        return param;
      }
    } catch (registryError) {
      console.log(`Parameter registry not available, trying direct file load:`, registryError);
    }
    
    // Fallback: try loading directly using directory config from registry
    let filePath = parameterId;
    if (!parameterId.includes('/')) {
      const directories = getAllDirectories('parameter');
      console.log(`Trying directories for parameter: ${directories.join(', ')}`);
      
      // Try each configured directory
      for (const dir of directories) {
        try {
          filePath = `${dir}/${parameterId}`;
          const yamlText = await this.loadFile(filePath);
          const param = yaml.load(yamlText) as Parameter;
          return param;
        } catch (e) {
          // Continue to next directory
          console.log(`Not found in ${dir}, trying next...`);
        }
      }
      
      // If all fail, use the primary directory for the final attempt
      filePath = `${directories[0]}/${parameterId}`;
    }
    
    console.log(`Loading parameter directly from: ${filePath}`);
    const yamlText = await this.loadFile(filePath);
    const param = yaml.load(yamlText) as Parameter;
    
    return param;
  }

  // Save context (for development - would need backend API for production)
  async saveContext(context: Context): Promise<void> {
    const yamlStr = yaml.dump(context);
    const blob = new Blob([yamlStr], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${context.id}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Save graph (for development - would need backend API for production)
  async saveGraph(graph: Graph): Promise<void> {
    const jsonStr = JSON.stringify(graph, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graph.metadata?.name || 'graph'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Save case (for development - would need backend API for production)
  async saveCase(caseData: Case): Promise<void> {
    const yamlStr = yaml.dump(caseData);
    const blob = new Blob([yamlStr], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${caseData.id}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Save parameter (for development - would need backend API for production)
  async saveParameter(parameter: Parameter): Promise<void> {
    // In production, this would POST to an API
    // For now, we'll just download as YAML file
    const yamlStr = yaml.dump(parameter);
    const blob = new Blob([yamlStr], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${parameter.id}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Load a schema file - ALWAYS from dagnet repo
  async loadSchema(schemaName: string): Promise<any> {
    const fullPath = `${this.SCHEMA_BASE_PATH}/${schemaName}`;
    const apiUrl = `${gitConfig.githubApiBase}/repos/${this.SCHEMA_REPO_OWNER}/${this.SCHEMA_REPO_NAME}/contents/${fullPath}?ref=${this.SCHEMA_BRANCH}`;
    
    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    
    if (gitConfig.githubToken && gitConfig.githubToken.trim() !== '') {
      headers['Authorization'] = `token ${gitConfig.githubToken}`;
    }
    
    console.log(`Loading schema from GitHub: ${this.SCHEMA_REPO_OWNER}/${this.SCHEMA_REPO_NAME} - ${fullPath}`);
    
    const response = await fetch(apiUrl, { headers });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to load schema: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    const content = atob(data.content.replace(/\n/g, ''));
    const schema = yaml.load(content);
    
    return schema;
  }
}

// Export singleton instance
export const paramRegistryService = new ParamRegistryService();

