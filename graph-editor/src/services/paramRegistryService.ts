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

export interface ContextsFile {
  contexts: Context[];
  metadata: {
    version: string;
    created_at: string;
    updated_at: string;
    description?: string;
    author?: string;
    changelog?: any[];
  };
}

class ParamRegistryService {
  private baseUrl: string;
  private config: RegistryConfig;

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
    const basePath = this.config.gitBasePath || 'params';
    const fullPath = `${basePath}/${path}`;
    
    // Override repo if specified in config
    const repoOwner = this.config.gitRepoOwner || gitConfig.repoOwner;
    const repoName = this.config.gitRepoName || gitConfig.repoName;
    
    // Temporarily override gitConfig if different repo specified
    const originalOwner = gitConfig.repoOwner;
    const originalName = gitConfig.repoName;
    
    try {
      if (this.config.gitRepoOwner) {
        (gitConfig as any).repoOwner = repoOwner;
      }
      if (this.config.gitRepoName) {
        (gitConfig as any).repoName = repoName;
      }
      
      const result = await gitService.getFileContent(fullPath, branch);
      
      if (!result.success) {
        throw new Error(`Failed to load from git: ${result.error || result.message}`);
      }
      
      return result.data.content;
    } finally {
      // Restore original config
      (gitConfig as any).repoOwner = originalOwner;
      (gitConfig as any).repoName = originalName;
    }
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

  // Load contexts.yaml
  async loadContexts(): Promise<ContextsFile> {
    const yamlText = await this.loadFile('contexts.yaml');
    const data = yaml.load(yamlText) as ContextsFile;
    return data;
  }

  // Load registry.yaml
  async loadRegistry(): Promise<Registry> {
    const yamlText = await this.loadFile('registry.yaml');
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

  // Save contexts (for development - would need backend API for production)
  async saveContexts(contexts: ContextsFile): Promise<void> {
    // In production, this would POST to an API
    // For now, we'll just download as YAML file
    const yamlStr = yaml.dump(contexts);
    const blob = new Blob([yamlStr], { type: 'application/x-yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contexts.yaml';
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

  // Load a schema file
  async loadSchema(schemaName: string): Promise<any> {
    const yamlText = await this.loadFile(`schemas/${schemaName}`);
    const schema = yaml.load(yamlText);
    return schema;
  }
}

// Export singleton instance
export const paramRegistryService = new ParamRegistryService();

