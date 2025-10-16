# Parameter Registry System Specification

## Overview

This document outlines the design and implementation of an immutable parameter management system for Dagnet conversion graphs. The system will provide a centralized registry for managing edge parameters (probability, standard deviation, costs) with extensible metadata support for future analytics integration.

## Core Requirements

### 1. Immutable Parameter Management
- Global parameter registry with canonical parameter references
- YAML-based parameter definitions with rich metadata
- Git-based persistence for version control and collaboration
- Support for key edge parameters: probability, standard deviation, cost (time and monetary)

### 2. Graph Editor Integration
- Interface for associating edges with canonical parameter references
- Ability to create and publish new parameters from within the graph editor
- Seamless parameter lookup and validation
- Real-time parameter value updates

### 3. Extensible Metadata Structure
- Support for parameter metadata (description, units, constraints, etc.)
- Preparation for future analytics integration (Bayesian analysis, MCMC)
- Data source specification for ongoing parameter updates
- Support for parameter hierarchies and dependencies

## Architecture

### 1. Parameter Registry Structure

```
param-registry/
├── registry.yaml                 # Main registry index
├── parameters/
│   ├── probability/
│   │   ├── conversion-rate-baseline.yaml
│   │   ├── email-signup-rate.yaml
│   │   └── checkout-completion.yaml
│   ├── cost/
│   │   ├── email-campaign-cost.yaml
│   │   ├── ad-click-cost.yaml
│   │   └── support-ticket-cost.yaml
│   └── time/
│       ├── email-response-time.yaml
│       ├── checkout-duration.yaml
│       └── support-resolution-time.yaml
├── schemas/
│   ├── parameter-schema.yaml     # Parameter definition schema
│   └── registry-schema.yaml     # Registry index schema
└── analytics/
    ├── data-sources.yaml        # Data source configurations
    └── update-schedules.yaml    # Parameter update schedules
```

### 2. YAML Schema Design

#### Parameter Definition Schema (`parameter-schema.yaml`)

```yaml
# Parameter definition schema
type: object
required: [id, name, type, value, metadata]
properties:
  id:
    type: string
    pattern: '^[a-z0-9-]+$'
    description: "Unique parameter identifier (slug)"
  
  name:
    type: string
    description: "Human-readable parameter name"
  
  type:
    type: string
    enum: [probability, cost, time, standard_deviation]
    description: "Parameter type classification"
  
  value:
    oneOf:
      - type: number
      - type: object
        properties:
          mean: { type: number }
          stdev: { type: number }
          distribution: { type: string }
    description: "Parameter value or distribution"
  
  metadata:
    type: object
    properties:
      description: { type: string }
      units: { type: string }
      constraints:
        type: object
        properties:
          min: { type: number }
          max: { type: number }
          discrete: { type: boolean }
      data_source:
        type: object
        properties:
          type: { type: string, enum: [sheets, api, file, manual] }
          url: { type: string }
          refresh_frequency: { type: string }
      analytics:
        type: object
        properties:
          bayesian_prior: { type: object }
          mcmc_config: { type: object }
          update_frequency: { type: string }
      tags: { type: array, items: { type: string } }
      created_at: { type: string, format: date-time }
      updated_at: { type: string, format: date-time }
      author: { type: string }
      version: { type: string }
```

#### Registry Index Schema (`registry-schema.yaml`)

```yaml
# Registry index schema
type: object
required: [version, parameters]
properties:
  version:
    type: string
    pattern: '^\\d+\\.\\d+\\.\\d+$'
  
  created_at:
    type: string
    format: date-time
  
  updated_at:
    type: string
    format: date-time
  
  parameters:
    type: array
    items:
      type: object
      required: [id, file_path, type, status]
      properties:
        id: { type: string }
        file_path: { type: string }
        type: { type: string }
        status: { type: string, enum: [active, deprecated, draft] }
        aliases: { type: array, items: { type: string } }
        dependencies: { type: array, items: { type: string } }
```

### 3. Parameter Definition Examples

#### Probability Parameter (`parameters/probability/conversion-rate-baseline.yaml`)

