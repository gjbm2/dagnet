import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RJSFSchema } from '@rjsf/utils';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import { 
  paramRegistryService, 
  Context, 
  Parameter, 
  RegistryEntry,
  RegistrySource 
} from '../services/paramRegistryService';

type ObjectType = 'parameters' | 'contexts' | 'cases' | 'graphs';

type RepositoryOption = {
  id: string;
  label: string;
  source: RegistrySource;
  gitBasePath?: string;
  gitBranch?: string;
  gitRepoOwner?: string;
  gitRepoName?: string;
};

interface ListItem {
  id: string;
  name: string;
  type?: string;
  status?: string;
}

export default function ParamsPage() {
  const navigate = useNavigate();
  
  // Repository options
  const repositories: RepositoryOption[] = [
    {
      id: 'dagnet-git',
      label: 'dagnet (Git) - Test Data',
      source: 'git',
      gitBasePath: 'param-registry/test',
      gitBranch: 'main',
      gitRepoOwner: 'gjbm2',
      gitRepoName: 'dagnet'
    },
    {
      id: '<private-repo>',
      label: '<private-repo> (Git)',
      source: 'git',
      gitBasePath: 'registry',
      gitBranch: 'main',
      gitRepoOwner: 'gjbm2',
      gitRepoName: '<private-repo>'
    }
  ];
  
  // State for three panels
  const [selectedRepo, setSelectedRepo] = useState<string>('dagnet-git');
  const [selectedObjectType, setSelectedObjectType] = useState<ObjectType>('parameters');
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemData, setSelectedItemData] = useState<any>(null);
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  // Update service config when repository changes
  useEffect(() => {
    const repo = repositories.find(r => r.id === selectedRepo);
    if (repo) {
      paramRegistryService.setConfig({
        source: repo.source,
        gitBasePath: repo.gitBasePath,
        gitBranch: repo.gitBranch,
        gitRepoOwner: repo.gitRepoOwner,
        gitRepoName: repo.gitRepoName
      });
    }
  }, [selectedRepo]);

  // Load items when object type or repository changes
  useEffect(() => {
    loadItems();
  }, [selectedObjectType, selectedRepo]);

  // Load selected item data when selection changes
  useEffect(() => {
    if (selectedItemId && !isCreatingNew) {
      loadItemData();
    }
  }, [selectedItemId, isCreatingNew]);

  // Load schema when object type changes
  useEffect(() => {
    loadSchemaForType();
  }, [selectedObjectType]);

  const loadItems = async () => {
    setIsLoading(true);
    setError(null);
    try {
      if (selectedObjectType === 'parameters') {
        const registry = await paramRegistryService.loadRegistry();
        const paramItems: ListItem[] = registry.parameters.map(p => ({
          id: p.id,
          name: p.id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          type: p.type,
          status: p.status
        }));
        setItems(paramItems);
      } else if (selectedObjectType === 'contexts') {
        const contextsIndex = await paramRegistryService.loadContextsIndex();
        const contextItems: ListItem[] = contextsIndex.contexts.map(c => ({
          id: c.id,
          name: c.id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          type: c.type,
          status: c.status
        }));
        setItems(contextItems);
      } else if (selectedObjectType === 'cases') {
        const casesIndex = await paramRegistryService.loadCasesIndex();
        const caseItems: ListItem[] = casesIndex.cases.map(c => ({
          id: c.id,
          name: c.id.replace(/^case-/, '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          type: 'case',
          status: c.status
        }));
        setItems(caseItems);
      } else if (selectedObjectType === 'graphs') {
        const graphs = await paramRegistryService.loadGraphs();
        const graphItems: ListItem[] = graphs.map((g: any) => ({
          id: g.name,
          name: g.name.replace(/\.json$/, '').replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
          type: 'graph'
        }));
        setItems(graphItems);
      }
    } catch (err) {
      setError(`Failed to load ${selectedObjectType}: ${err}`);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadItemData = async () => {
    if (!selectedItemId) return;
    
    setIsLoading(true);
    setError(null);
    try {
      if (selectedObjectType === 'parameters') {
        const param = await paramRegistryService.loadParameter(selectedItemId);
        setSelectedItemData(param);
      } else if (selectedObjectType === 'contexts') {
        const context = await paramRegistryService.loadContext(selectedItemId);
        setSelectedItemData(context);
      } else if (selectedObjectType === 'cases') {
        const caseData = await paramRegistryService.loadCase(selectedItemId);
        setSelectedItemData(caseData);
      } else if (selectedObjectType === 'graphs') {
        const graph = await paramRegistryService.loadGraph(selectedItemId);
        setSelectedItemData(graph);
      }
    } catch (err) {
      setError(`Failed to load item: ${err}`);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadSchemaForType = async () => {
    setIsLoading(true);
    setError(null);
    try {
      let schemaData;
      if (selectedObjectType === 'parameters') {
        schemaData = await paramRegistryService.loadSchema('parameter-schema.yaml');
      } else if (selectedObjectType === 'contexts') {
        schemaData = await paramRegistryService.loadSchema('context-definition-schema.yaml');
      } else if (selectedObjectType === 'cases') {
        schemaData = await paramRegistryService.loadSchema('case-parameter-schema.yaml');
      } else if (selectedObjectType === 'graphs') {
        // Load graph schema from /schema directory (JSON format)
        const response = await fetch('/schema/conversion-graph-1.0.0.json');
        if (!response.ok) {
          throw new Error('Failed to load graph schema');
        }
        schemaData = await response.json();
      }
      setSchema(schemaData as RJSFSchema);
    } catch (err) {
      setError(`Failed to load schema: ${err}`);
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateNew = () => {
    setIsCreatingNew(true);
    setSelectedItemId(null);
    
    // Create empty template based on type
    if (selectedObjectType === 'parameters') {
      setSelectedItemData({
        id: '',
        name: '',
        type: 'probability',
        value: 0,
        metadata: {
          description: '',
          created_at: new Date().toISOString(),
          author: '',
          version: '1.0.0',
          status: 'active'
        }
      });
    } else if (selectedObjectType === 'contexts') {
      setSelectedItemData({
        id: '',
        name: '',
        description: '',
        type: 'categorical',
        values: [],
        metadata: {
          created_at: new Date().toISOString(),
          version: '1.0.0',
          status: 'active'
        }
      });
    } else if (selectedObjectType === 'cases') {
      setSelectedItemData({
        parameter_id: 'case-',
        parameter_type: 'case',
        name: '',
        description: '',
        case: {
          id: '',
          status: 'active',
          variants: [
            { name: 'control', weight: 0.5, description: '' },
            { name: 'treatment', weight: 0.5, description: '' }
          ]
        },
        metadata: {
          created_at: new Date().toISOString(),
          version: '1.0.0',
          tags: []
        }
      });
    } else if (selectedObjectType === 'graphs') {
      setSelectedItemData({
        nodes: [],
        edges: [],
        policies: {
          default_outcome: 'abandon',
          overflow_policy: 'error',
          free_edge_policy: 'complement'
        },
        metadata: {
          version: '1.0.0',
          created_at: new Date().toISOString(),
          author: '',
          description: ''
        }
      });
    }
  };

  const handleSave = async (formData: any) => {
    try {
      if (selectedObjectType === 'parameters') {
        await paramRegistryService.saveParameter(formData);
        alert('Parameter saved! (Downloaded as YAML file)');
      } else if (selectedObjectType === 'contexts') {
        await paramRegistryService.saveContext(formData);
        alert('Context saved! (Downloaded as YAML file)');
      } else if (selectedObjectType === 'cases') {
        await paramRegistryService.saveCase(formData);
        alert('Case saved! (Downloaded as YAML file)');
      } else if (selectedObjectType === 'graphs') {
        await paramRegistryService.saveGraph(formData);
        alert('Graph saved! (Downloaded as JSON file)');
      }
      
      setIsCreatingNew(false);
      loadItems();
    } catch (err) {
      setError(`Failed to save: ${err}`);
      console.error(err);
    }
  };

  const handleOpenInGraphEditor = () => {
    if (selectedObjectType === 'graphs' && selectedItemData) {
      // Open graph editor in new window
      const graphName = selectedItemData.metadata?.name || selectedItemId;
      window.open(`/?graph=${graphName}`, '_blank');
    }
  };

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      overflow: 'hidden'
    }}>
      {/* Top Bar */}
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '50px',
        background: '#f8f9fa',
        borderBottom: '1px solid #dee2e6',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        zIndex: 1000,
        gap: '16px'
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            padding: '8px 16px',
            fontSize: '14px',
            cursor: 'pointer',
            fontWeight: '500'
          }}
        >
          ← Back to Graph Editor
        </button>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: '600', color: '#333' }}>
          Parameter Registry Editor
        </h1>
        
        {/* Repository Selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ fontSize: '13px', fontWeight: '500', color: '#666' }}>
            Repository:
          </label>
          <select
            value={selectedRepo}
            onChange={(e) => {
              setSelectedRepo(e.target.value);
              setSelectedItemId(null);
              setSelectedItemData(null);
              setIsCreatingNew(false);
            }}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              border: '1px solid #dee2e6',
              borderRadius: '4px',
              background: 'white',
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            {repositories.map(repo => (
              <option key={repo.id} value={repo.id}>
                {repo.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{
        display: 'flex',
        marginTop: '50px',
        width: '100%',
        height: 'calc(100vh - 50px)'
      }}>
        {/* Left Panel - Object Type Selector */}
        <div style={{
          width: '200px',
          borderRight: '1px solid #dee2e6',
          background: '#f8f9fa',
          padding: '20px',
          overflowY: 'auto'
        }}>
          <h3 style={{ 
            margin: '0 0 16px 0', 
            fontSize: '14px', 
            fontWeight: '600',
            color: '#666',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}>
            Object Type
          </h3>
          
          {(['parameters', 'contexts', 'cases', 'graphs'] as ObjectType[]).map(type => (
            <button
              key={type}
              onClick={() => {
                setSelectedObjectType(type);
                setSelectedItemId(null);
                setSelectedItemData(null);
                setIsCreatingNew(false);
              }}
              style={{
                width: '100%',
                padding: '12px 16px',
                marginBottom: '8px',
                background: selectedObjectType === type ? '#007bff' : 'white',
                color: selectedObjectType === type ? 'white' : '#333',
                border: '1px solid #dee2e6',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500',
                textAlign: 'left',
                transition: 'all 0.2s',
                textTransform: 'capitalize'
              }}
              onMouseEnter={(e) => {
                if (selectedObjectType !== type) {
                  e.currentTarget.style.background = '#e9ecef';
                }
              }}
              onMouseLeave={(e) => {
                if (selectedObjectType !== type) {
                  e.currentTarget.style.background = 'white';
                }
              }}
            >
              {type}
            </button>
          ))}
        </div>

        {/* Middle Panel - Item List */}
        <div style={{
          width: '300px',
          borderRight: '1px solid #dee2e6',
          display: 'flex',
          flexDirection: 'column',
          background: 'white'
        }}>
          {/* Header with Create Button */}
          <div style={{
            padding: '16px',
            borderBottom: '1px solid #dee2e6',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <h3 style={{ 
              margin: 0, 
              fontSize: '14px', 
              fontWeight: '600',
              color: '#333'
            }}>
              {selectedObjectType.charAt(0).toUpperCase() + selectedObjectType.slice(1)}
            </h3>
            <button
              onClick={handleCreateNew}
              style={{
                background: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                padding: '6px 12px',
                fontSize: '12px',
                cursor: 'pointer',
                fontWeight: '500'
              }}
            >
              + Create New
            </button>
          </div>

          {/* List */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px'
          }}>
            {isLoading && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                Loading...
              </div>
            )}
            
            {!isLoading && items.length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#666', fontSize: '13px' }}>
                No {selectedObjectType} found
              </div>
            )}
            
            {!isLoading && items.map(item => (
              <div
                key={item.id}
                onClick={() => {
                  setSelectedItemId(item.id);
                  setIsCreatingNew(false);
                }}
                style={{
                  padding: '12px',
                  marginBottom: '4px',
                  background: selectedItemId === item.id && !isCreatingNew ? '#e3f2fd' : 'white',
                  border: '1px solid #dee2e6',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  if (selectedItemId !== item.id || isCreatingNew) {
                    e.currentTarget.style.background = '#f8f9fa';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedItemId !== item.id || isCreatingNew) {
                    e.currentTarget.style.background = 'white';
                  }
                }}
              >
                <div style={{ 
                  fontSize: '13px', 
                  fontWeight: '500',
                  color: '#333',
                  marginBottom: '4px'
                }}>
                  {item.name}
                </div>
                <div style={{ 
                  fontSize: '11px', 
                  color: '#666',
                  display: 'flex',
                  gap: '8px'
                }}>
                  {item.type && <span>Type: {item.type}</span>}
                  {item.status && <span>Status: {item.status}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Panel - Form Editor */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px',
          background: 'white'
        }}>
          {error && (
            <div style={{
              padding: '12px',
              marginBottom: '16px',
              background: '#f8d7da',
              border: '1px solid #f5c6cb',
              borderRadius: '4px',
              color: '#721c24',
              fontSize: '13px'
            }}>
              {error}
            </div>
          )}

          {!selectedItemData && !isCreatingNew && (
            <div style={{
              padding: '40px',
              textAlign: 'center',
              color: '#666',
              fontSize: '14px'
            }}>
              Select an item from the list or create a new one
            </div>
          )}

          {selectedItemData && schema && (
            <div>
              <div style={{
                marginBottom: '20px',
                paddingBottom: '16px',
                borderBottom: '1px solid #dee2e6',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start'
              }}>
                <div style={{ flex: 1 }}>
                  <h2 style={{ 
                    margin: '0 0 8px 0', 
                    fontSize: '20px', 
                    fontWeight: '600',
                    color: '#333'
                  }}>
                    {isCreatingNew ? 'Create New' : 'Edit'} {
                      selectedObjectType === 'parameters' ? 'Parameter' : 
                      selectedObjectType === 'contexts' ? 'Context' : 
                      selectedObjectType === 'cases' ? 'Case' : 
                      'Graph'
                    }
                  </h2>
                  {!isCreatingNew && selectedItemData.id && (
                    <div style={{ fontSize: '13px', color: '#666' }}>
                      ID: <code style={{ 
                        background: '#f8f9fa', 
                        padding: '2px 6px', 
                        borderRadius: '3px',
                        fontFamily: 'monospace'
                      }}>{selectedItemData.id || selectedItemId}</code>
                    </div>
                  )}
                </div>
                
                {/* Contextual Actions */}
                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  {selectedObjectType === 'graphs' && !isCreatingNew && (
                    <button
                      onClick={handleOpenInGraphEditor}
                      style={{
                        background: '#17a2b8',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '8px 16px',
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#138496'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#17a2b8'}
                    >
                      🎨 Open in Graph Editor
                    </button>
                  )}
                  {!isCreatingNew && (
                    <button
                      onClick={() => {
                        const blob = new Blob([JSON.stringify(selectedItemData, null, 2)], { 
                          type: selectedObjectType === 'graphs' ? 'application/json' : 'application/x-yaml' 
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${selectedItemData.id || selectedItemId}.${selectedObjectType === 'graphs' ? 'json' : 'yaml'}`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                      style={{
                        background: '#6c757d',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '8px 16px',
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#5a6268'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#6c757d'}
                    >
                      📥 Download
                    </button>
                  )}
                </div>
              </div>

              <div style={{
                // Custom RJSF styling
                '--rjsf-label-color': '#333',
                '--rjsf-input-border': '#dee2e6',
                '--rjsf-input-focus': '#007bff',
              } as React.CSSProperties}>
                <style>{`
                  .rjsf fieldset {
                    border: none;
                    padding: 0;
                    margin: 0 0 20px 0;
                  }
                  
                  .rjsf legend {
                    font-size: 16px;
                    font-weight: 600;
                    color: #333;
                    margin-bottom: 12px;
                    padding: 0;
                    border-bottom: 2px solid #007bff;
                    padding-bottom: 8px;
                  }
                  
                  .rjsf .form-group {
                    margin-bottom: 20px;
                  }
                  
                  .rjsf label {
                    display: block;
                    font-size: 13px;
                    font-weight: 600;
                    color: #495057;
                    margin-bottom: 6px;
                  }
                  
                  .rjsf input[type="text"],
                  .rjsf input[type="number"],
                  .rjsf input[type="email"],
                  .rjsf textarea,
                  .rjsf select {
                    width: 100%;
                    padding: 8px 12px;
                    border: 1px solid #dee2e6;
                    border-radius: 4px;
                    font-size: 14px;
                    font-family: inherit;
                    transition: border-color 0.2s, box-shadow 0.2s;
                    box-sizing: border-box;
                  }
                  
                  .rjsf input[type="text"]:focus,
                  .rjsf input[type="number"]:focus,
                  .rjsf input[type="email"]:focus,
                  .rjsf textarea:focus,
                  .rjsf select:focus {
                    outline: none;
                    border-color: #007bff;
                    box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
                  }
                  
                  .rjsf textarea {
                    min-height: 100px;
                    resize: vertical;
                  }
                  
                  .rjsf .field-description {
                    font-size: 12px;
                    color: #6c757d;
                    margin-top: 4px;
                    font-style: italic;
                  }
                  
                  .rjsf .help-block {
                    font-size: 12px;
                    color: #6c757d;
                    margin-top: 4px;
                  }
                  
                  .rjsf .text-danger {
                    color: #dc3545;
                    font-size: 12px;
                    margin-top: 4px;
                  }
                  
                  .rjsf .array-item {
                    background: #f8f9fa;
                    border: 1px solid #dee2e6;
                    border-radius: 6px;
                    padding: 16px;
                    margin-bottom: 12px;
                  }
                  
                  .rjsf .array-item-toolbox {
                    display: flex;
                    gap: 8px;
                    margin-top: 12px;
                  }
                  
                  .rjsf button[type="button"] {
                    background: #6c757d;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    padding: 6px 12px;
                    font-size: 12px;
                    cursor: pointer;
                    transition: background 0.2s;
                  }
                  
                  .rjsf button[type="button"]:hover {
                    background: #5a6268;
                  }
                  
                  .rjsf .btn-add {
                    background: #28a745;
                    color: white;
                    margin-top: 8px;
                  }
                  
                  .rjsf .btn-add:hover {
                    background: #218838;
                  }
                  
                  .rjsf .array-item-move-up,
                  .rjsf .array-item-move-down {
                    background: #17a2b8;
                  }
                  
                  .rjsf .array-item-move-up:hover,
                  .rjsf .array-item-move-down:hover {
                    background: #138496;
                  }
                  
                  .rjsf .array-item-remove {
                    background: #dc3545;
                  }
                  
                  .rjsf .array-item-remove:hover {
                    background: #c82333;
                  }
                  
                  .rjsf .checkbox label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                  }
                  
                  .rjsf input[type="checkbox"] {
                    width: auto;
                    margin: 0;
                    cursor: pointer;
                  }
                `}</style>
                
                <Form
                  schema={schema}
                  formData={selectedItemData}
                  validator={validator}
                  onChange={(e) => setSelectedItemData(e.formData)}
                  onSubmit={(e) => handleSave(e.formData)}
                  uiSchema={{
                    'ui:submitButtonOptions': {
                      submitText: '💾 Save (Download YAML)',
                      props: {
                        className: 'submit-button',
                        style: {
                          background: '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '12px 24px',
                          fontSize: '14px',
                          fontWeight: '600',
                          cursor: 'pointer',
                          marginTop: '24px',
                          transition: 'all 0.2s',
                          boxShadow: '0 2px 4px rgba(0,123,255,0.2)'
                        }
                      }
                    }
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

