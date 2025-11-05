import React, { useRef, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { Circle, X, Check, GitBranch } from 'lucide-react';

interface QueryExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  graph: any;
  edgeId?: string;
  placeholder?: string;
  height?: string;
  readonly?: boolean;
}

interface ParsedQueryChip {
  type: 'from' | 'to' | 'exclude' | 'visited' | 'case';
  values: string[];
  rawText: string;
}

/**
 * Monaco-based Query Expression Editor
 * 
 * Provides IDE-like autocomplete for constructing data retrieval queries:
 * - from(node-id).to(node-id)
 * - .exclude(node-id, node-id, ...)
 * - .visited(node-id, node-id, ...)
 * - .case(case-id:variant-name)
 */
// Chip styling configuration
const chipConfig = {
  from: { 
    color: '#3B82F6', 
    bgColor: '#EFF6FF', 
    label: 'from', 
    icon: Circle,
    textColor: '#1E40AF'
  },
  to: { 
    color: '#3B82F6', 
    bgColor: '#EFF6FF', 
    label: 'to', 
    icon: Circle,
    textColor: '#1E40AF'
  },
  exclude: { 
    color: '#EF4444', 
    bgColor: '#FEF2F2', 
    label: 'exclude', 
    icon: X,
    textColor: '#991B1B'
  },
  visited: { 
    color: '#10B981', 
    bgColor: '#F0FDF4', 
    label: 'visited', 
    icon: Check,
    textColor: '#065F46'
  },
  case: { 
    color: '#F59E0B', 
    bgColor: '#FFFBEB', 
    label: 'case', 
    icon: GitBranch,
    textColor: '#92400E'
  }
};

// Parse query string into chips
function parseQueryToChips(query: string): ParsedQueryChip[] {
  if (!query) return [];
  
  const chips: ParsedQueryChip[] = [];
  
  // Match from(...)
  const fromMatch = query.match(/from\(([^)]+)\)/);
  if (fromMatch) {
    chips.push({
      type: 'from',
      values: [fromMatch[1]],
      rawText: fromMatch[0]
    });
  }
  
  // Match to(...)
  const toMatch = query.match(/to\(([^)]+)\)/);
  if (toMatch) {
    chips.push({
      type: 'to',
      values: [toMatch[1]],
      rawText: toMatch[0]
    });
  }
  
  // Match exclude(...)
  const excludeMatch = query.match(/exclude\(([^)]+)\)/);
  if (excludeMatch) {
    chips.push({
      type: 'exclude',
      values: excludeMatch[1].split(',').map(s => s.trim()),
      rawText: excludeMatch[0]
    });
  }
  
  // Match visited(...)
  const visitedMatch = query.match(/visited\(([^)]+)\)/);
  if (visitedMatch) {
    chips.push({
      type: 'visited',
      values: visitedMatch[1].split(',').map(s => s.trim()),
      rawText: visitedMatch[0]
    });
  }
  
  // Match case(...)
  const caseMatch = query.match(/case\(([^)]+)\)/);
  if (caseMatch) {
    chips.push({
      type: 'case',
      values: [caseMatch[1]],
      rawText: caseMatch[0]
    });
  }
  
  return chips;
}