```yaml
id: conversion-rate-baseline
name: "Baseline Conversion Rate"
type: probability
value:
  mean: 0.15
  stdev: 0.03
  distribution: "beta"

metadata:
  description: "Baseline conversion rate for e-commerce checkout"
  units: "probability"
  constraints:
    min: 0.0
    max: 1.0
    discrete: false
  data_source:
    type: sheets
    url: "https://docs.google.com/spreadsheets/d/..."
    refresh_frequency: "daily"
  analytics:
    bayesian_prior:
      alpha: 2.0
      beta: 8.0
    mcmc_config:
      samples: 10000
      burn_in: 1000
    update_frequency: "weekly"
  tags: ["conversion", "checkout", "baseline"]
  created_at: "2025-01-15T10:00:00Z"
  updated_at: "2025-01-15T10:00:00Z"
  author: "data-team"
  version: "1.0.0"
```

#### Cost Parameter (`parameters/cost/email-campaign-cost.yaml`)

```yaml
id: email-campaign-cost
name: "Email Campaign Cost"
type: cost
value:
  mean: 0.05
  stdev: 0.01
  distribution: "lognormal"

metadata:
  description: "Cost per email sent in marketing campaigns"
  units: "USD"
  constraints:
    min: 0.0
    max: 1.0
  data_source:
    type: api
    url: "https://api.marketing-platform.com/costs"
    refresh_frequency: "hourly"
  analytics:
    bayesian_prior:
      mu: -3.0
      sigma: 0.5
    update_frequency: "daily"
  tags: ["email", "marketing", "cost"]
  created_at: "2025-01-15T10:00:00Z"
  updated_at: "2025-01-15T10:00:00Z"
  author: "marketing-team"
  version: "1.0.0"
```

### 4. Registry Index (`registry.yaml`)

```yaml
version: "1.0.0"
created_at: "2025-01-15T10:00:00Z"
updated_at: "2025-01-15T10:00:00Z"

parameters:
  - id: conversion-rate-baseline
    file_path: "parameters/probability/conversion-rate-baseline.yaml"
    type: probability
    status: active
    aliases: ["baseline-conversion", "checkout-rate"]
    dependencies: []
  
  - id: email-campaign-cost
    file_path: "parameters/cost/email-campaign-cost.yaml"
    type: cost
    status: active
    aliases: ["email-cost", "campaign-cost"]
    dependencies: []
  
  - id: checkout-duration
    file_path: "parameters/time/checkout-duration.yaml"
    type: time
    status: active
    aliases: ["checkout-time", "purchase-duration"]
    dependencies: ["conversion-rate-baseline"]
```

## Implementation Plan

### Phase 1: Core Infrastructure
1. **Parameter Registry Structure**
   - Create YAML schema definitions
   - Implement parameter validation
   - Set up Git-based storage structure

2. **Basic Parameter Management**
   - Parameter CRUD operations
   - Registry indexing and search
   - Parameter validation and constraints

### Phase 2: Graph Editor Integration
1. **Parameter Association UI**
   - Edge property panel enhancements
   - Parameter lookup and selection
   - Parameter reference display

2. **Parameter Creation Workflow**
   - Inline parameter creation from graph editor
   - Parameter validation and preview
   - Git commit workflow for new parameters

### Phase 3: Advanced Features
1. **Analytics Integration**
   - Data source configuration
   - Parameter update automation
   - Bayesian analysis preparation

2. **Collaboration Features**
   - Parameter versioning and history
   - Parameter approval workflows
   - Team parameter management

## Technical Implementation

### 1. Parameter Registry API

```typescript
interface ParameterRegistry {
  // Core operations
  getParameter(id: string): Promise<Parameter | null>;
  searchParameters(query: SearchQuery): Promise<Parameter[]>;
  createParameter(parameter: Parameter): Promise<string>;
  updateParameter(id: string, updates: Partial<Parameter>): Promise<void>;
  deleteParameter(id: string): Promise<void>;
  
  // Registry management
  getRegistry(): Promise<RegistryIndex>;
  refreshRegistry(): Promise<void>;
  
  // Git operations
  commitChanges(message: string): Promise<void>;
  pullUpdates(): Promise<void>;
  pushChanges(): Promise<void>;
}
```

