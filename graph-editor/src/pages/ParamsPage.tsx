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

type ObjectType = 'parameters' | 'contexts' | 'graphs';

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
      id: 'local',
      label: 'Local (this repo)',
      source: 'local'
    },
    {
      id: 'dagnet-git',
      label: 'dagnet (Git) - Test Data',
      source: 'git',
      gitBasePath: 'param-registry/test/params',
      gitBranch: 'main',
      gitRepoOwner: 'gjbm2',
      gitRepoName: 'dagnet'
    },
    {
      id: '<private-repo>',
      label: '<private-repo> (Git)',
      source: 'git',
      gitBasePath: 'params',
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
        const contextsFile = await paramRegistryService.loadContexts();
        const contextItems: ListItem[] = contextsFile.contexts.map(c => ({
          id: c.id,
          name: c.name,
          type: c.type
        }));
        setItems(contextItems);
      } else if (selectedObjectType === 'graphs') {
        // TODO: Load graphs from repository
        setItems([]);
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
        const contextsFile = await paramRegistryService.loadContexts();
        const context = contextsFile.contexts.find(c => c.id === selectedItemId);
        setSelectedItemData(context);
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
        schemaData = await paramRegistryService.loadSchema('context-schema.yaml');
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
          version: '1.0.0'
        }
      });
    } else if (selectedObjectType === 'contexts') {
      setSelectedItemData({
        id: '',
        name: '',
        description: '',
        type: 'categorical',
        values: []
      });
    }
  };

  const handleSave = async (formData: any) => {
    try {
      if (selectedObjectType === 'parameters') {
        await paramRegistryService.saveParameter(formData);
        alert('Parameter saved! (Downloaded as YAML file)');
      } else if (selectedObjectType === 'contexts') {
        // For contexts, we need to update the whole contexts file
        const contextsFile = await paramRegistryService.loadContexts();
        const contextIndex = contextsFile.contexts.findIndex(c => c.id === formData.id);
        
        if (contextIndex >= 0) {
          contextsFile.contexts[contextIndex] = formData;
        } else {
          contextsFile.contexts.push(formData);
        }
        
        contextsFile.metadata.updated_at = new Date().toISOString();
        await paramRegistryService.saveContexts(contextsFile);
        alert('Context saved! (Downloaded as contexts.yaml)');
      }
      
      setIsCreatingNew(false);
      loadItems();
    } catch (err) {
      setError(`Failed to save: ${err}`);
      console.error(err);
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
          
          {(['parameters', 'contexts', 'graphs'] as ObjectType[]).map(type => (
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
                borderBottom: '1px solid #dee2e6'
              }}>
                <h2 style={{ 
                  margin: '0 0 8px 0', 
                  fontSize: '20px', 
                  fontWeight: '600',
                  color: '#333'
                }}>
                  {isCreatingNew ? 'Create New' : 'Edit'} {selectedObjectType === 'parameters' ? 'Parameter' : 'Context'}
                </h2>
                {!isCreatingNew && selectedItemData.id && (
                  <div style={{ fontSize: '13px', color: '#666' }}>
                    ID: <code style={{ 
                      background: '#f8f9fa', 
                      padding: '2px 6px', 
                      borderRadius: '3px',
                      fontFamily: 'monospace'
                    }}>{selectedItemData.id}</code>
                  </div>
                )}
              </div>

              <Form
                schema={schema}
                formData={selectedItemData}
                validator={validator}
                onChange={(e) => setSelectedItemData(e.formData)}
                onSubmit={(e) => handleSave(e.formData)}
                uiSchema={{
                  'ui:submitButtonOptions': {
                    submitText: 'Save (Download YAML)',
                    props: {
                      style: {
                        background: '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '10px 20px',
                        fontSize: '14px',
                        fontWeight: '500',
                        cursor: 'pointer',
                        marginTop: '20px'
                      }
                    }
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