export function QueryExpressionEditor({
  value,
  onChange,
  onBlur,
  graph,
  edgeId,
  placeholder = 'from(node).to(node)',
  height = '60px',
  readonly = false
}: QueryExpressionEditorProps) {
  const monacoRef = useRef<typeof Monaco | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [nodeRegistry, setNodeRegistry] = useState<any[]>([]);
  const [caseRegistry, setCaseRegistry] = useState<any[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [chips, setChips] = useState<ParsedQueryChip[]>([]);
  const [hoveredChipIndex, setHoveredChipIndex] = useState<number | null>(null);
  
  // Parse value into chips when it changes
  useEffect(() => {
    setChips(parseQueryToChips(value));
  }, [value]);
  
  // Load registries
  useEffect(() => {
    const loadRegistries = async () => {
      try {
        const { registryService } = await import('../services/registryService');
        
        // Load node registry
        const nodes = await registryService.getItems('node');
        setNodeRegistry(nodes || []);
        
        // Load case registry
        const cases = await registryService.getItems('case');
        setCaseRegistry(cases || []);
      } catch (error) {
        console.warn('Failed to load registries:', error);
      }
    };
    
    loadRegistries();
  }, []);
  
  // Get current edge to pre-fill from/to
  const currentEdge = edgeId && graph?.edges
    ? graph.edges.find((e: any) => e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId)
    : null;
  
  // Merge nodes from graph and registry (using ids from graph, IDs from registry)
  const graphNodes = (graph?.nodes || []).map((n: any) => ({
    id: n.id || n.id,  // Prefer id over ID
    label: n.label || n.id || n.id,
    description: n.description,
    source: 'graph'
  }));
  
  const registryNodes = nodeRegistry.map((n: any) => ({
    id: n.id,
    label: n.name || n.id,
    description: n.description,
    source: 'registry'
  }));
  
  // Union: prefer graph nodes (by ID/id), add registry nodes not in graph
  const graphNodeIds = new Set(graphNodes.map((n: any) => n.id));
  const allNodes = [
    ...graphNodes,
    ...registryNodes.filter((n: any) => !graphNodeIds.has(n.id))
  ];
  
  // Merge cases from graph and registry
  const graphCases = (graph?.nodes || [])
    .filter((n: any) => n.type === 'case' && n.case)
    .map((n: any) => ({
      id: n.case.id || n.id,
      name: n.case.id || n.label,
      variants: (n.case.variants || []).map((v: any) => v.name),
      source: 'graph'
    }));
  
  const registryCases = caseRegistry.map((c: any) => ({
    id: c.id,
    name: c.name || c.id,
    variants: c.variants || [],
    source: 'registry'
  }));
  
  // Union: prefer graph cases, add registry cases not in graph
  const graphCaseIds = new Set(graphCases.map((c: any) => c.id));
  const allCases = [
    ...graphCases,
    ...registryCases.filter((c: any) => !graphCaseIds.has(c.id))
  ];
  
  const handleEditorDidMount = (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    
    // Register custom language for query expressions (only once)
    const languages = monaco.languages.getLanguages();
    if (!languages.find(l => l.id === 'dagnet-query')) {
      monaco.languages.register({ id: 'dagnet-query' });
      
      // Syntax highlighting (Monarch tokenizer)
      monaco.languages.setMonarchTokensProvider('dagnet-query', {
      keywords: ['from', 'to', 'exclude', 'visited', 'case'],
      
      tokenizer: {
        root: [
          [/\b(from|to|exclude|visited|case)\b/, 'keyword'],
          [/[a-z0-9_-]+/, 'identifier'],
          [/[().,:]/, 'delimiter'],
        ]
      }
    });
    
    // Theme colors (using app's color scheme)
    monaco.editor.defineTheme('dagnet-query-theme', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '3B82F6', fontStyle: 'bold' },  // Blue for from/to
        { token: 'identifier', foreground: '1F2937' },  // Dark gray for node IDs
        { token: 'delimiter', foreground: '6B7280' },  // Medium gray for punctuation
      ],
      colors: {
        'editor.background': '#FFFFFF',
        'editor.foreground': '#1F2937'
      }
    });
    
      monaco.editor.setTheme('dagnet-query-theme');
      
      // Autocomplete (CompletionItemProvider)
      monaco.languages.registerCompletionItemProvider('dagnet-query', {
      triggerCharacters: ['.', '(', ',', ':'],
      
      provideCompletionItems: (model, position) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });
        
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };
        
        // After from( → suggest node IDs (graph + registry)
        if (/from\([^)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allNodes.map((n: any) => ({
              label: n.label,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: n.id,
              documentation: n.description || `Node: ${n.label}`,
              detail: `${n.id} (${n.source})`,
              range
            }))
          };
        }
        
        // After to( → suggest node IDs (graph + registry)
        if (/to\([^)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allNodes.map((n: any) => ({
              label: n.label,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: n.id,
              documentation: n.description || `Node: ${n.label}`,
              detail: `${n.id} (${n.source})`,
              range
            }))
          };
        }
        
        // After .exclude( or .visited( → suggest node IDs (graph + registry)
        if (/\.(exclude|visited)\([^)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allNodes.map((n: any) => ({
              label: n.label,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: n.id,
              documentation: n.description || `Node: ${n.label}`,
              detail: `${n.id} (${n.source})`,
              range
            }))
          };
        }
        
        // After .case( → suggest case IDs (graph + registry)
        if (/\.case\([^:)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allCases.map((c: any) => ({
              label: c.name,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: c.id,
              documentation: `Case: ${c.name}`,
              detail: `${c.id} (${c.source})`,
              range
            }))
          };
        }
        
        // After .case(case-id: → suggest variant names
        if (/\.case\([a-z0-9_-]+:([^)]*)$/.test(textUntilPosition)) {
          const match = textUntilPosition.match(/\.case\(([a-z0-9_-]+):/);
          if (match) {
            const caseId = match[1];
            const matchedCase = allCases.find((c: any) => c.id === caseId);
            if (matchedCase && matchedCase.variants) {
              return {
                suggestions: matchedCase.variants.map((variantName: string) => ({
                  label: variantName,
                  kind: monaco.languages.CompletionItemKind.Value,
                  insertText: variantName,
                  documentation: `Variant: ${variantName}`,
                  range
                }))
              };
            }
          }
        }
        
        // After . (dot) → suggest constraint types OR from/to/case
        if (/\.$/.test(textUntilPosition) || /\)\.$/.test(textUntilPosition)) {
          const hasSuggestions: any[] = [];
          
          // If no 'from' yet, suggest it
          if (!/from\(/.test(textUntilPosition)) {
            hasSuggestions.push({
              label: 'from',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'from($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Start path at this node',
              detail: '.from(node-id)',
              range,
              sortText: '0'
            });
          }
          
          // If has 'from' but no 'to', suggest it
          if (/from\([^)]+\)/.test(textUntilPosition) && !/to\(/.test(textUntilPosition)) {
            hasSuggestions.push({
              label: 'to',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'to($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'End path at this node',
              detail: '.to(node-id)',
              range,
              sortText: '1'
            });
          }
          
          // Always suggest constraint types
          hasSuggestions.push(
            {
              label: 'exclude',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'exclude($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Exclude nodes from path (rules out paths containing these nodes)',
              detail: '.exclude(node-id, ...)',
              range,
              sortText: '2'
            },
            {
              label: 'visited',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'visited($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Must visit these nodes (rules out paths NOT containing these nodes)',
              detail: '.visited(node-id, ...)',
              range,
              sortText: '3'
            },
            {
              label: 'case',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'case($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter by case variant',
              detail: '.case(case-id:variant-name)',
              range,
              sortText: '4'
            }
          );
          
          return { suggestions: hasSuggestions };
        }
        
        // At start of line or after ) → suggest from/to
        if (/^$/.test(textUntilPosition) || /\)$/.test(textUntilPosition)) {
          const suggestions: any[] = [];
          
          if (!/^from\(/.test(textUntilPosition)) {
            suggestions.push({
              label: 'from',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'from($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Start path at this node',
              detail: 'from(node-id)',
              range
            });
          }
          
          if (!/to\(/.test(textUntilPosition) && /from\([^)]+\)/.test(textUntilPosition)) {
            suggestions.push({
              label: 'to',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: '.to($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'End path at this node',
              detail: '.to(node-id)',
              range
            });
          }
          
          return { suggestions };
        }
        
        return { suggestions: [] };
      }
    });
    } // End of language registration check
    
    // Add focus/blur handlers
    editor.onDidFocusEditorText(() => {
      setIsEditing(true);
    });
    
    editor.onDidBlurEditorText(() => {
      setIsEditing(false);
      if (onBlur) {
        onBlur();
      }
    });
    
    // Don't auto-focus (let user click to edit)
    // editor.focus();
  };
  
  // Auto-fill from/to if empty and edge is selected
  useEffect(() => {
    if (!value && currentEdge && editorRef.current && monacoRef.current) {
      const fromNode = allNodes.find((n: any) => n.id === currentEdge.from || n.id === currentEdge.from);
      const toNode = allNodes.find((n: any) => n.id === currentEdge.to || n.id === currentEdge.to);
      
      if (fromNode && toNode) {
        const autoValue = `from(${fromNode.id}).to(${toNode.id})`;
        onChange(autoValue);
      }
    }
  }, [value, currentEdge, allNodes, onChange]);
  
  // Focus Monaco when entering edit mode, clear hover state when leaving
  useEffect(() => {
    if (isEditing) {
      if (editorRef.current) {
        setTimeout(() => {
          editorRef.current?.focus();
        }, 50);
      }
    } else {
      // Clear hover state when returning to chip view
      setHoveredChipIndex(null);
    }
  }, [isEditing]);
  
  // Delete a chip
  const handleDeleteChip = (chipToDelete: ParsedQueryChip, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger edit mode
    
    // Remove this chip from the query string
    const newQuery = value.replace(chipToDelete.rawText, '').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
    onChange(newQuery);
  };
  
  // Chip view component
  const renderChipView = () => {
    if (chips.length === 0) {
      return (
        <div
          onClick={() => !readonly && setIsEditing(true)}
          style={{
            padding: '10px 12px',
            color: '#9CA3AF',
            fontSize: '13px',
            cursor: readonly ? 'default' : 'pointer',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          }}
        >
          {placeholder}
        </div>
      );
    }
    
    return (
      <div
        onClick={(e) => {
          // Only enter edit mode if clicking empty space (not a chip)
          if (e.target === e.currentTarget && !readonly) {
            setIsEditing(true);
          }
        }}
        style={{
          padding: '6px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          cursor: readonly ? 'default' : 'text',
          minHeight: '42px',
          alignItems: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}
      >
        {chips.map((chip, index) => {
          const config = chipConfig[chip.type];
          const Icon = config.icon;
          const isHovered = hoveredChipIndex === index;
          
          return (
            <div
              key={index}
              onMouseEnter={() => setHoveredChipIndex(index)}
              onMouseLeave={() => setHoveredChipIndex(null)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '4px 10px',
                backgroundColor: config.bgColor,
                borderRadius: '6px',
                border: `1px solid ${config.color}20`,
                fontSize: '12px',
                fontWeight: '500',
                position: 'relative',
                transition: 'all 0.15s ease'
              }}
            >
              <Icon size={12} style={{ color: config.color }} />
              <span style={{ color: config.textColor, fontWeight: '600' }}>
                {config.label}:
              </span>
              <span style={{ color: config.textColor }}>
                {chip.values.join(', ')}
              </span>
              
              {/* Delete button on hover */}
              {isHovered && !readonly && (
                <button
                  onClick={(e) => handleDeleteChip(chip, e)}
                  style={{
                    marginLeft: '4px',
                    padding: '2px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    color: config.color,
                    opacity: 0.6
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
                  title="Remove"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  
  return (
    <div style={{ 
      border: '1px solid #ddd', 
      borderRadius: '4px',
      overflow: 'visible',  // Allow autocomplete to overflow
      backgroundColor: '#ffffff',
      position: 'relative'
    }}>
      {/* Show chip view when not editing, Monaco when editing */}
      {!isEditing && !readonly ? (
        renderChipView()
      ) : (
        <Editor
          height={height}
          language="dagnet-query"
          value={value}
          onChange={(newValue) => onChange(newValue || '')}
          onMount={handleEditorDidMount}
          options={{
            readOnly: readonly,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            wrappingStrategy: 'advanced',
            fontSize: 13,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',  // Sans-serif!
            padding: { top: 8, bottom: 8 },
            scrollbar: {
              vertical: 'auto',
              horizontal: 'hidden',
              verticalScrollbarSize: 8
            },
            quickSuggestions: true,
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            wordBasedSuggestions: 'off',
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            automaticLayout: true,
            fixedOverflowWidgets: true,  // Allow suggest widget to overflow container
            suggest: {
              snippetsPreventQuickSuggestions: false,
              showKeywords: true,
              showSnippets: true
            }
          }}
        />
      )}
    </div>
  );
}

