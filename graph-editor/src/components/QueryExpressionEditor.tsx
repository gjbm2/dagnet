import React, { useRef, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { X, MapPinCheckInside, MapPinXInside, ArrowRightFromLine, ArrowLeftFromLine, GitBranch, AlertTriangle, FileText, Calendar, ChevronDown, Minus, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import './QueryExpressionEditor.css';
import { QUERY_FUNCTIONS } from '../lib/queryDSL';
import { ContextValueSelector } from './ContextValueSelector';
import { contextRegistry } from '../services/contextRegistry';

interface QueryExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (currentValue: string) => void;
  graph: any;
  edgeId?: string;
  placeholder?: string;
  height?: string;
  readonly?: boolean;
  
  // Self-contained mode: handle override state internally
  overridden?: boolean;
  onClearOverride?: () => void;
  label?: string;
  showLabel?: boolean;
  infoTooltip?: string;
}

interface ParsedQueryChip {
  type: 'from' | 'to' | 'exclude' | 'visited' | 'visitedAny' | 'case' | 'context' | 'contextAny' | 'window' | 'minus' | 'plus';
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
// Chip styling configuration for outer chips (neutral)
const outerChipConfig = {
  from: { 
    label: 'from', 
    icon: ArrowRightFromLine
  },
  to: { 
    label: 'to', 
    icon: ArrowLeftFromLine
  },
  exclude: { 
    label: 'exclude', 
    icon: MapPinXInside
  },
  visited: { 
    label: 'visited', 
    icon: MapPinCheckInside
  },
  visitedAny: {
    label: 'visitedAny',
    icon: MapPinCheckInside
  },
  case: { 
    label: 'case', 
    icon: GitBranch
  },
  context: {
    label: 'context',
    icon: FileText  // Canonical context icon (matches Navigator)
  },
  contextAny: {
    label: 'contextAny',
    icon: FileText  // Same as context
  },
  window: {
    label: 'window',
    icon: Calendar  // Time window
  },
  minus: {
    label: 'minus',
    icon: Minus  // Lucide minus icon
  },
  plus: {
    label: 'plus',
    icon: Plus  // Lucide plus icon
  }
};

// Inner chip styling by type
const innerChipConfig = {
  node: {
    bgColour: '#DBEAFE',  // Light blue
    textColour: '#1E40AF',
    borderColor: '#93C5FD'
  },
  case: {
    bgColour: '#E9D5FF',  // Light purple
    textColour: '#6B21A8',
    borderColor: '#C084FC'
  }
};

// Parse query string into chips
function parseQueryToChips(query: string): ParsedQueryChip[] {
  if (!query) return [];
  
  const chips: ParsedQueryChip[] = [];
  
  // Match ALL function calls in order they appear
  const functionRegex = /(from|to|exclude|visited|visitedAny|case|context|contextAny|window|minus|plus)\(([^)]+)\)/g;
  let match;
  
  while ((match = functionRegex.exec(query)) !== null) {
    const funcType = match[1] as ParsedQueryChip['type'];
    const content = match[2];
    
    chips.push({
      type: funcType,
      values: (funcType === 'exclude' || funcType === 'visited' || funcType === 'visitedAny' || funcType === 'contextAny') 
        ? content.split(',').map(s => s.trim())
        : [content],
      rawText: match[0]
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
  const isEditingRef = useRef(false); // Ref for keyboard commands to check current editing state
  
  // Helper to update both state and ref together
  const updateIsEditing = (editing: boolean) => {
    // Capture current width before entering edit mode
    if (editing && !isEditing && chipContainerRef.current) {
      const currentWidth = chipContainerRef.current.offsetWidth;
      setWidthBeforeEdit(currentWidth);
    }
    
    // Reset width after exiting edit mode
    if (!editing && isEditing) {
      setWidthBeforeEdit(null);
    }
    
    setIsEditing(editing);
    isEditingRef.current = editing;
  };
  
  const [chips, setChips] = useState<ParsedQueryChip[]>([]);
  const [hoveredChipIndex, setHoveredChipIndex] = useState<number | null>(null);
  const [hoveredInnerChip, setHoveredInnerChip] = useState(false);
  const [editorHeight, setEditorHeight] = useState(height);
  const [valueBeforeEdit, setValueBeforeEdit] = useState<string>('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [chipDropdownOpen, setChipDropdownOpen] = useState<number | null>(null);
  const [chipDropdownValues, setChipDropdownValues] = useState<any[]>([]);
  const [chipDropdownAnchor, setChipDropdownAnchor] = useState<HTMLElement | null>(null);
  const [widthBeforeEdit, setWidthBeforeEdit] = useState<number | null>(null);
  const chipDropdownRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const chipContainerRef = useRef<HTMLDivElement>(null);
  
  // Close chip dropdown when clicking outside
  useEffect(() => {
    if (chipDropdownOpen === null) return;
    
    const handleClickOutside = (event: MouseEvent) => {
      if (chipDropdownRef.current && !chipDropdownRef.current.contains(event.target as Node)) {
        setChipDropdownOpen(null);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [chipDropdownOpen]);
  
    // Validate value whenever it changes (for chip mode warning)
  useEffect(() => {
    console.log('[QueryExpressionEditor] Validation useEffect:', { value, isEditing });
    
    if (!value.trim() || isEditing) {
      console.log('[QueryExpressionEditor] Skipping validation (empty or editing)');
      setValidationErrors([]);
      return;
    }
    
    // Strip leading/trailing dots for validation
    const cleanValue = value.trim().replace(/^\.+|\.+$/g, '');
    if (!cleanValue) {
      console.log('[QueryExpressionEditor] Only dots, no validation needed');
      setValidationErrors([]);
      return;
    }
    
    const errors: string[] = [];
    // Allow more flexible patterns for contextAny with multiple key:value pairs
    const validQueryPattern = /^[a-z_-]+\([a-zA-Z0-9_:,\s-]*\)(\.([a-z_-]+\([a-zA-Z0-9_:,\s-]*\)))*$/;
    const patternMatches = validQueryPattern.test(cleanValue);
    console.log('[QueryExpressionEditor] Pattern test:', { cleanValue, patternMatches });
    
    // Skip pattern validation - let parseConstraints handle it
    // (Monaco's built-in validation will catch syntax errors)
    // if (!patternMatches) {
    //   errors.push('Invalid query structure');
    // }
    
    // Check for empty function calls
    if (/\(\s*\)/.test(cleanValue)) {
      errors.push('Functions must have parameters');
    }
    
    // Check for unknown function names
    const functionPattern = /\b([a-z_-]+)\s*\(/g;
    const validFunctions = new Set(QUERY_FUNCTIONS);
    let match;
    while ((match = functionPattern.exec(cleanValue)) !== null) {
      if (!validFunctions.has(match[1])) {
        errors.push(`Unknown function '${match[1]}'`);
      }
    }
    
    console.log('[QueryExpressionEditor] Setting validation errors:', errors);
    setValidationErrors(errors);
  }, [value, isEditing]);
  
  // Parse value into chips when it changes
  useEffect(() => {
    console.log('[QueryExpressionEditor] Value changed, parsing to chips:', { 
      value, 
      isEditing,
      chipsCount: parseQueryToChips(value).length 
    });
    setChips(parseQueryToChips(value));
  }, [value, isEditing]);
  
  // Calculate editor height based on content
  useEffect(() => {
    if (!value || !isEditing) {
      setEditorHeight(height);
      return;
    }
    
    // Estimate lines based on content length and wrapping
    // Rough calculation: ~50 chars per line at default width
    const estimatedLines = Math.ceil(value.length / 50);
    const lineCount = Math.max(1, Math.min(estimatedLines, 5)); // Min 1, max 5 lines
    const lineHeight = 20; // Approximate line height
    const padding = 16; // Top and bottom padding
    const calculatedHeight = (lineCount * lineHeight) + padding;
    
    setEditorHeight(`${calculatedHeight}px`);
  }, [value, isEditing, height]);
  
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
      keywords: [...QUERY_FUNCTIONS],
      
      tokenizer: {
        root: [
          [new RegExp(`\\b(${QUERY_FUNCTIONS.join('|')})\\b`), 'keyword'],
          [/[a-z0-9_-]+/, 'identifier'],
          [/[().,:]/, 'delimiter'],
        ]
      }
    });
    
    // Theme colours (using app's colour scheme)
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
      triggerCharacters: ['.', '(', ',', ':', ';'],
      
      provideCompletionItems: (model, position) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });
        
        // Check if there's a selection - if so, use that as the range to replace
        const selection = editor.getSelection();
        let range;
        if (selection && !selection.isEmpty()) {
          // Use the selection range for replacement
          range = {
            startLineNumber: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLineNumber: selection.endLineNumber,
            endColumn: selection.endColumn
          };
        } else {
          // Otherwise use word range
          const word = model.getWordUntilPosition(position);
          range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          };
        }
        
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
        
        // After .exclude( or .visited( or .visitedAny( → suggest node IDs (graph + registry)
        if (/\.(exclude|visited|visitedAny)\([^)]*$/.test(textUntilPosition)) {
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
        
        // After context( or contextAny( → suggest context keys (async)
        if (/(context|contextAny)\([^:)]*$/.test(textUntilPosition)) {
          // Return a Promise - Monaco supports async completion
          return contextRegistry.getAllContextKeys().then(keys => {
            const suggestions = keys.map(key => ({
              label: key.id,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: key.id,
              documentation: `Context: ${key.id}`,
              detail: key.id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
              range
            }));
            return { suggestions };
          }).catch(err => {
            console.error('Failed to load context keys:', err);
            return { suggestions: [] };
          });
        }
        
        // After context(key: or contextAny(key: → suggest values for that key (async)
        // Match the LAST context( or contextAny( in the string (not the first)
        if (/(context|contextAny)\(([^:)]+):([^)]*)$/.test(textUntilPosition)) {
          // Use a more specific regex that captures the LAST context(key: or contextAny(key:
          const matches = Array.from(textUntilPosition.matchAll(/(context|contextAny)\(([^:)]+):/g));
          const match = matches[matches.length - 1]; // Get last match
          if (match) {
            const contextKey = match[2]; // Group 2 is the key (group 1 is context|contextAny)
            
            // Return a Promise
            return contextRegistry.getValuesForContext(contextKey).then(values => {
              const suggestions = values.map(value => ({
                label: value.id,
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: value.id,
                documentation: value.description || value.label,
                detail: value.label,
                range
              }));
              return { suggestions };
            }).catch(err => {
              console.error('Failed to load context values:', err);
              return { suggestions: [] };
            });
          }
        }
        
        // After window( → suggest date formats (async for current window)
        if (/window\([^)]*$/.test(textUntilPosition)) {
          return (async () => {
            const suggestions: any[] = [
              {
                label: '📅 Last 7 days (-7d:)',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-7d:',
                documentation: 'Last 7 days to now',
                range,
                sortText: '1'
              },
              {
                label: '📅 Last 14 days (-14d:)',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-14d:',
                documentation: 'Last 14 days to now',
                range,
                sortText: '2'
              },
              {
                label: '📅 Last 30 days (-30d:)',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-30d:',
                documentation: 'Last 30 days to now',
                range,
                sortText: '3'
              },
              {
                label: '📅 Last 90 days (-90d:)',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-90d:',
                documentation: 'Last 90 days to now',
                range,
                sortText: '4'
              },
              {
                label: '📆 Last week, complete (-2w:-1w)',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-2w:-1w',
                documentation: 'From 2 weeks ago to 1 week ago (past range)',
                range,
                sortText: '5'
              },
              {
                label: '📆 Last month, complete (-2m:-1m)',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: '-2m:-1m',
                documentation: 'From 2 months ago to 1 month ago (past range)',
                range,
                sortText: '6'
              }
            ];
            
            // Add example with absolute dates (shows d-MMM-yy format)
            try {
              const { formatDateUK } = await import('../lib/dateFormat');
              const today = new Date();
              const weekAgo = new Date(today);
              weekAgo.setDate(today.getDate() - 7);
              
              suggestions.push({
                label: `📆 Example absolute dates: ${formatDateUK(weekAgo)}:${formatDateUK(today)}`,
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: `${formatDateUK(weekAgo)}:${formatDateUK(today)}`,
                documentation: 'Use d-MMM-yy format for specific dates (e.g., 1-Jan-25:31-Dec-25)',
                range,
                sortText: '8'
              });
            } catch (err) {
              // Ignore if date formatting fails
            }
            
            return { suggestions };
          })();
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
              label: 'visitedAny',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'visitedAny($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Must visit at least ONE of these nodes (OR constraint)',
              detail: '.visitedAny(node-id, ...)',
              range,
              sortText: '3.5'
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
            },
            {
              label: 'context',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'context($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter by context dimension',
              detail: '.context(key:value)',
              range,
              sortText: '5'
            },
            {
              label: 'contextAny',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'contextAny($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter by any of several context values (OR within key)',
              detail: '.contextAny(key:val1,val2,...)',
              range,
              sortText: '6'
            },
            {
              label: 'window',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'window($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Time window for data retrieval',
              detail: '.window(start:end) - dates as d-MMM-yy or relative like -90d',
              range,
              sortText: '7'
            },
            {
              label: 'minus',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'minus($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Subtract paths visiting these nodes (inherits base from/to, coefficient -1)',
              detail: '.minus(node-id, ...)',
              range,
              sortText: '5'
            },
            {
              label: 'plus',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'plus($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Add back paths visiting these nodes (coefficient +1, for inclusion-exclusion)',
              detail: '.plus(node-id, ...)',
              range,
              sortText: '6'
            }
          );
          
          return { suggestions: hasSuggestions };
        }
        
        // At start of line, after ), or after ; → suggest from/to OR constraints
        if (/^$/.test(textUntilPosition) || /\)$/.test(textUntilPosition) || /;$/.test(textUntilPosition)) {
          const suggestions: any[] = [];
          
          // Suggest from/to for full queries
          if (!/^from\(/.test(textUntilPosition) && !/;/.test(textUntilPosition)) {
            suggestions.push({
              label: 'from',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'from($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Start path at this node',
              detail: 'from(node-id)',
              range,
              sortText: '0'
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
              range,
              sortText: '1'
            });
          }
          
          // Also suggest constraints (for constraint-only expressions like pinned queries)
          suggestions.push(
            {
              label: 'context',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'context($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter by context dimension',
              detail: 'context(key:value) or context(key) for all values',
              range,
              sortText: '5'
            },
            {
              label: 'contextAny',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'contextAny($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter by any of several context values',
              detail: 'contextAny(key:val1,val2,...)',
              range,
              sortText: '6'
            },
            {
              label: 'window',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'window($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Time window for data',
              detail: 'window(start:end) - dates as d-MMM-yy or -90d',
              range,
              sortText: '7'
            },
            {
              label: 'or',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'or($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Combine alternatives (OR operator)',
              detail: 'or(expr1,expr2,...) - equivalent to expr1;expr2;...',
              range,
              sortText: '8'
            }
          );
          
          return { suggestions };
        }
        
        return { suggestions: [] };
      }
    });
    
    } // End of language registration check
    
    // Register validation/diagnostics for query syntax (per editor instance)
    const validateQuery = (model: Monaco.editor.ITextModel): Monaco.editor.IMarkerData[] => {
      const rawText = model.getValue();
      const markers: Monaco.editor.IMarkerData[] = [];
      
      console.log('[QueryExpressionEditor] Validating text:', rawText);
      
      if (!rawText.trim()) {
        console.log('[QueryExpressionEditor] Empty text, skipping validation');
        return markers; // Empty is okay
      }
      
      // Strip leading/trailing dots for validation (they'll be removed on commit)
      const text = rawText.trim().replace(/^\.+|\.+$/g, '');
      if (!text) {
        console.log('[QueryExpressionEditor] Only dots, skipping validation');
        return markers;
      }
      
      // Check for basic syntax errors
      
      // 1. Check for unmatched parentheses
      const openParens = (text.match(/\(/g) || []).length;
      const closeParens = (text.match(/\)/g) || []).length;
      if (openParens !== closeParens) {
        markers.push({
          severity: monaco.MarkerSeverity.Warning,
          message: 'Unmatched parentheses',
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: text.length + 1
        });
      }
      
      // 2. Check for unknown function names
      const functionPattern = /\b([a-z_-]+)\s*\(/g;
      const validFunctions = new Set(QUERY_FUNCTIONS);
      let match;
      while ((match = functionPattern.exec(text)) !== null) {
        const funcName = match[1];
        if (!validFunctions.has(funcName)) {
          const startPos = model.getPositionAt(match.index);
          const endPos = model.getPositionAt(match.index + funcName.length);
          markers.push({
            severity: monaco.MarkerSeverity.Warning,
            message: `Unknown function '${funcName}'. Valid functions: ${QUERY_FUNCTIONS.join(', ')}`,
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column
          });
        }
      }
      
      // 3. Check for empty function calls
      const emptyCallPattern = /([a-z_-]+)\s*\(\s*\)/g;
      while ((match = emptyCallPattern.exec(text)) !== null) {
        const funcName = match[1];
        const startPos = model.getPositionAt(match.index);
        const endPos = model.getPositionAt(match.index + match[0].length);
        markers.push({
          severity: monaco.MarkerSeverity.Warning,
          message: `Function '${funcName}' requires at least one argument`,
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column
        });
      }
      
      // 4. Check for 'case' syntax (should be case(id:variant))
      const casePattern = /\bcase\s*\(\s*([^)]+)\s*\)/g;
      while ((match = casePattern.exec(text)) !== null) {
        const caseArg = match[1].trim();
        if (!caseArg.includes(':')) {
          const startPos = model.getPositionAt(match.index);
          const endPos = model.getPositionAt(match.index + match[0].length);
          markers.push({
            severity: monaco.MarkerSeverity.Warning,
            message: 'case() expects format: case(case-id:variant-name)',
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column
          });
        }
      }
      
      // 5. Check for overall query structure and invalid tokens
      // Skip strict pattern validation - parseConstraints will validate semantics
      // (This allows flexible contextAny formats like contextAny(key:v1,key:v2))
      
      // 6. Check for trailing tokens without parentheses (like "oasdf" in ".visited(a).oasdf")
      const trailingTokenPattern = /\.([a-z_-]+)\s*$/;
      const trailingMatch = text.match(trailingTokenPattern);
      if (trailingMatch && !text.match(new RegExp(`\\.${trailingMatch[1]}\\(`))) {
        const tokenStart = text.lastIndexOf(trailingMatch[1]);
        const startPos = model.getPositionAt(tokenStart);
        const endPos = model.getPositionAt(tokenStart + trailingMatch[1].length);
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: `'${trailingMatch[1]}' is incomplete - function calls need parentheses`,
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column
        });
      }
      
      console.log('[QueryExpressionEditor] Generated markers:', markers);
      return markers;
    };
    
    // Validate on model change
    editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (model) {
        const markers = validateQuery(model);
        console.log('[QueryExpressionEditor] Setting markers on model:', markers.length, 'markers');
        monaco.editor.setModelMarkers(model, 'dagnet-query', markers);
        
        // Debug: Check if markers were actually set
        const allMarkers = monaco.editor.getModelMarkers({ resource: model.uri });
        console.log('[QueryExpressionEditor] All markers on model after setting:', allMarkers);
      }
    });
    
    // Initial validation
    const model = editor.getModel();
    if (model) {
      const markers = validateQuery(model);
      console.log('[QueryExpressionEditor] Initial validation, setting markers:', markers.length, 'markers');
      monaco.editor.setModelMarkers(model, 'dagnet-query', markers);
    }
    
    // Add focus/blur handlers
    let injectedDot = false;
    
    editor.onDidFocusEditorText(() => {
      // Store the current value when entering edit mode
      const currentValue = editor.getValue();
      console.log('[QueryExpressionEditor] Focus gained, storing value for ESC:', currentValue);
      setValueBeforeEdit(currentValue);
      updateIsEditing(true);
      // Trigger autocomplete immediately on focus
      setTimeout(() => {
        editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
      }, 50);
    });
    
    // Handle clicks in the editor
    editor.onMouseDown((e) => {
      const model = editor.getModel();
      if (!model) return;
      
      const clickedPosition = e.target.position;
      const text = model.getValue();
      const endPosition = model.getPositionAt(text.length);
      
      // If user clicked on empty space or at the end of text, move cursor to end and inject '.'
      if (!clickedPosition || 
          (clickedPosition.lineNumber === endPosition.lineNumber && 
           clickedPosition.column >= endPosition.column)) {
        
        setTimeout(() => {
          // Move cursor to end
          editor.setPosition(endPosition);
          
          // Inject '.' if text doesn't already end with one
          if (text.length > 0 && !text.endsWith('.') && !text.endsWith('(') && !text.endsWith(',')) {
            editor.executeEdits('click-inject', [{
              range: {
                startLineNumber: endPosition.lineNumber,
                startColumn: endPosition.column,
                endLineNumber: endPosition.lineNumber,
                endColumn: endPosition.column
              },
              text: '.'
            }]);
            injectedDot = true;
            
            // Trigger autocomplete
            setTimeout(() => {
              editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
            }, 50);
          }
        }, 0);
      }
    });
    
    editor.onDidBlurEditorText(() => {
      const model = editor.getModel();
      let currentText = model ? model.getValue() : '';
      
      console.log('[QueryExpressionEditor] Editor blur, switching to chip view:', { 
        currentText,
        injectedDot,
        willCallOnBlur: !!onBlur
      });
      
      updateIsEditing(false);
      
      // Strip leading and trailing dots on commit
      if (currentText) {
        const cleanedText = currentText.trim().replace(/^\.+|\.+$/g, '');
        if (cleanedText !== currentText.trim()) {
          console.log('[QueryExpressionEditor] Stripping leading/trailing dots:', { from: currentText, to: cleanedText });
          onChange(cleanedText);
          currentText = cleanedText;
        }
      }
      
      // Clean up trailing '.' if it was injected and user didn't type anything else
      if (injectedDot) {
        if (model) {
          const text = model.getValue();
          if (text.endsWith('.')) {
            // Check if there's a valid term before the dot, or if it's just a trailing dot
            const beforeDot = text.slice(0, -1);
            // If the dot is truly trailing (not part of a chain like .visited.), remove it
            if (!beforeDot.match(/\([^)]*$/)) {  // Not in the middle of a term
              console.log('[QueryExpressionEditor] Removing injected trailing dot:', { from: text, to: beforeDot });
              onChange(beforeDot);
              currentText = beforeDot;
            }
          }
        }
        injectedDot = false;
      }
      
      if (onBlur) {
        onBlur(currentText);
      }
    });
    
    // Handle Tab key: accept suggestion OR move to next field
    editor.addCommand(monaco.KeyCode.Tab, () => {
      // CRITICAL: Only handle if we're actually in editing mode
      // Monaco's addCommand fires for ALL monaco instances, so we must check our ref
      if (!isEditingRef.current) {
        return; // Not editing, ignore this event - don't interfere with other editors
      }
      
      const suggestController = editor.getContribution('editor.contrib.suggestController') as any;
      
      // State >= 1 = suggestions widget is active (1 = loading/inside params, 2 = visible with suggestions)
      const isSuggestWidgetVisible = (suggestController?.model?.state ?? 0) >= 1;
      
      console.log('[QueryExpressionEditor] Tab pressed:', { 
        isSuggestWidgetVisible,
        controllerState: suggestController?.model?.state
      });
      
      if (isSuggestWidgetVisible) {
        // Manually trigger Monaco's accept suggestion command
        console.log('[QueryExpressionEditor] Triggering acceptSelectedSuggestion');
        editor.trigger('keyboard', 'acceptSelectedSuggestion', {});
      } else {
        // No suggestions - move to next field
        console.log('[QueryExpressionEditor] No suggestions, moving to next field');
        
        const domNode = editor.getDomNode();
        if (domNode) {
          domNode.blur();
        }
        
        // Move focus to next focusable element
        setTimeout(() => {
          const focusableElements = document.querySelectorAll(
            'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          const currentIndex = Array.from(focusableElements).indexOf(document.activeElement as HTMLElement);
          const nextElement = focusableElements[currentIndex + 1] as HTMLElement;
          if (nextElement?.focus) {
            nextElement.focus();
          }
        }, 10);
      }
    });
    
    // Handle Enter key: accept suggestion OR commit and exit
    editor.addCommand(monaco.KeyCode.Enter, () => {
      // CRITICAL: Only handle if we're actually in editing mode
      // Monaco's addCommand fires for ALL monaco instances, so we must check our ref
      if (!isEditingRef.current) {
        return; // Not editing, ignore this event - don't interfere with other editors
      }
      
      const suggestController = editor.getContribution('editor.contrib.suggestController') as any;
      const isSuggestWidgetVisible = (suggestController?.model?.state ?? 0) >= 1;
      
      console.log('[QueryExpressionEditor] Enter pressed:', { 
        isSuggestWidgetVisible,
        controllerState: suggestController?.model?.state
      });
      
      if (isSuggestWidgetVisible) {
        // Accept suggestion
        console.log('[QueryExpressionEditor] Triggering acceptSelectedSuggestion');
        editor.trigger('keyboard', 'acceptSelectedSuggestion', {});
      } else {
        // Commit and exit edit mode
        console.log('[QueryExpressionEditor] Committing and exiting edit mode');
        const currentValue = editor.getValue();
        updateIsEditing(false);
        const domNode = editor.getDomNode();
        if (domNode) {
          domNode.blur();
        }
        if (onBlur) {
          onBlur(currentValue);
        }
      }
    });
    
    // Trigger autocomplete after typing "("
    editor.onDidChangeModelContent((e) => {
      const model = editor.getModel();
      if (!model) return;
      
      const position = editor.getPosition();
      if (!position) return;
      
      const textBeforeCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - 1),
        endLineNumber: position.lineNumber,
        endColumn: position.column
      });
      
      // If user just typed "(", trigger suggestions
      if (textBeforeCursor === '(') {
        setTimeout(() => {
          editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }, 50);
      }
    });
    
    // Force word wrap and sans-serif font (Monaco sometimes ignores initial options)
    editor.updateOptions({
      wordWrap: 'on',
      wrappingStrategy: 'advanced',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontLigatures: false,
      acceptSuggestionOnCommitCharacter: true,
      suggest: {
        snippetsPreventQuickSuggestions: false,
        showKeywords: true,
        showSnippets: true,
        showStatusBar: true,  // Show status bar with details in suggest widget
        insertMode: 'replace'
      }
    });
    
    // Handle ESC key: close autocomplete OR revert and exit
    editor.addCommand(monaco.KeyCode.Escape, () => {
      // CRITICAL: Only handle if we're actually in editing mode
      // Monaco's addCommand fires for ALL monaco instances, so we must check our ref
      if (!isEditingRef.current) {
        return; // Not editing, ignore this event - don't interfere with other editors
      }
      
      const suggestController = editor.getContribution('editor.contrib.suggestController') as any;
      const isSuggestWidgetVisible = (suggestController?.model?.state ?? 0) >= 1;
      
      console.log('[QueryExpressionEditor] ESC pressed:', { 
        isSuggestWidgetVisible,
        controllerState: suggestController?.model?.state
      });
      
      if (isSuggestWidgetVisible) {
        // Just close the autocomplete widget, stay in edit mode
        console.log('[QueryExpressionEditor] Closing autocomplete');
        editor.trigger('keyboard', 'hideSuggestWidget', {});
      } else {
        // Revert to value before edit and exit
        console.log('[QueryExpressionEditor] Reverting and exiting edit mode');
        const currentValue = editor.getValue();
        if (valueBeforeEdit !== currentValue) {
          onChange(valueBeforeEdit);
        }
        updateIsEditing(false);
        // Blur the editor by removing focus
        const domNode = editor.getDomNode();
        if (domNode) {
          domNode.blur();
        }
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
    console.log('[QueryExpressionEditor] isEditing changed:', { 
      isEditing, 
      currentValue: value,
      hasEditor: !!editorRef.current
    });
    
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
  }, [isEditing, value]);
  
  // Delete an inner chip value
  const handleDeleteInnerChip = (chip: ParsedQueryChip, valueToDelete: string, vIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    const newValues = chip.values.filter((_, i) => i !== vIndex);
    
    if (newValues.length === 0) {
      // If no values left, remove the entire chip
      handleDeleteChip(chip, e);
      return;
    }
    
    // Find the position of this specific value within the chip
    const chipStartIndex = value.indexOf(chip.rawText);
    const valueStartInChip = chip.rawText.indexOf(valueToDelete);
    const cursorPosition = chipStartIndex + valueStartInChip;
    
    // Replace with updated values
    const newValuesStr = newValues.join(', ');
    const newTerm = `${chip.type}(${newValuesStr})`;
    const newQuery = value.replace(chip.rawText, newTerm);
    onChange(newQuery);
    
    // Enter edit mode and position cursor at the deletion point
    updateIsEditing(true);
    
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        // Position cursor at the deletion point
        const cursorPos = model.getPositionAt(Math.min(cursorPosition, newQuery.length));
        editorRef.current.setPosition(cursorPos);
        editorRef.current.focus();
        
        // Trigger autocomplete
        setTimeout(() => {
          editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }, 50);
      }
    }, 100);
  };
  
  // Delete a chip (entire term) - remove without entering Monaco mode
  const handleDeleteChip = (chipToDelete: ParsedQueryChip, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger edit mode
    e.preventDefault(); // Prevent any default action
    
    console.log('[QueryExpressionEditor] handleDeleteChip called:', {
      chipToDelete: chipToDelete.rawText,
      currentValue: value
    });
    
    // Remove this chip from the query string and clean up dots
    let newQuery = value.replace(chipToDelete.rawText, '')
      .replace(/\.+/g, '.') // Replace multiple dots with single dot
      .replace(/^\.|\.$/g, '') // Remove leading/trailing dots
      .trim();
    
    console.log('[QueryExpressionEditor] handleDeleteChip computed newQuery:', newQuery);
    console.log('[QueryExpressionEditor] handleDeleteChip calling onChange and onBlur');
    onChange(newQuery);
    
    // Commit the change immediately via onBlur
    if (onBlur) {
      onBlur(newQuery);
    }
    
    console.log('[QueryExpressionEditor] handleDeleteChip complete');
    
    // Don't enter edit mode - just remove the chip
  };
  
  const [chipDropdownOtherPolicy, setChipDropdownOtherPolicy] = useState<'null' | 'computed' | 'explicit' | 'undefined' | undefined>();
  
  const handleChipDropdownOpen = async (chipIndex: number, chip: ParsedQueryChip, e: React.MouseEvent, anchorEl: HTMLElement) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Only for context and contextAny chips
    if (chip.type !== 'context' && chip.type !== 'contextAny') return;
    
    // Extract context key from first value (format: "key:value")
    const firstValue = chip.values[0];
    const contextKey = firstValue?.split(':')[0];
    if (!contextKey) return;
    
    // Load context definition and values
    try {
      const context = await contextRegistry.getContext(contextKey);
      const values = await contextRegistry.getValuesForContext(contextKey);
      setChipDropdownValues(values);
      setChipDropdownOtherPolicy(context?.otherPolicy);
      setChipDropdownAnchor(anchorEl);
      setChipDropdownOpen(chipIndex);
    } catch (err) {
      console.error('Failed to load context values:', err);
    }
  };
  
  const handleChipDropdownApply = async (key: string, selectedValues: string[]) => {
    if (chipDropdownOpen === null) return;
    
    const chip = chips[chipDropdownOpen];
    const otherChips = chips.filter((_, i) => i !== chipDropdownOpen);
    
    // Check if all values are selected AND key is MECE (should remove chip)
    const allValues = chipDropdownValues;
    const allSelected = allValues.length > 0 && selectedValues.length === allValues.length;
    const isMECE = chipDropdownOtherPolicy !== 'undefined';
    
    let newChipText: string;
    if (selectedValues.length === 0 || (allSelected && isMECE)) {
      // Remove chip entirely (no values OR all values selected for MECE key = no filter)
      const newValue = otherChips.map(c => c.rawText).join('.');
      onChange(newValue);
      if (onBlur) onBlur(newValue); // Also trigger onBlur to persist
      setChipDropdownOpen(null);
      
      if (allSelected && isMECE) {
        toast.success('All values selected = no filter (chip removed)', { duration: 2000 });
      }
      return;
    } else if (selectedValues.length === 1) {
      // Single value: context(key:value)
      newChipText = `context(${key}:${selectedValues[0]})`;
    } else {
      // Multiple values: contextAny(key:val1,val2,...)
      const pairs = selectedValues.map(v => `${key}:${v}`).join(',');
      newChipText = `contextAny(${pairs})`;
    }
    
    // Rebuild query with updated chip
    const newChips = [...otherChips];
    newChips.splice(chipDropdownOpen, 0, parseQueryToChips(newChipText)[0]);
    const newValue = newChips.map(c => c.rawText).join('.');
    onChange(newValue);
    if (onBlur) onBlur(newValue); // Also trigger onBlur to persist
    setChipDropdownOpen(null);
  };
  
  // Click outer chip to select the whole term in Monaco
  const handleOuterChipClick = (chip: ParsedQueryChip, e: React.MouseEvent) => {
    e.stopPropagation();
    if (readonly) return;
    
    console.log('[QueryExpressionEditor] Outer chip clicked:', { 
      chip: chip.rawText,
      currentValue: value 
    });
    setValueBeforeEdit(value); // Store original value for ESC revert
    updateIsEditing(true);
    
    // Wait for editor to mount, then select the entire term
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        const fullText = model.getValue();
        const startIndex = fullText.indexOf(chip.rawText);
        if (startIndex >= 0) {
          const startPos = model.getPositionAt(startIndex);
          const endPos = model.getPositionAt(startIndex + chip.rawText.length);
          
          editorRef.current.setSelection({
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column
          });
          editorRef.current.focus();
          
          // Trigger autocomplete
          setTimeout(() => {
            editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
          }, 50);
        }
      }
    }, 100);
  };
  
  // Click inner chip to select just the ID/value in Monaco
  const handleInnerChipClick = (chip: ParsedQueryChip, valueText: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (readonly) return;
    
    console.log('[QueryExpressionEditor] Inner chip clicked:', { 
      chip: chip.rawText,
      valueText,
      currentValue: value 
    });
    setValueBeforeEdit(value); // Store original value for ESC revert
    updateIsEditing(true);
    
    // Wait for editor to mount, then select just the value
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        const fullText = model.getValue();
        const chipIndex = fullText.indexOf(chip.rawText);
        if (chipIndex >= 0) {
          const valueIndex = fullText.indexOf(valueText, chipIndex);
          if (valueIndex >= 0) {
            const startPos = model.getPositionAt(valueIndex);
            const endPos = model.getPositionAt(valueIndex + valueText.length);
            
            editorRef.current.setSelection({
              startLineNumber: startPos.lineNumber,
              startColumn: startPos.column,
              endLineNumber: endPos.lineNumber,
              endColumn: endPos.column
            });
            editorRef.current.focus();
            
            // Trigger autocomplete
            setTimeout(() => {
              editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
            }, 50);
          }
        }
      }
    }, 100);
  };
  
  // Chip view component
  const renderChipView = () => {
    return (
      <div>
        {/* Validation warning banner - show for any validation errors */}
        {validationErrors.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            backgroundColor: '#FEF2F2',
            borderBottom: '1px solid #FCA5A5',
            fontSize: '12px',
            color: '#991B1B'
          }}>
            <AlertTriangle size={14} />
            <span>{validationErrors.join('; ')}</span>
          </div>
        )}
        
        {chips.length === 0 ? (
          <div
            onClick={() => {
              if (!readonly) {
                console.log('[QueryExpressionEditor] Empty placeholder clicked, entering edit mode');
                updateIsEditing(true);
                
                // Inject a '.' and trigger autocomplete to show all functions
                setTimeout(() => {
                  if (editorRef.current && monacoRef.current) {
                    editorRef.current.focus();
                    const model = editorRef.current.getModel();
                    if (model) {
                      // Insert '.' at start
                      editorRef.current.executeEdits('placeholder-inject', [{
                        range: {
                          startLineNumber: 1,
                          startColumn: 1,
                          endLineNumber: 1,
                          endColumn: 1
                        },
                        text: '.'
                      }]);
                      
                      // Position cursor after the dot and trigger autocomplete
                      editorRef.current.setPosition({ lineNumber: 1, column: 2 });
                      editorRef.current.trigger('keyboard', 'editor.action.triggerSuggest', {});
                    }
                  }
                }, 50);
              }
            }}
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
        ) : (
          <div
            onClick={(e) => {
              // Only enter edit mode if clicking empty space (not a chip)
              if (e.target === e.currentTarget && !readonly) {
                console.log('[QueryExpressionEditor] Empty space clicked, entering edit mode');
                setValueBeforeEdit(value); // Store original value for ESC revert
                updateIsEditing(true);
              
                // Position cursor at end of text and insert '.' to trigger autocomplete
                setTimeout(() => {
                  if (editorRef.current && monacoRef.current) {
                    const model = editorRef.current.getModel();
                    if (model) {
                      const text = model.getValue();
                      const endPosition = model.getPositionAt(text.length);
                      
                      // If text doesn't end with '.', '(', or ',', add a '.'
                      if (!text.endsWith('.') && !text.endsWith('(') && !text.endsWith(',')) {
                        editorRef.current.executeEdits('click-inject', [{
                          range: {
                            startLineNumber: endPosition.lineNumber,
                            startColumn: endPosition.column,
                            endLineNumber: endPosition.lineNumber,
                            endColumn: endPosition.column
                          },
                          text: '.'
                        }]);
                        
                        // Position cursor after the dot
                        const newEndPosition = model.getPositionAt(text.length + 1);
                        editorRef.current.setPosition(newEndPosition);
                      } else {
                        editorRef.current.setPosition(endPosition);
                      }
                      
                      editorRef.current.focus();
                      
                      // Trigger autocomplete
                      setTimeout(() => {
                        editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
                      }, 50);
                    }
                  }
                }, 50);
              }
            }}
            ref={chipContainerRef}
            style={{
              padding: '3px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px',
              cursor: readonly ? 'default' : 'text',
              minHeight: '32px',
              alignItems: 'center',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
              maxWidth: '100%',
              wordBreak: 'normal'
            }}
          >
        {chips.map((chip, index) => {
          const config = outerChipConfig[chip.type];
          const Icon = config.icon;
          const isHovered = hoveredChipIndex === index;
          
          // Determine inner chip type (node or case)
          const innerType = chip.type === 'case' ? 'case' : 'node';
          const innerConfig = innerChipConfig[innerType];
          
          return (
            <div
              key={index}
              ref={(el) => {
                if (el) chipRefs.current.set(index, el);
              }}
              onMouseEnter={() => setHoveredChipIndex(index)}
              onMouseLeave={() => setHoveredChipIndex(null)}
              onClick={(e) => handleOuterChipClick(chip, e)}
              style={{
                display: 'inline-flex',
                alignItems: 'flex-start',  // Align to top when wrapped
                flexWrap: 'wrap',
                gap: '4px',
                padding: '5px 8px',
                backgroundColor: '#F9FAFB',  // Neutral light grey
                borderRadius: '6px',
                border: '1px solid #D1D5DB',
                fontSize: '12px',
                fontWeight: '500',
                position: 'relative',
                transition: 'all 0.15s ease',
                cursor: readonly ? 'default' : 'pointer',
                maxWidth: '100%',
                minWidth: 0  // Allow shrinking below content size
              }}
            >
              <Icon size={13} style={{ color: '#6B7280', alignSelf: 'center' }} />
              <span style={{ color: '#374151', fontWeight: '600', alignSelf: 'center' }}>
                {config.label}
              </span>
              <span style={{ color: '#6B7280', alignSelf: 'center' }}>(</span>
              
              {/* Inner chips for values */}
              {chip.values.map((val, vIndex) => (
                <React.Fragment key={vIndex}>
                  <div
                    onClick={(e) => handleInnerChipClick(chip, val, e)}
                    onMouseEnter={() => setHoveredInnerChip(true)}
                    onMouseLeave={() => setHoveredInnerChip(false)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '2px 6px',
                      backgroundColor: innerConfig.bgColour,
                      borderRadius: '4px',
                      border: `1px solid ${innerConfig.borderColor}`,
                      fontSize: '11px',
                      fontWeight: '500',
                      cursor: readonly ? 'default' : 'pointer',
                      position: 'relative',
                      wordBreak: 'break-word',
                      maxWidth: '100%'
                    }}
                  >
                    <span style={{ color: innerConfig.textColour }}>
                      {val}
                    </span>
                  </div>
                  {vIndex < chip.values.length - 1 && (
                    <span style={{ color: '#6B7280', margin: '0 2px', alignSelf: 'center' }}>,</span>
                  )}
                </React.Fragment>
              ))}
              
              <span style={{ color: '#6B7280', alignSelf: 'center' }}>)</span>
              
              {/* Dropdown button for context chips */}
              {!readonly && (chip.type === 'context' || chip.type === 'contextAny') && (
                <button
                  type="button"
                  onClick={(e) => {
                    const chipEl = chipRefs.current.get(index);
                    if (chipEl) {
                      handleChipDropdownOpen(index, chip, e, chipEl);
                    }
                  }}
                  style={{
                    marginLeft: '4px',
                    padding: '2px 4px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    alignSelf: 'center',
                    color: '#9CA3AF',
                    transition: 'color 0.15s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#374151'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#9CA3AF'}
                  title="Change values"
                >
                  <ChevronDown size={12} />
                </button>
              )}
              
              {/* Delete button for entire outer chip - always visible */}
              {!readonly && (
                <button
                  type="button"
                  onClick={(e) => handleDeleteChip(chip, e)}
                  style={{
                    marginLeft: '2px',
                    padding: '2px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    alignSelf: 'center',
                    color: '#9CA3AF',
                    transition: 'color 0.15s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = '#374151'}
                  onMouseLeave={(e) => e.currentTarget.style.color = '#9CA3AF'}
                  title="Remove term"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
          </div>
        )}
      </div>
    );
  };
  
  return (
    <div style={{ 
      border: '1px solid #ddd', 
      borderRadius: '4px',
      overflow: 'visible',  // Allow autocomplete to overflow
      backgroundColor: '#ffffff',
      position: 'relative',
      zIndex: 'auto',  // Don't create a stacking context - let Monaco widgets (appended to body) use global z-index
      minWidth: widthBeforeEdit ? `${widthBeforeEdit}px` : 'auto',
      width: isEditing && widthBeforeEdit ? `${widthBeforeEdit}px` : 'auto'
    }}>
      {/* Per-chip dropdown for context value selection */}
      {chipDropdownOpen !== null && chipDropdownValues.length > 0 && chipDropdownAnchor && (
        <div 
          ref={chipDropdownRef}
          style={{
            position: 'fixed',
            top: `${chipDropdownAnchor.getBoundingClientRect().bottom + 4}px`,
            left: `${chipDropdownAnchor.getBoundingClientRect().left}px`,
            zIndex: 1000
          }}
        >
          <ContextValueSelector
            mode="single-key"
            contextKey={chips[chipDropdownOpen]?.values[0]?.split(':')[0] || ''}
            availableValues={chipDropdownValues}
            currentValues={chips[chipDropdownOpen]?.values.map(v => v.split(':')[1]) || []}
            onApply={handleChipDropdownApply}
            onCancel={() => setChipDropdownOpen(null)}
            anchorEl={chipDropdownAnchor}
            otherPolicy={chipDropdownOtherPolicy}
          />
        </div>
      )}
      {/* Show chip view when not editing, Monaco when editing */}
      {!isEditing && !readonly ? (
        renderChipView()
      ) : (
        <Editor
          height={editorHeight}
          language="dagnet-query"
          value={value}
          onChange={(newValue) => {
            console.log('[QueryExpressionEditor] Monaco onChange:', { 
              newValue, 
              oldValue: value,
              isEditing 
            });
            onChange(newValue || '');
          }}
          onMount={handleEditorDidMount}
          options={{
            readOnly: readonly,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: true,  // Show glyph margin for warning/error icons
            folding: false,
            lineDecorationsWidth: 4,  // Show decorations for warnings/errors
            lineNumbersMinChars: 0,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            wrappingStrategy: 'advanced',
            fontSize: 13,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
            fontLigatures: false,  // Disable ligatures for clearer text
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
            fixedOverflowWidgets: true,  // Append widgets to body so they can render above all panel content
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