### 2. Graph Editor Integration

```typescript
interface ParameterAssociation {
  edgeId: string;
  parameterId: string;
  parameterType: 'probability' | 'cost' | 'time';
  valueOverride?: number;
  metadata?: Record<string, any>;
}

interface GraphEditorExtensions {
  // Parameter association
  associateParameter(edgeId: string, parameterId: string): Promise<void>;
  disassociateParameter(edgeId: string): Promise<void>;
  getParameterAssociation(edgeId: string): Promise<ParameterAssociation | null>;
  
  // Parameter creation
  createParameterFromEdge(edgeId: string, parameterData: Parameter): Promise<string>;
  suggestParameters(edgeId: string): Promise<Parameter[]>;
  
  // Parameter updates
  syncParameterValues(): Promise<void>;
  updateParameterFromSource(parameterId: string): Promise<void>;
}
```

### 3. Git Integration

```typescript
interface GitIntegration {
  // Repository management
  initializeRepository(): Promise<void>;
  cloneRepository(url: string): Promise<void>;
  
  // Change management
  getChanges(): Promise<GitChange[]>;
  stageChanges(files: string[]): Promise<void>;
  commitChanges(message: string): Promise<string>;
  
  // Branch management
  createBranch(name: string): Promise<void>;
  switchBranch(name: string): Promise<void>;
  mergeBranch(source: string, target: string): Promise<void>;
  
  // Remote operations
  pushChanges(branch?: string): Promise<void>;
  pullChanges(): Promise<void>;
  fetchUpdates(): Promise<void>;
}
```

## Configuration

### 1. Registry Configuration (`config/registry.yaml`)

```yaml
registry:
  root_path: "./param-registry"
  git:
    remote_url: "https://github.com/your-org/param-registry.git"
    branch: "main"
    auth:
      type: "token"  # or "ssh"
      token: "${PARAM_REGISTRY_TOKEN}"
  
  validation:
    strict_mode: true
    require_metadata: true
    allow_deprecated: false
  
  analytics:
    enabled: true
    data_sources:
      - type: "sheets"
        url: "https://docs.google.com/spreadsheets/d/..."
        refresh_interval: "1h"
      - type: "api"
        url: "https://api.your-platform.com/parameters"
        refresh_interval: "6h"
  
  ui:
    show_analytics: true
    allow_inline_creation: true
    require_approval: false
```

### 2. Graph Editor Configuration

```yaml
graph_editor:
  parameter_registry:
    enabled: true
    auto_sync: true
    show_parameter_metadata: true
    
  parameter_association:
    allow_override: true
    require_justification: false
    show_confidence_intervals: true
    
  parameter_creation:
    auto_commit: false
    require_review: true
    default_author: "${USER_NAME}"
```

## Security Considerations

### 1. Authentication
- Git repository access control
- Parameter modification permissions
- Data source authentication

### 2. Validation
- Parameter value constraints
- Schema validation for all YAML files
- Cross-parameter dependency validation

### 3. Audit Trail
- Parameter change history
- User attribution for all changes
- Rollback capabilities

## Future Extensions

### 1. Analytics Integration
- Bayesian parameter estimation
- MCMC sampling for uncertainty quantification
- Automated parameter updates from data sources

### 2. Advanced Features
- Parameter sensitivity analysis
- Monte Carlo simulation support
- Parameter optimization workflows

### 3. Collaboration
- Parameter review and approval workflows
- Team parameter management
- Parameter sharing across organizations

## Migration Strategy

### 1. Existing Graph Migration
- Extract parameters from existing graphs
- Create parameter registry entries
- Update graph references to use parameter IDs

### 2. Gradual Adoption
- Start with new graphs using parameter registry
- Migrate existing graphs incrementally
- Maintain backward compatibility during transition

### 3. Training and Documentation
- User guides for parameter management
- Best practices documentation
- Video tutorials for common workflows

This specification provides a comprehensive foundation for implementing the parameter registry system while maintaining flexibility for future enhancements and analytics integration.
