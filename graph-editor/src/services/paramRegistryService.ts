import yaml from 'js-yaml';
import { gitService } from './gitService';
import { gitConfig } from '../config/gitConfig';

// Base URL for registry - defaults to local development
const REGISTRY_BASE_URL = import.meta.env.VITE_PARAM_REGISTRY_URL || '/param-registry';

export type RegistrySource = 'local' | 'git';

export interface RegistryConfig {
  source: RegistrySource;
  gitBranch?: string;
  gitBasePath?: string;  // e.g., 'params' or 'param-registry'
  gitRepoOwner?: string;
  gitRepoName?: string;
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

export interface Parameter {
  id: string;
  name: string;
  type: 'probability' | 'monetary_cost' | 'time_cost' | 'standard_deviation';
  value: number | {
    value: number;
    stdev?: number;
    distribution?: string;
    min?: number;
    max?: number;
    currency?: string;
    units?: string;
  };
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
  parameter_id: string;
  parameter_type: string;
  name: string;
  description?: string;
  case: {
    id: string;
    slug?: string;
    status: string;
    platform?: any;
    variants: any[];
  };
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
    const basePath = this.config.gitBasePath || 'registry';
    const fullPath = `${basePath}/${path}`;
    
    // Use config repo or fall back to default
    const repoOwner = this.config.gitRepoOwner || gitConfig.repoOwner;
    const repoName = this.config.gitRepoName || gitConfig.repoName;
    
    // Make direct GitHub API call to support different repos
    const apiUrl = `${gitConfig.githubApiBase}/repos/${repoOwner}/${repoName}/contents/${fullPath}?ref=${branch}`;
    
    const headers: HeadersInit = {
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    
    if (gitConfig.githubToken && gitConfig.githubToken.trim() !== '') {
      headers['Authorization'] = `token ${gitConfig.githubToken}`;
    }
    
    console.log(`Loading from GitHub: ${repoOwner}/${repoName} - ${fullPath}`);
    
    const response = await fetch(apiUrl, { headers });
    
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
    const index = await this.loadContextsIndex();
    const entry = index.contexts.find(c => c.id === contextId);
    
    if (!entry) {
      throw new Error(`Context ${contextId} not found in index`);
    }
    
    const yamlText = await this.loadFile(entry.file_path);
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
      const basePath = this.config.gitBasePath || 'registry';
      const graphsPath = `${basePath}/graphs`;
      
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
    const index = await this.loadCasesIndex();
    const entry = index.cases.find(c => c.id === caseId);
    
    if (!entry) {
      throw new Error(`Case ${caseId} not found in index`);
    }
    
    const yamlText = await this.loadFile(entry.file_path);
    const caseData = yaml.load(yamlText) as Case;
    
    return caseData;
  }

  // Load parameters-index.yaml
  async loadRegistry(): Promise<Registry> {
    const yamlText = await this.loadFile('parameters-index.yaml');
    const data = yaml.load(yamlText) as Registry;
    return data;
  }

  // Load a specific parameter by ID
  async loadParameter(parameterId: string): Promise<Parameter> {
    const registry = await this.loadRegistry();
    const entry = registry.parameters.find(p => p.id === parameterId);
    
    if (!entry) {
      throw new Error(`Parameter ${parameterId} not found in registry`);
    }
    
    const yamlText = await this.loadFile(entry.file_path);
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
    a.download = `${caseData.parameter_id}.yaml`;
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

