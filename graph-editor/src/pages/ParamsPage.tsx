import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RJSFSchema } from '@rjsf/utils';
import Form from '@rjsf/core';
import validator from '@rjsf/validator-ajv8';
import yaml from 'js-yaml';
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
  label?: string;
  description?: string;
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
      id: 'nous-conversion',
      label: 'nous-conversion (Git)',
      source: 'git',
      gitBasePath: '',  // At root
      gitBranch: 'main',
      gitRepoOwner: 'gjbm2',
      gitRepoName: 'nous-conversion'
    }
  ];
  
  // State for three panels
  const [selectedRepo, setSelectedRepo] = useState<string>('nous-conversion');
  const [selectedObjectType, setSelectedObjectType] = useState<ObjectType>('parameters');
  const [items, setItems] = useState<ListItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemData, setSelectedItemData] = useState<any>(null);
  const [schema, setSchema] = useState<RJSFSchema | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [filterText, setFilterText] = useState<string>('');
  const [formIsDirty, setFormIsDirty] = useState(false);
  const [originalFormData, setOriginalFormData] = useState<any>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveBranch, setSaveBranch] = useState<string>('main');
  const [saveCommitMessage, setSaveCommitMessage] = useState<string>('');
  const [isInitialFormLoad, setIsInitialFormLoad] = useState(true);

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
      let data;
      if (selectedObjectType === 'parameters') {
        data = await paramRegistryService.loadParameter(selectedItemId);
      } else if (selectedObjectType === 'contexts') {
        data = await paramRegistryService.loadContext(selectedItemId);
      } else if (selectedObjectType === 'cases') {
        data = await paramRegistryService.loadCase(selectedItemId);
      } else if (selectedObjectType === 'graphs') {
        data = await paramRegistryService.loadGraph(selectedItemId);
      }
      setSelectedItemData(data);
      setOriginalFormData(JSON.parse(JSON.stringify(data))); // Deep clone
      setFormIsDirty(false);
      setIsInitialFormLoad(true); // Reset for new data load
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
        // Load graph schema from GitHub
        const response = await fetch('https://raw.githubusercontent.com/gjbm2/dagnet/main/schema/conversion-graph-1.0.0.json');
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
    // Warn if unsaved changes
    if (formIsDirty) {
      if (!window.confirm('You have unsaved changes. Discard them and continue?')) {
        return;
      }
    }
    
    setIsCreatingNew(true);
    setSelectedItemId(null);
    
    // Create empty template based on type
    let newData;
    if (selectedObjectType === 'parameters') {
      newData = {
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
      };
    } else if (selectedObjectType === 'contexts') {
      newData = {
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
      };
    } else if (selectedObjectType === 'cases') {
      newData = {
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
      };
    } else if (selectedObjectType === 'graphs') {
      newData = {
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
      };
    }
    setSelectedItemData(newData);
    setOriginalFormData(JSON.parse(JSON.stringify(newData))); // Deep clone
    setFormIsDirty(false);
    setIsInitialFormLoad(true); // Reset for new item creation
  };

  const handleDiscard = () => {
    if (window.confirm('Discard all unsaved changes?')) {
      setSelectedItemData(JSON.parse(JSON.stringify(originalFormData)));
      setFormIsDirty(false);
      setIsInitialFormLoad(true); // Treat discard as a fresh load
    }
  };

  const handleSaveClick = () => {
    // Set default commit message
    const itemId = selectedItemData?.id || selectedItemData?.parameter_id || 'new-item';
    const action = isCreatingNew ? 'Add' : 'Update';
    const itemType = selectedObjectType === 'parameters' ? 'parameter' : 
                     selectedObjectType === 'contexts' ? 'context' : 
                     selectedObjectType === 'cases' ? 'case' : 'graph';
    setSaveCommitMessage(`${action} ${itemType}: ${itemId}`);
    setShowSaveDialog(true);
  };

  const handleSaveToGit = async () => {
    if (!selectedItemData) return;
    
    if (!saveCommitMessage.trim()) {
      alert('Please enter a commit message');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Determine file path and content based on object type
      let filePath: string;
      let content: string;
      let itemId: string;
      
      // Get the current repo config to determine the correct path structure
      const repo = repositories.find(r => r.id === selectedRepo);
      
      if (selectedObjectType === 'parameters') {
        itemId = selectedItemData.id;
        if (repo?.gitBasePath) {
          filePath = `${repo.gitBasePath}/parameters/${itemId}.yaml`;
        } else {
          filePath = `parameters/${itemId}.yaml`; // nous-conversion uses flat structure
        }
        content = yaml.dump(selectedItemData);
      } else if (selectedObjectType === 'contexts') {
        itemId = selectedItemData.id;
        if (repo?.gitBasePath) {
          filePath = `${repo.gitBasePath}/contexts/${itemId}.yaml`;
        } else {
          filePath = `contexts/${itemId}.yaml`;
        }
        content = yaml.dump(selectedItemData);
      } else if (selectedObjectType === 'cases') {
        itemId = selectedItemData.parameter_id;
        if (repo?.gitBasePath) {
          filePath = `${repo.gitBasePath}/cases/${itemId}.yaml`;
        } else {
          filePath = `cases/${itemId}.yaml`;
        }
        content = yaml.dump(selectedItemData);
      } else if (selectedObjectType === 'graphs') {
        itemId = selectedItemData.metadata?.name || selectedItemId || 'graph';
        const fileName = itemId.endsWith('.json') ? itemId : `${itemId}.json`;
        if (repo?.gitBasePath) {
          filePath = `${repo.gitBasePath}/graphs/${fileName}`;
        } else {
          filePath = `graphs/${fileName}`;
        }
        content = JSON.stringify(selectedItemData, null, 2);
      } else {
        throw new Error('Unknown object type');
      }
      
      // Determine which repo to use
      const repoOwner = repo?.gitRepoOwner || 'gjbm2';
      const repoName = repo?.gitRepoName || 'nous-conversion';
      const githubToken = import.meta.env.VITE_GITHUB_TOKEN;
      
      // Check if file exists to get SHA for update
      const getFileUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}?ref=${saveBranch}`;
      const headers: HeadersInit = {
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      };
      if (githubToken) {
        headers['Authorization'] = `token ${githubToken}`;
      }
      
      let sha: string | undefined;
      try {
        const getResponse = await fetch(getFileUrl, { headers });
        if (getResponse.ok) {
          const fileData = await getResponse.json();
          sha = fileData.sha;
        }
      } catch (err) {
        // File doesn't exist, that's ok for new files
        console.log('File does not exist yet, will create new');
      }
      
      // Save to Git using GitHub API
      const putUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;
      const body: any = {
        message: saveCommitMessage,
        content: btoa(unescape(encodeURIComponent(content))), // Base64 encode with UTF-8 support
        branch: saveBranch,
      };
      if (sha) {
        body.sha = sha;
      }
      
      const putResponse = await fetch(putUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body)
      });
      
      if (!putResponse.ok) {
        const errorData = await putResponse.json();
        throw new Error(`GitHub API Error: ${putResponse.status} - ${JSON.stringify(errorData)}`);
      }
      
      // Success!
      alert(`✅ Successfully saved to ${saveBranch}!`);
      setShowSaveDialog(false);
      setFormIsDirty(false);
      setOriginalFormData(JSON.parse(JSON.stringify(selectedItemData)));
      setIsInitialFormLoad(true); // Treat post-save as fresh load
      setIsCreatingNew(false);
      loadItems();
    } catch (err) {
      setError(`Failed to save: ${err}`);
      console.error(err);
      alert(`Failed to save: ${err}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenInGraphEditor = () => {
    if (selectedObjectType === 'graphs' && selectedItemData) {
      // Open graph editor in new window
      const graphName = selectedItemData.metadata?.name || selectedItemId;
      window.open(`/?graph=${graphName}`, '_blank');
    }
  };

  const handleDelete = () => {
    if (!selectedItemId) return;
    
    const itemType = selectedObjectType === 'parameters' ? 'parameter' : 
                     selectedObjectType === 'contexts' ? 'context' : 
                     selectedObjectType === 'cases' ? 'case' : 'graph';
    
    if (window.confirm(`Are you sure you want to delete this ${itemType}?\n\nID: ${selectedItemId}\n\nThis will download a deletion marker. You'll need to manually remove the file from your repository.`)) {
      // Create a deletion marker file
      const deletionMarker = {
        _deleted: true,
        id: selectedItemId,
        deletedAt: new Date().toISOString(),
        note: 'This is a deletion marker. Remove the original file from your repository.'
      };
      
      const blob = new Blob([JSON.stringify(deletionMarker, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DELETE_${selectedItemId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      
      // Clear selection
      setSelectedItemId(null);
      setSelectedItemData(null);
      
      alert('Deletion marker downloaded. Please manually remove the file from your repository and commit the changes.');
    }
  };

  // Filter items based on search text
  const filteredItems = items.filter(item => {
    if (!filterText) return true;
    
    const searchText = filterText.toLowerCase();
    const idMatch = item.id?.toLowerCase().includes(searchText) ?? false;
    const labelMatch = item.label?.toLowerCase().includes(searchText) ?? false;
    const descMatch = item.description?.toLowerCase().includes(searchText) ?? false;
    
    return idMatch || labelMatch || descMatch;
  });

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
              // Warn if unsaved changes
              if (formIsDirty) {
                if (!window.confirm('You have unsaved changes. Discard them and continue?')) {
                  return;
                }
              }
              setSelectedRepo(e.target.value);
              setSelectedItemId(null);
              setSelectedItemData(null);
              setIsCreatingNew(false);
              setFilterText('');
              setFormIsDirty(false);
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
                // Warn if unsaved changes
                if (formIsDirty) {
                  if (!window.confirm('You have unsaved changes. Discard them and continue?')) {
                    return;
                  }
                }
                setSelectedObjectType(type);
                setSelectedItemId(null);
                setSelectedItemData(null);
                setIsCreatingNew(false);
                setFilterText('');
                setFormIsDirty(false);
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

          {/* Filter Input */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid #dee2e6',
            background: '#f8f9fa'
          }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <span style={{
                position: 'absolute',
                left: '10px',
                fontSize: '14px',
                color: '#6c757d',
                pointerEvents: 'none'
              }}>
                🔍
              </span>
              <input
                type="text"
                placeholder={`Filter ${selectedObjectType}...`}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px 8px 32px',
                  border: '1px solid #dee2e6',
                  borderRadius: '4px',
                  fontSize: '13px',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
                onFocus={(e) => e.target.style.borderColor = '#007bff'}
                onBlur={(e) => e.target.style.borderColor = '#dee2e6'}
              />
              {filterText && (
                <button
                  onClick={() => setFilterText('')}
                  style={{
                    position: 'absolute',
                    right: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#6c757d',
                    cursor: 'pointer',
                    fontSize: '16px',
                    padding: '2px 6px',
                    borderRadius: '3px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#dee2e6'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  title="Clear filter"
                >
                  ✕
                </button>
              )}
            </div>
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
            
            {!isLoading && items.length > 0 && filteredItems.length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#666', fontSize: '13px' }}>
                No matches for "{filterText}"
              </div>
            )}
            
            {!isLoading && filteredItems.map(item => (
              <div
                key={item.id}
                onClick={() => {
                  // Warn if unsaved changes
                  if (formIsDirty) {
                    if (!window.confirm('You have unsaved changes. Discard them and continue?')) {
                      return;
                    }
                  }
                  setSelectedItemId(item.id);
                  setIsCreatingNew(false);
                  setFormIsDirty(false);
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
          display: 'flex',
          flexDirection: 'column',
          background: 'white',
          overflow: 'hidden'
        }}>
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
            <>
              {/* Sticky Header */}
              <div style={{
                padding: '24px 24px 16px 24px',
                borderBottom: '2px solid #dee2e6',
                background: 'white',
                flexShrink: 0,
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
                  <button
                    onClick={handleSaveClick}
                    disabled={!formIsDirty}
                    style={{
                      background: formIsDirty ? '#28a745' : '#6c757d',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: '600',
                      cursor: formIsDirty ? 'pointer' : 'not-allowed',
                      transition: 'background 0.2s',
                      opacity: formIsDirty ? 1 : 0.6,
                      boxShadow: formIsDirty ? '0 2px 4px rgba(40, 167, 69, 0.3)' : 'none'
                    }}
                    onMouseEnter={(e) => {
                      if (formIsDirty) e.currentTarget.style.background = '#218838';
                    }}
                    onMouseLeave={(e) => {
                      if (formIsDirty) e.currentTarget.style.background = '#28a745';
                    }}
                  >
                    💾 Save to Git
                  </button>
                  <button
                    onClick={handleDiscard}
                    disabled={!formIsDirty}
                    style={{
                      background: 'white',
                      color: '#6c757d',
                      border: '1px solid #dee2e6',
                      borderRadius: '4px',
                      padding: '8px 16px',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: formIsDirty ? 'pointer' : 'not-allowed',
                      transition: 'all 0.2s',
                      opacity: formIsDirty ? 1 : 0.6
                    }}
                    onMouseEnter={(e) => {
                      if (formIsDirty) {
                        e.currentTarget.style.background = '#dc3545';
                        e.currentTarget.style.color = 'white';
                        e.currentTarget.style.borderColor = '#dc3545';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (formIsDirty) {
                        e.currentTarget.style.background = 'white';
                        e.currentTarget.style.color = '#6c757d';
                        e.currentTarget.style.borderColor = '#dee2e6';
                      }
                    }}
                  >
                    ↺ Discard
                  </button>
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
                  {!isCreatingNew && (
                    <button
                      onClick={handleDelete}
                      style={{
                        background: '#dc3545',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '8px 16px',
                        fontSize: '13px',
                        fontWeight: '500',
                        cursor: 'pointer',
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#c82333'}
                      onMouseLeave={(e) => e.currentTarget.style.background = '#dc3545'}
                    >
                      🗑️ Delete
                    </button>
                  )}
                </div>
              </div>

              {/* Scrollable Content Area */}
              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: '24px'
              }}>
                {/* Info Banner */}
                <div style={{
                  background: '#e7f3ff',
                  border: '1px solid #b3d9ff',
                  borderRadius: '6px',
                  padding: '12px 16px',
                  marginBottom: '20px',
                  fontSize: '13px',
                  color: '#004085',
                  lineHeight: '1.6'
                }}>
                  <strong>ℹ️ Note:</strong> Changes are saved directly to your Git repository. 
                  Make your edits, then click "Save to Git" to commit them with a message. 
                  You can also use "Download" to get a local copy, or "Delete" for removal instructions.
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
                    display: flex !important;
                    gap: 8px !important;
                    margin-top: 12px !important;
                    flex-wrap: wrap !important;
                  }
                  
                  /* Base button styling - apply to all buttons */
                  .rjsf button,
                  .rjsf button[type="button"] {
                    background: #6c757d !important;
                    color: white !important;
                    border: none !important;
                    border-radius: 4px !important;
                    padding: 10px 20px !important;
                    font-size: 14px !important;
                    cursor: pointer !important;
                    transition: background 0.2s !important;
                    min-height: 40px !important;
                    font-weight: 600 !important;
                    white-space: nowrap !important;
                  }
                  
                  .rjsf button:hover,
                  .rjsf button[type="button"]:hover {
                    background: #5a6268 !important;
                  }
                  
                  /* Add button */
                  .rjsf .btn-add,
                  .rjsf button.btn-add {
                    background: #28a745 !important;
                    color: white !important;
                    margin-top: 8px !important;
                    padding: 10px 20px !important;
                    font-size: 14px !important;
                    min-width: 120px !important;
                  }
                  
                  .rjsf .btn-add:hover,
                  .rjsf button.btn-add:hover {
                    background: #218838 !important;
                  }
                  
                  /* Add text label to add button */
                  .rjsf .btn-add::after,
                  .rjsf button.btn-add::after {
                    content: ' + Add' !important;
                    font-size: 14px !important;
                    font-weight: 600 !important;
                  }
                  
                  /* Move up/down buttons */
                  .rjsf .array-item-move-up,
                  .rjsf .array-item-move-down,
                  .rjsf button.array-item-move-up,
                  .rjsf button.array-item-move-down {
                    background: #17a2b8 !important;
                    min-width: 120px !important;
                    padding: 10px 20px !important;
                  }
                  
                  .rjsf .array-item-move-up:hover,
                  .rjsf .array-item-move-down:hover,
                  .rjsf button.array-item-move-up:hover,
                  .rjsf button.array-item-move-down:hover {
                    background: #138496 !important;
                  }
                  
                  /* Add text labels to move up button */
                  .rjsf .array-item-move-up::after,
                  .rjsf button.array-item-move-up::after {
                    content: ' ▲ Move Up' !important;
                    font-size: 14px !important;
                    font-weight: 600 !important;
                  }
                  
                  /* Add text labels to move down button */
                  .rjsf .array-item-move-down::after,
                  .rjsf button.array-item-move-down::after {
                    content: ' ▼ Move Down' !important;
                    font-size: 14px !important;
                    font-weight: 600 !important;
                  }
                  
                  /* Remove button */
                  .rjsf .array-item-remove,
                  .rjsf button.array-item-remove {
                    background: #dc3545 !important;
                    min-width: 120px !important;
                    padding: 10px 20px !important;
                  }
                  
                  .rjsf .array-item-remove:hover,
                  .rjsf button.array-item-remove:hover {
                    background: #c82333 !important;
                  }
                  
                  /* Add text label to remove button */
                  .rjsf .array-item-remove::after,
                  .rjsf button.array-item-remove::after {
                    content: ' ✕ Remove' !important;
                    font-size: 14px !important;
                    font-weight: 600 !important;
                  }
                  
                  /* Fix icon sizing if present */
                  .rjsf button i,
                  .rjsf button span {
                    font-size: 16px !important;
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
                  key={`${selectedRepo}-${selectedObjectType}-${selectedItemId || 'new'}`}
                  schema={schema}
                  formData={selectedItemData}
                  validator={validator}
                  onChange={(e) => {
                    setSelectedItemData(e.formData);
                    
                    // On initial form load, RJSF normalizes the data (adds undefined fields, etc.)
                    // Capture this normalized version as the original to avoid false dirty flags
                    if (isInitialFormLoad) {
                      setOriginalFormData(JSON.parse(JSON.stringify(e.formData)));
                      setIsInitialFormLoad(false);
                      setFormIsDirty(false);
                    } else {
                      // Check if form is dirty by comparing with original
                      setFormIsDirty(JSON.stringify(e.formData) !== JSON.stringify(originalFormData));
                    }
                  }}
                  onSubmit={() => {/* Form submission handled by custom buttons */}}
                  uiSchema={{
                    'ui:submitButtonOptions': {
                      norender: true  // Hide the default submit button
                    }
                  }}
                />
              </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Save Dialog */}
      {showSaveDialog && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2000
        }}>
          <div style={{
            background: 'white',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '500px',
            width: '90%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)'
          }}>
            <h2 style={{ margin: '0 0 20px 0', fontSize: '20px', fontWeight: '600' }}>
              Save to Git Repository
            </h2>
            
            <div style={{ marginBottom: '16px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '6px', 
                fontSize: '13px', 
                fontWeight: '600',
                color: '#495057'
              }}>
                Branch:
              </label>
              <select
                value={saveBranch}
                onChange={(e) => setSaveBranch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontFamily: 'inherit'
                }}
              >
                <option value="main">main</option>
                <option value="develop">develop</option>
              </select>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ 
                display: 'block', 
                marginBottom: '6px', 
                fontSize: '13px', 
                fontWeight: '600',
                color: '#495057'
              }}>
                Commit Message:
              </label>
              <textarea
                value={saveCommitMessage}
                onChange={(e) => setSaveCommitMessage(e.target.value)}
                placeholder="Describe your changes..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #dee2e6',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  boxSizing: 'border-box'
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowSaveDialog(false)}
                style={{
                  padding: '8px 16px',
                  border: '1px solid #dee2e6',
                  borderRadius: '4px',
                  background: 'white',
                  color: '#666',
                  fontSize: '14px',
                  fontWeight: '500',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveToGit}
                disabled={isLoading || !saveCommitMessage.trim()}
                style={{
                  padding: '8px 16px',
                  border: 'none',
                  borderRadius: '4px',
                  background: (!isLoading && saveCommitMessage.trim()) ? '#28a745' : '#6c757d',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: (!isLoading && saveCommitMessage.trim()) ? 'pointer' : 'not-allowed',
                  opacity: (!isLoading && saveCommitMessage.trim()) ? 1 : 0.6
                }}
              >
                {isLoading ? 'Saving...' : '💾 Save to Git'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

