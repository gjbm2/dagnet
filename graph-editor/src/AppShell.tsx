import React, { useState, useEffect, useMemo, useRef } from 'react';
import DockLayout, { LayoutData } from 'rc-dock';
import YAML from 'yaml';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';
import { TabProvider, useTabContext, fileRegistry } from './contexts/TabContext';
import { NavigatorProvider, useNavigatorContext } from './contexts/NavigatorContext';
import { DialogProvider, useDialog } from './contexts/DialogContext';
import { ValidationProvider } from './contexts/ValidationContext';
import { VisibleTabsProvider, useVisibleTabs } from './contexts/VisibleTabsContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { fileOperationsService } from './services/fileOperationsService';
import { repositoryOperationsService } from './services/repositoryOperationsService';
import { sessionLogService } from './services/sessionLogService';
import { MenuBar } from './components/MenuBar';
import { NavigatorContent } from './components/Navigator';
import { TabContextMenu } from './components/TabContextMenu';
import { CommitModal } from './components/CommitModal';
import { gitService } from './services/gitService';
import { getEditorComponent } from './components/editors';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useCommitHandler } from './hooks/useCommitHandler';
import { CopyPasteProvider } from './hooks/useCopyPaste';
import { useStalenessNudges } from './hooks/useStalenessNudges';
import { AutomationBanner } from './components/AutomationBanner';
import { layoutService } from './services/layoutService';
import { dockGroups } from './layouts/defaultLayout';
import { db } from './db/appDatabase';
import { getObjectTypeTheme } from './theme/objectTypeTheme';
import { DashboardModeProvider } from './contexts/DashboardModeContext';
import { useDashboardMode } from './hooks/useDashboardMode';
import { DashboardShell } from './components/Dashboard/DashboardShell';
import 'rc-dock/dist/rc-dock.css'; // Import rc-dock base styles
import './styles/dock-theme.css'; // Safe customizations
import './styles/active-tab-highlight.css'; // Active tab highlighting
import './styles/file-state-indicators.css'; // File state visual indicators

// NOTE: We intentionally do NOT create a permanent right-dock panel.
// Session Log is "right docked" by splitting the existing main panel at open-time.

/**
 * App Shell Content
 * 
 * Main application shell with rc-dock layout
 * Integrates all components: Menu, Navigator, Tabs, Editors
 */
function MainAppShellContent() {
  const { tabs, activeTabId, operations: tabOperations } = useTabContext();
  const { state: navState, operations: navOperations } = useNavigatorContext();
  const dialogOps = useDialog();
  const { updateFromLayout } = useVisibleTabs();
  const { modals: stalenessNudgeModals } = useStalenessNudges();
  const [dockLayoutRef, setDockLayoutRef] = useState<DockLayout | null>(null);
  const recentlyClosedRef = useRef<Set<string>>(new Set());
  const isProgrammaticSwitchRef = useRef(false); // Track when WE trigger rc-dock updates

  // Keep refs to operations and state for the services (avoids re-init on reference changes)
  const navStateRef = useRef(navState);
  const navOperationsRef = useRef(navOperations);
  const tabOperationsRef = useRef(tabOperations);
  const dialogOpsRef = useRef(dialogOps);
  const activeTabIdRef = useRef(activeTabId); // Track activeTabId for callbacks to avoid stale closures
  
  useEffect(() => { navStateRef.current = navState; }, [navState]);
  useEffect(() => { navOperationsRef.current = navOperations; }, [navOperations]);
  useEffect(() => { tabOperationsRef.current = tabOperations; }, [tabOperations]);
  useEffect(() => { dialogOpsRef.current = dialogOps; }, [dialogOps]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  // Warn when logical IDs inside registry-backed files are changed
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<{
        fileId: string;
        type: string;
        oldId: string;
        newId: string;
      }>;
      const detail = e.detail;
      if (!detail) return;

      const { fileId, type, oldId, newId } = detail;

      // Non-blocking warning: highlight risk but do not revert or prevent change
      dialogOps.showConfirm?.({
        title: 'Warning: ID field changed',
        message:
          `You changed the ID inside "${fileId}" from "${oldId}" to "${newId}".\n\n` +
          `This can break graphs and other references that use the old ID. ` +
          `It is usually safer to create a new ${type} or use a dedicated rename flow.\n\n` +
          `Continue with this change? (Cancel is recommended.)`,
        confirmLabel: 'Continue',
        cancelLabel: 'Cancel',
        confirmVariant: 'danger',
      }).catch(() => {
        // Ignore dialog errors in tests/edge cases
      });
    };

    window.addEventListener('dagnet:logicalIdChanged' as any, handler);
    return () => {
      window.removeEventListener('dagnet:logicalIdChanged' as any, handler);
    };
  }, [dialogOps]);

  // DIAGNOSTIC: Track keyboard events and find what's blocking them
  useEffect(() => {
    let keyEventCount = 0;
    let preventDefaultCallStack: string | null = null;
    
    // Monkey-patch preventDefault to capture WHO is calling it on keyboard events
    const originalPreventDefault = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function(this: Event) {
      if (this.type === 'keydown' || this.type === 'keypress' || this.type === 'keyup') {
        preventDefaultCallStack = new Error().stack || 'No stack available';
      }
      return originalPreventDefault.call(this);
    };
    
    const handleKeyDiagnostic = (e: KeyboardEvent) => {
      keyEventCount++;
      preventDefaultCallStack = null; // Reset before event propagates
      
      // Use setTimeout to check AFTER all handlers have run
      setTimeout(() => {
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
        const activeEl = document.activeElement as HTMLElement;
        
        // Log if:
        // 1. It's a printable character to an input
        // 2. defaultPrevented is true (something blocked it!)
        // 3. Every 20th event
        if ((isInput && e.key.length === 1) || e.defaultPrevented || keyEventCount % 20 === 1) {
          console.log('[KEYBOARD DIAGNOSTIC]', {
            key: e.key,
            code: e.code,
            targetTag: target.tagName,
            targetClass: target.className?.slice?.(0, 50),
            activeElementTag: activeEl?.tagName,
            defaultPrevented: e.defaultPrevented,
            blockedBy: e.defaultPrevented ? preventDefaultCallStack : null,
          });
          
          // If something blocked a printable character to an input, this is the bug!
          if (e.defaultPrevented && isInput && e.key.length === 1) {
            console.error('🚨 KEYBOARD BUG DETECTED! Something blocked input. Stack:', preventDefaultCallStack);
          }
        }
      }, 0);
    };
    
    // Use capture phase (first) to see events before anything else
    document.addEventListener('keydown', handleKeyDiagnostic, true);
    
    // Also add a bubble phase listener (last) to see final state
    const handleKeyDiagnosticBubble = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      
      // If it's a printable char to input and was prevented, log it
      if (e.defaultPrevented && isInput && e.key.length === 1) {
        console.error('🚨 [BUBBLE] Key was blocked:', e.key, 'Stack:', preventDefaultCallStack);
      }
    };
    document.addEventListener('keydown', handleKeyDiagnosticBubble, false);
    
    // Debug helper - call window.debugKeyboard() when keyboard stops working
    (window as any).debugKeyboard = () => {
      const activeEl = document.activeElement as HTMLElement;
      const listeners = (window as any).getEventListeners?.(document) || 'Chrome DevTools only';
      
      console.log('=== KEYBOARD DEBUG INFO ===');
      console.log('Active element:', {
        tag: activeEl?.tagName,
        id: activeEl?.id,
        class: activeEl?.className,
        tabIndex: activeEl?.tabIndex,
      });
      console.log('Document keydown listeners:', listeners?.keydown?.length || 'unknown');
      console.log('Window keydown listeners:', (window as any).getEventListeners?.(window)?.keydown?.length || 'unknown');
      
      // Test: create a test input and see if it works
      const testInput = document.createElement('input');
      testInput.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;padding:10px;font-size:16px;';
      testInput.placeholder = 'TYPE HERE TO TEST';
      testInput.id = 'keyboard-debug-test-input';
      document.body.appendChild(testInput);
      testInput.focus();
      console.log('Test input created and focused. Try typing in it.');
      console.log('If typing works in test input but not app inputs, the issue is in React rendering.');
      console.log('If typing fails in test input too, something is blocking at document level.');
      console.log('Remove with: document.getElementById("keyboard-debug-test-input").remove()');
      console.log('===========================');
    };
    
    return () => {
      Event.prototype.preventDefault = originalPreventDefault;
      document.removeEventListener('keydown', handleKeyDiagnostic, true);
      document.removeEventListener('keydown', handleKeyDiagnosticBubble, false);
      delete (window as any).debugKeyboard;
    };
  }, []);

  // Init-from-secret modal state
  const [showInitCredsModal, setShowInitCredsModal] = useState(false);
  const [initSecret, setInitSecret] = useState('');
  const [initError, setInitError] = useState<string | null>(null);
  const [isInitSubmitting, setIsInitSubmitting] = useState(false);
  const [hasUserCredentials, setHasUserCredentials] = useState<boolean | null>(null);

  // DIAGNOSTIC: Check for minimal mode (?minimal URL parameter)
  // In minimal mode, render ONLY GraphEditor with no UI chrome (tabs, navigator, menu, etc.)
  const isMinimalMode = new URLSearchParams(window.location.search).has('minimal');
  
  // Initialize services once on mount (use refs to avoid stale closures)
  const servicesInitializedRef = useRef(false);
  useEffect(() => {
    if (servicesInitializedRef.current) return;
    servicesInitializedRef.current = true;
    
    // Initialize session logging first (needs to be early to capture init events)
    sessionLogService.initialize();
    
    // Create stable wrappers that dereference refs (so services always get current operations)
    const navOpsProxy = new Proxy({} as typeof navOperations, {
      get: (_, prop) => (navOperationsRef.current as any)[prop]
    });
    const tabOpsProxy = new Proxy({} as typeof tabOperations, {
      get: (_, prop) => (tabOperationsRef.current as any)[prop]
    });
    const dialogOpsProxy = new Proxy({} as typeof dialogOps, {
      get: (_, prop) => (dialogOpsRef.current as any)[prop]
    });
    
    fileOperationsService.initialize({
      navigatorOps: navOpsProxy,
      tabOps: tabOpsProxy,
      dialogOps: dialogOpsProxy,
      getWorkspaceState: () => ({
        repo: navStateRef.current.selectedRepo,
        branch: navStateRef.current.selectedBranch
      })
    });
    
    repositoryOperationsService.initialize({
      navigatorOps: navOpsProxy,
      dialogOps: dialogOpsProxy
    });
    
    console.log('✅ Services initialized');
  }, []); // Empty deps - runs once on mount
  
  // Track hover state for unpinned navigator
  const [isHovering, setIsHovering] = useState(false);
  const navButtonRef = React.useRef<HTMLDivElement>(null);
  
  // Navigator resizing - load from localStorage or default to 300
  const [navWidth, setNavWidth] = useState(() => {
    const saved = localStorage.getItem('navigator-width');
    return saved ? parseInt(saved, 10) : 300;
  });
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = React.useRef(0);
  const resizeStartWidth = React.useRef(0);
  
  // Handle navigator resizing with proper mouse tracking
  useEffect(() => {
    if (!isResizing) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Calculate delta from start position
      const delta = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + delta;
      
      // Apply constraints
      const MIN_WIDTH = 200;
      const MAX_WIDTH = 800;
      const constrainedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));
      
      setNavWidth(constrainedWidth);
    };
    
    const handleMouseUp = () => {
      setIsResizing(false);
      // Save to localStorage
      localStorage.setItem('navigator-width', navWidth.toString());
      // Re-enable text selection
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    
    // Disable text selection and set cursor during resize
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, navWidth]);

  // Detect whether user credentials have been configured
  useEffect(() => {
    const checkCredentials = async () => {
      // Check FileRegistry first (fast)
      let credentialsFile = fileRegistry.getFile('credentials-credentials');
      
      // If not in FileRegistry, check IndexedDB
      if (!credentialsFile) {
        credentialsFile = await db.files.get('credentials-credentials');
      }
      
      const gitArray = credentialsFile?.data?.git;
      const hasCreds = Array.isArray(gitArray) && gitArray.length > 0;
      setHasUserCredentials(hasCreds);
    };
    
    checkCredentials();
  }, [tabs.length, navState.selectedRepo, navState.selectedBranch]);

  const handleInitCredentialsFromSecret = async () => {
    if (!initSecret.trim()) {
      setInitError('Please enter a secret.');
      return;
    }

    setIsInitSubmitting(true);
    setInitError(null);

    try {
      const expectedSecret = (import.meta as any).env.VITE_INIT_CREDENTIALS_SECRET as string | undefined;
      const credentialsJson = (import.meta as any).env.VITE_INIT_CREDENTIALS_JSON as string | undefined;

      if (!expectedSecret || !credentialsJson) {
        setInitError('INIT_CREDENTIALS_SECRET / INIT_CREDENTIALS_JSON are not configured on this deployment.');
        return;
      }

      if (initSecret.trim() !== expectedSecret) {
        setInitError('Invalid secret. Please check your initialization secret.');
        return;
      }

      let credentials: any;
      try {
        credentials = JSON.parse(credentialsJson);
      } catch (e) {
        console.error('Failed to parse INIT_CREDENTIALS_JSON', e);
        setInitError('INIT_CREDENTIALS_JSON is not valid JSON.');
        return;
      }

      if (!credentials || !credentials.git || !Array.isArray(credentials.git) || credentials.git.length === 0) {
        setInitError('INIT_CREDENTIALS_JSON does not contain a valid git credentials array.');
        return;
      }

      // Create or update credentials file in the workspace
      const credentialsFileId = 'credentials-credentials';
      const existingFile = fileRegistry.getFile(credentialsFileId);
      const source = existingFile?.source || {
        repository: 'local',
        path: 'credentials.yaml',
        branch: 'main',
      };

      if (!existingFile) {
        await fileRegistry.getOrCreateFile(credentialsFileId, 'credentials', source, credentials);
      } else {
        existingFile.data = credentials;
        existingFile.originalData = structuredClone(credentials);
      }

      await fileRegistry.markSaved(credentialsFileId);

      // Reload workspace with new credentials
      await navOperations.reloadCredentials();

      setHasUserCredentials(true);
      setShowInitCredsModal(false);
      setInitSecret('');
      setInitError(null);

      toast.success('Credentials initialized from environment');
    } catch (error) {
      console.error('Failed to initialize credentials from secret', error);
      setInitError(error instanceof Error ? error.message : 'Failed to initialize credentials');
    } finally {
      setIsInitSubmitting(false);
    }
  };

  /**
   * Initialize with sample data from the public dagnet repo (no authentication required)
   * This allows users to explore the app with sample conversion graphs without needing credentials
   */
  const handleUseSampleData = async () => {
    setIsInitSubmitting(true);
    
    try {
      // Sample credentials for the public dagnet repo - no token needed for read access
      const sampleCredentials = {
        version: '1.0.0',
        git: [{
          name: 'dagnet',
          isDefault: true,
          owner: 'gjbm2',
          // No token - public repo allows unauthenticated read access
          // Users will be in read-only mode (cannot push/commit)
          basePath: 'param-registry/test',
          graphsPath: 'graphs',
          paramsPath: 'parameters',
          contextsPath: 'contexts',
          casesPath: 'cases',
          nodesPath: 'nodes',
          eventsPath: 'events',
        }]
      };

      // Create or update credentials file in the workspace
      const credentialsFileId = 'credentials-credentials';
      const existingFile = fileRegistry.getFile(credentialsFileId);
      const source = existingFile?.source || {
        repository: 'local',
        path: 'credentials.yaml',
        branch: 'main',
      };

      if (!existingFile) {
        await fileRegistry.getOrCreateFile(credentialsFileId, 'credentials', source, sampleCredentials);
      } else {
        existingFile.data = sampleCredentials;
        existingFile.originalData = structuredClone(sampleCredentials);
      }

      await fileRegistry.markSaved(credentialsFileId);

      // Reload workspace with new credentials
      await navOperations.reloadCredentials();

      setHasUserCredentials(true);

      toast.success('Sample data loaded (read-only mode - no GitHub token)');
    } catch (error) {
      console.error('Failed to load sample data', error);
      toast.error('Failed to load sample data: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsInitSubmitting(false);
    }
  };

  // Tab context menu state
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  
  // Commit modal state (lifted to AppShell to persist when context menu closes)
  const [commitModalState, setCommitModalState] = useState<{
    isOpen: boolean;
    preselectedFiles: string[];
  }>({ isOpen: false, preselectedFiles: [] });

  // Centralized commit handler - uses shared hook
  const { handleCommitFiles } = useCommitHandler();

  // Custom groups - NO panelExtra, we'll position Navigator separately
  const customGroups = useMemo(() => ({
    ...dockGroups
  }), []);

  // Enable keyboard shortcuts
  useKeyboardShortcuts();

  // Track which tabs we've already added to rc-dock
  const [addedTabs, setAddedTabs] = React.useState<Set<string>>(new Set());

  // Track tabs we're currently removing to prevent duplicate removal attempts
  const removingTabsRef = React.useRef<Set<string>>(new Set());

  // Helper to extract all tab IDs from a layout - MUST BE DEFINED BEFORE USE
  const extractTabIds = React.useCallback((layout: LayoutData): string[] => {
    const tabIdSet = new Set<string>();
    
    const extractFromBox = (box: any) => {
      if (!box) return;
      
      // Only process tabs if this box has them directly
      if (box.tabs && Array.isArray(box.tabs)) {
        box.tabs.forEach((tab: any) => {
          if (tab.id) tabIdSet.add(tab.id);
        });
      }
      
      // Recurse into children (panels/boxes, not tabs)
      if (box.children && Array.isArray(box.children)) {
        box.children.forEach((child: any) => {
          // Only recurse if child is a box/panel, not a tab
          if (child && typeof child === 'object' && !child.content) {
            extractFromBox(child);
          }
        });
      }
    };
    
    // IMPORTANT: include ALL rc-dock containers.
    // If we ignore maxbox/windowbox, we will treat maximised tabs as "not in layout",
    // and the sync loop will re-add/re-dock them, effectively destroying the maximised state on F5.
    if (layout.dockbox) extractFromBox(layout.dockbox);
    if (layout.floatbox) extractFromBox(layout.floatbox);
    if ((layout as any).windowbox) extractFromBox((layout as any).windowbox);
    if ((layout as any).maxbox) extractFromBox((layout as any).maxbox);
    
    return Array.from(tabIdSet);
  }, []);

  // Add global context menu handler for tabs
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      console.log('=== RIGHT CLICK DEBUG ===');
      console.log('Target:', target.tagName, target.className);
      
      // rc-dock uses role="tab" for tabs
      const roleTab = target.closest('[role="tab"]');
      
      if (roleTab) {
        // Look for our custom data-tab-id attribute in the title div
        const titleDiv = roleTab.querySelector('[data-tab-id]') as HTMLElement;
        const tabId = titleDiv?.getAttribute('data-tab-id');
        
        console.log('Found tab:', {
          foundRoleTab: true,
          foundTitleDiv: !!titleDiv,
          tabId,
          existsInTabs: tabId ? !!tabs.find(t => t.id === tabId) : false
        });
        
        if (tabId && tabs.find(t => t.id === tabId)) {
          e.preventDefault();
          e.stopPropagation();
          
          console.log('✅ SHOWING CONTEXT MENU for', tabId);
          
          setContextMenu({
            tabId,
            x: e.clientX,
            y: e.clientY
          });
        } else {
          console.log('❌ No matching tab found');
        }
      } else {
        console.log('❌ No [role="tab"] found');
      }
    };

    document.addEventListener('contextmenu', handleContextMenu, true);
    return () => document.removeEventListener('contextmenu', handleContextMenu, true);
  }, [tabs]);

  // Track which panel each tab is in for smart placement
  const tabPanelMapRef = React.useRef<Map<string, string>>(new Map());

  // Sync tabs to rc-dock when they change
  useEffect(() => {
    if (!dockLayoutRef) return;

    const currentLayout = dockLayoutRef.getLayout();
    const currentTabIds = extractTabIds(currentLayout);

    // Update panel map - track which panel each tab is in
    const updatePanelMap = (box: any, panelId?: string) => {
      if (!box) return;
      if (box.tabs && Array.isArray(box.tabs)) {
        box.tabs.forEach((tab: any) => {
          if (tab.id && box.id) {
            tabPanelMapRef.current.set(tab.id, box.id);
          }
        });
      }
      if (box.children) {
        box.children.forEach((child: any) => updatePanelMap(child, child.id));
      }
    };
    if (currentLayout.dockbox) updatePanelMap(currentLayout.dockbox);

    // Set flag to prevent switchTab calls during batch updates
    isUpdatingTabsRef.current = true;
    isProgrammaticSwitchRef.current = true;

    tabs.forEach(tab => {
      const isInLayout = currentTabIds.includes(tab.id);
      const hasBeenAdded = addedTabs.has(tab.id);
      
      if (isInLayout && !hasBeenAdded) {
        // Tab exists in layout (placeholder from loadTab) - UPDATE with real content
        console.log(`AppShell: Updating placeholder tab ${tab.id} with real content`);
        // Get file type from registry (fallback to parsing fileId for backwards compatibility)
        const file = fileRegistry.getFile(tab.fileId);
        const objectType = (file?.type || tab.fileId.split('-')[0]) as any;
        const EditorComponent = getEditorComponent(objectType, tab.viewMode);
        const theme = getObjectTypeTheme(objectType);
        const IconComponent = theme.icon;
        
        const realTab = {
          id: tab.id,
          title: (
            <div 
              className="dock-tab-title"
              data-tab-id={tab.id}
              data-is-focused="false"
              data-is-dirty="false"
              data-object-type={objectType}
              onClick={() => tabOperations.switchTab(tab.id)}
            >
              <IconComponent 
                size={14} 
                strokeWidth={2}
                style={{ color: theme.accentColour, flexShrink: 0 }}
              />
              <span style={{ 
                flex: 1, 
                minWidth: 0, 
                overflow: 'hidden', 
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>{tab.title}</span>
            </div>
          ),
          content: (
            <div 
              onClick={() => tabOperations.switchTab(tab.id)}
              style={{ width: '100%', height: '100%' }}
            >
              <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} tabId={tab.id} onChange={() => {}} />
            </div>
          ),
          closable: true,  // Main app tabs are always closable
          cached: true,
          group: 'main-content'
        };
        
        // Update the placeholder with real content
        dockLayoutRef.updateTab(tab.id, realTab, false);
        setAddedTabs(prev => new Set([...prev, tab.id]));
        
        // Check and update dirty state immediately after updating placeholder
        setTimeout(() => {
          const file = fileRegistry.getFile(tab.fileId);
          console.log(`AppShell: Checking dirty state for placeholder tab ${tab.id}, file:`, file);
          if (file) {
            const tabElement = document.querySelector(`[data-tab-id="${tab.id}"]`);
            console.log(`AppShell: Found tab element:`, tabElement);
            if (tabElement) {
              tabElement.setAttribute('data-is-dirty', String(file.isDirty));
              console.log(`AppShell: ✅ Updated placeholder tab ${tab.id} dirty state to ${file.isDirty}`);
            } else {
              console.warn(`AppShell: ❌ Could not find tab element for ${tab.id}`);
            }
          } else {
            console.warn(`AppShell: ❌ Could not find file ${tab.fileId} in registry`);
          }
        }, 50);
        
      } else if (!isInLayout && !hasBeenAdded && !recentlyClosedRef.current.has(tab.id)) {
        // New tab not in layout - ADD to rc-dock (but not if recently closed)
        console.log(`AppShell: Adding new tab ${tab.id} to rc-dock`);
        // Get file type from registry (fallback to parsing fileId for backwards compatibility)
        const file = fileRegistry.getFile(tab.fileId);
        const objectType = (file?.type || tab.fileId.split('-')[0]) as any;
        const EditorComponent = getEditorComponent(objectType, tab.viewMode);
        const theme = getObjectTypeTheme(objectType);
        const IconComponent = theme.icon;
        
        const dockTab = {
          id: tab.id,
          title: (
            <div 
              className="dock-tab-title"
              data-tab-id={tab.id}
              data-is-focused="false"
              data-is-dirty="false"
              data-object-type={objectType}
              onClick={() => tabOperations.switchTab(tab.id)}
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <IconComponent 
                size={14} 
                strokeWidth={2}
                style={{ color: theme.accentColour, flexShrink: 0 }}
              />
              <span style={{ 
                flex: 1, 
                minWidth: 0, 
                overflow: 'hidden', 
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>{tab.title}</span>
            </div>
          ),
          content: (
            <div 
              style={{ width: '100%', height: '100%' }}
            >
              <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} tabId={tab.id} onChange={() => {}} />
            </div>
          ),
          closable: true,  // Main app tabs are always closable
          cached: true,
          group: 'main-content'
        };

        // Determine target panel: use currently active tab's panel, or default to 'main-tabs'
        // Special case: Session Log is right-docked by splitting the main panel at open-time.
        const isSessionLog = objectType === 'session-log' || tab.fileId === 'session-log';
        let targetPanel = 'main-tabs';
        if (activeTabId) {
          const activeTabData = dockLayoutRef.find(activeTabId);
          const activePanel = activeTabData?.parent?.id;
          if (activePanel && activePanel !== 'menu' && activePanel !== 'navigator') {
            targetPanel = activePanel;
            console.log(`AppShell: Opening new tab in focused panel: ${targetPanel}`);
          }
        }

        dockLayoutRef.dockMove(dockTab, targetPanel, isSessionLog ? 'right' : 'middle');
        setAddedTabs(prev => new Set([...prev, tab.id]));
        
        // Check and update dirty state immediately after adding tab
        // Use setTimeout to ensure the DOM has updated
        setTimeout(() => {
          const file = fileRegistry.getFile(tab.fileId);
          console.log(`AppShell: Checking dirty state for new tab ${tab.id}, file:`, file);
          if (file) {
            const tabElement = document.querySelector(`[data-tab-id="${tab.id}"]`);
            console.log(`AppShell: Found tab element:`, tabElement);
            if (tabElement) {
              tabElement.setAttribute('data-is-dirty', String(file.isDirty));
              console.log(`AppShell: ✅ Updated new tab ${tab.id} dirty state to ${file.isDirty}`);
            } else {
              console.warn(`AppShell: ❌ Could not find tab element for ${tab.id}`);
            }
          } else {
            console.warn(`AppShell: ❌ Could not find file ${tab.fileId} in registry`);
          }
        }, 50);
      }
    });

    // Clear flags after batch update completes
    // Use setTimeout to ensure all updateTab calls have finished
    setTimeout(() => {
      isUpdatingTabsRef.current = false;
      isProgrammaticSwitchRef.current = false;
    }, 100);
  }, [tabs, dockLayoutRef, addedTabs, tabOperations, extractTabIds]);

  // Listen for "open in same panel" events
  useEffect(() => {
    const handleOpenInSamePanel = (e: CustomEvent) => {
      const { newTabId, sourceTabId } = e.detail;
      
      if (!dockLayoutRef) return;
      
      console.log(`\n=== OPEN IN SAME PANEL ===`);
      console.log('Source tab:', sourceTabId);
      console.log('New tab:', newTabId);
      console.log('Panel map:', Object.fromEntries(tabPanelMapRef.current));
      
      // Find source tab in rc-dock to get its panel
      const sourceTabData = dockLayoutRef.find(sourceTabId);
      console.log('Source tab data:', sourceTabData);
      console.log('Source tab parent:', sourceTabData?.parent);
      
      const sourcePanel = sourceTabData?.parent?.id;
      console.log('Source panel ID:', sourcePanel);
      
      if (sourcePanel) {
        // Wait for the tab to be added, then move it
        setTimeout(() => {
          const tabData = dockLayoutRef.find(newTabId);
          console.log('Found new tab:', !!tabData);
          if (tabData && ('title' in tabData && 'content' in tabData)) {
            console.log(`Moving ${newTabId} to panel ${sourcePanel}`);
            dockLayoutRef.dockMove(tabData, sourcePanel, 'middle');
          }
        }, 200);
      }
    };
    
    const handleOpenInFocusedPanel = (e: CustomEvent) => {
      const { newTabFileId } = e.detail;
      
      if (!dockLayoutRef || !activeTabId) return;
      
      console.log(`\n=== OPEN IN FOCUSED PANEL ===`);
      console.log('Focused tab:', activeTabId);
      console.log('New file:', newTabFileId);
      
      // Find focused tab in rc-dock to get its panel
      const focusedTabData = dockLayoutRef.find(activeTabId);
      console.log('Focused tab data:', focusedTabData);
      console.log('Focused tab parent:', focusedTabData?.parent);
      
      const focusedPanel = focusedTabData?.parent?.id;
      console.log('Focused panel ID:', focusedPanel);
      
      if (focusedPanel) {
        // Find the new tab (it was just added)
        setTimeout(() => {
          const newTab = tabs.find(t => t.fileId === newTabFileId);
          console.log('Found new tab in tabs array:', newTab?.id);
          if (newTab) {
            const tabData = dockLayoutRef.find(newTab.id);
            console.log('Found new tab in rc-dock:', !!tabData);
            if (tabData && ('title' in tabData && 'content' in tabData)) {
              console.log(`Moving ${newTab.id} to panel ${focusedPanel}`);
              dockLayoutRef.dockMove(tabData, focusedPanel, 'middle');
            }
          }
        }, 200);
      }
    };

    // Session Log right-docking: split the main panel to the right at open-time.
    const handleDockTabRightOfMain = (e: CustomEvent) => {
      const { tabId } = e.detail as any;
      if (!dockLayoutRef || !tabId) return;

      const delays = [0, 50, 200, 750];
      for (const d of delays) {
        setTimeout(() => {
          const tabData = dockLayoutRef.find(tabId);
          if (tabData && ('title' in tabData && 'content' in tabData)) {
            dockLayoutRef.dockMove(tabData, 'main-tabs', 'right');
          }
        }, d);
      }
    };

    window.addEventListener('dagnet:openInSamePanel' as any, handleOpenInSamePanel);
    window.addEventListener('dagnet:openInFocusedPanel' as any, handleOpenInFocusedPanel);
    window.addEventListener('dagnet:dockTabRightOfMain' as any, handleDockTabRightOfMain as any);
    return () => {
      window.removeEventListener('dagnet:openInSamePanel' as any, handleOpenInSamePanel);
      window.removeEventListener('dagnet:openInFocusedPanel' as any, handleOpenInFocusedPanel);
      window.removeEventListener('dagnet:dockTabRightOfMain' as any, handleDockTabRightOfMain as any);
    };
  }, [dockLayoutRef, activeTabId, tabs]);

  // Listen for native close button clicks on MAIN APP TABS and trigger closeTab
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Check if click is on rc-dock's native close button
      if (target.classList.contains('dock-tab-close-btn')) {
        // Only handle if it's NOT in a GraphEditor container (GraphEditor has its own logic)
        const isInGraphEditor = target.closest('.graph-editor-dock-container');
        if (isInGraphEditor) {
          console.log('AppShell: Close button in GraphEditor, ignoring');
          return; // Let GraphEditor handle it
        }
        
        e.stopPropagation();
        e.preventDefault();
        
        // Find the tab element and get its data-node-key
        const tabEl = target.closest('.dock-tab') as HTMLElement;
        const tabId = tabEl?.getAttribute('data-node-key');
        
        console.log('AppShell: Native close button clicked for main app tab:', tabId);
        
        if (tabId) {
          // Call closeTab which will dispatch dagnet:tabClosed event and handle everything
          tabOperations.closeTab(tabId);
        }
      }
    };
    
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [tabOperations]);

  // Listen for tab close events to immediately remove from rc-dock
  useEffect(() => {
    const handleTabClosed = (e: CustomEvent) => {
      const tabId = e.detail.tabId;
      
      // Prevent duplicate removal
      if (removingTabsRef.current.has(tabId)) {
        console.log(`AppShell: Tab ${tabId} already being removed, skipping`);
        return;
      }
      
      console.log(`\n=== RC-DOCK REMOVAL: ${tabId} ===`);
      removingTabsRef.current.add(tabId);
      
      if (dockLayoutRef) {
        // Find the actual tab in rc-dock's layout
        const tabData = dockLayoutRef.find(tabId);
        console.log('AppShell: Found tab in rc-dock:', !!tabData, tabData);
        
        if (tabData && ('title' in tabData && 'content' in tabData)) {
          console.log('AppShell: Calling dockMove to REMOVE tab');
          dockLayoutRef.dockMove(tabData, null, 'remove');
          console.log('AppShell: ✅ Tab removed from rc-dock');
        } else {
          console.warn('AppShell: ⚠️ Tab not found in rc-dock layout, cannot remove');
        }
        
        setAddedTabs(prev => {
          const next = new Set(prev);
          next.delete(tabId);
          console.log(`AppShell: addedTabs: ${prev.size} -> ${next.size}`);
          return next;
        });

      }
      
      // Clear from removing set
      setTimeout(() => {
        removingTabsRef.current.delete(tabId);
      }, 100);
    };

    window.addEventListener('dagnet:tabClosed' as any, handleTabClosed);
    return () => window.removeEventListener('dagnet:tabClosed' as any, handleTabClosed);
  }, [dockLayoutRef]);

  // Sync activeTabId FROM React TO rc-dock (when programmatically changed)
  useEffect(() => {
    console.log(`[AppShell useEffect] activeTabId changed to: ${activeTabId}, dockLayoutRef exists: ${!!dockLayoutRef}`);
    
    if (!dockLayoutRef || !activeTabId) {
      console.log(`[AppShell useEffect] Skipping - missing dockLayoutRef or activeTabId`);
      return;
    }
    
    console.log(`[AppShell useEffect] Syncing activeTabId to rc-dock: ${activeTabId}`);
    
    // Find the tab in rc-dock layout
    const tabData = dockLayoutRef.find(activeTabId);
    console.log(`[AppShell useEffect] dockLayoutRef.find result:`, tabData ? 'FOUND' : 'NOT FOUND');
    
    if (!tabData || !('title' in tabData && 'content' in tabData)) {
      console.log(`[AppShell useEffect] ⚠️ Tab ${activeTabId} not found in rc-dock layout or invalid structure`);
      return;
    }
    
    // Use rc-dock's updateTab to force it to be active
    // This is the proper way to programmatically select a tab in rc-dock
    // Set flag to prevent onLayoutChange from fighting us
    isProgrammaticSwitchRef.current = true;
    console.log(`[AppShell useEffect] Calling dockLayoutRef.updateTab(${activeTabId}, tabData, true)`);
    dockLayoutRef.updateTab(activeTabId, tabData, true);
    console.log(`[AppShell useEffect] ✅ updateTab completed for ${activeTabId}`);
    
    // Clear flag after a short delay to allow rc-dock's events to settle
    setTimeout(() => {
      isProgrammaticSwitchRef.current = false;
      console.log(`[AppShell useEffect] Cleared isProgrammaticSwitchRef flag`);
    }, 100);
  }, [activeTabId, dockLayoutRef]);
  
  // Update data-is-focused and data-is-dirty attributes via DOM
  useEffect(() => {
    const updateTabIndicators = () => {
      document.querySelectorAll('[data-tab-id]').forEach(elem => {
        const tabId = elem.getAttribute('data-tab-id');
        if (!tabId) return;
        
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;
        
        const file = fileRegistry.getFile(tab.fileId);
        
        const isFocused = tabId === activeTabId;
        const isDirty = file?.isDirty || false;
        
        elem.setAttribute('data-is-focused', isFocused ? 'true' : 'false');
        elem.setAttribute('data-is-dirty', isDirty ? 'true' : 'false');
      });
    };
    
    updateTabIndicators();
    
    // Listen for dirty state changes
    const handleDirtyChanged = () => {
      console.log('AppShell: File dirty state changed, updating indicators');
      updateTabIndicators();
    };
    
    window.addEventListener('dagnet:fileDirtyChanged' as any, handleDirtyChanged);
    return () => window.removeEventListener('dagnet:fileDirtyChanged' as any, handleDirtyChanged);
  }, [activeTabId, tabs]);

  // Create default layout
  const defaultLayout: LayoutData = useMemo(() => ({
    dockbox: {
      mode: 'horizontal',
      children: [
        {
          id: 'main-tabs',
          group: 'main-content',
          tabs: [],
          panelLock: {}
        },
      ]
    },
    floatbox: {
      mode: 'float',
      children: []
    }
  }), []);

  // Load saved layout with graceful fallback
  const [layout, setLayout] = React.useState<LayoutData>(defaultLayout);
  const [layoutLoaded, setLayoutLoaded] = React.useState(false);
  
  React.useEffect(() => {
    const loadSavedLayout = async () => {
      try {
        const savedLayout = await layoutService.loadLayout();
        if (savedLayout && savedLayout.dockbox) {
          console.log('Loaded saved layout from IndexedDB');
          setLayout(savedLayout);
          // Initialize visible tabs from loaded layout
          updateFromLayout(savedLayout);
        } else {
          console.log('No saved layout, using default');
          setLayout(defaultLayout);
          // Initialize visible tabs from default layout
          updateFromLayout(defaultLayout);
        }
      } catch (error) {
        console.error('Failed to load layout, using default:', error);
        setLayout(defaultLayout);
        // Initialize visible tabs from default layout
        updateFromLayout(defaultLayout);
      } finally {
        setLayoutLoaded(true);
      }
    };
    
    loadSavedLayout();
  }, [defaultLayout, updateFromLayout]);

  // Track previous layout to detect tab closes
  const prevLayoutRef = React.useRef<LayoutData | null>(null);

  // Load tab callback - rc-dock uses this to hydrate saved layout tabs
  const loadTab = React.useCallback((savedTab: any) => {
    try {
      // savedTab can be either a string (tab ID) or an object with { id: ... }
      const tabId = typeof savedTab === 'string' ? savedTab : savedTab?.id;
      
      console.log('loadTab called with:', savedTab, 'extracted tabId:', tabId);
      
      if (!tabId) {
        console.warn('loadTab: No tab ID provided, returning placeholder');
        return {
          id: 'placeholder',
          title: 'Invalid Tab',
          content: <div>Invalid tab ID</div>,
          closable: false,
          cached: false
        };
      }
      
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
        // This is expected during initial load - layout restores before tabs are loaded
        // Only log in development to avoid noise
        if (import.meta.env.DEV) {
          console.debug(`[AppShell.loadTab] Tab ${tabId} not yet loaded (have ${tabs.length} tabs), returning placeholder`);
        }
        // Return minimal tab data to prevent crash
        // The actual tab will be added when TabContext loads it
        return {
          id: tabId,
          title: 'Loading...',
          content: <div>Loading tab...</div>,
          closable: false,
          cached: false
        };
      }
      
      // Get file type from registry (fallback to parsing fileId for backwards compatibility)
      const file = fileRegistry.getFile(tab.fileId);
      const objectType = (file?.type || tab.fileId.split('-')[0]) as any;
      const EditorComponent = getEditorComponent(objectType, tab.viewMode);
      const theme = getObjectTypeTheme(objectType);
      const IconComponent = theme.icon;
      
      // Return full TabData with content
      return {
        id: tab.id,
        title: (
          <div 
            className="dock-tab-title"
            data-tab-id={tab.id}
            data-is-focused={tab.id === activeTabId ? 'true' : 'false'}
            data-is-dirty="false"
            data-object-type={objectType}
            onClick={() => {
              console.log('Tab title clicked (from loadTab), setting active:', tab.id);
              tabOperations.switchTab(tab.id);
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <IconComponent 
              size={14} 
              strokeWidth={2}
              style={{ color: theme.accentColour, flexShrink: 0 }}
            />
            <span style={{ 
              flex: 1, 
              minWidth: 0, 
              overflow: 'hidden', 
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}>{tab.title}</span>
          </div>
        ),
        content: (
          <div 
            onClick={() => {
              console.log('Tab content clicked (from loadTab), setting active:', tab.id);
              tabOperations.switchTab(tab.id);
            }}
            style={{ width: '100%', height: '100%' }}
          >
            <EditorComponent fileId={tab.fileId} viewMode={tab.viewMode} tabId={tab.id} onChange={() => {}} />
          </div>
        ),
        closable: true,  // Main app tabs are always closable
        cached: true,
        group: 'main-content'
      };
    } catch (error) {
      console.error('loadTab: Error loading tab:', error);
      // Return placeholder to prevent crash
      return {
        id: 'error-tab',
        title: 'Error',
        content: <div>Failed to load tab</div>,
        closable: true,
        cached: false
      };
    }
  }, [tabs, tabOperations]);

  // Track if we're in the middle of updating tabs to prevent loops
  const isUpdatingTabsRef = React.useRef(false);

  // Mark the top-left docked panel with a class for CSS targeting
  const markTopLeftDockedPanel = React.useCallback(() => {
    // Remove existing marks
    document.querySelectorAll('.top-left-docked-panel').forEach(el => {
      el.classList.remove('top-left-docked-panel');
    });
    
    // Find all dock-panels in the app-shell (not in floatbox, not in GraphEditor)
    const allPanels = Array.from(document.querySelectorAll('.app-shell .dock-panel'));
    
    if (allPanels.length === 0) {
      console.log('AppShell: No dock-panels found');
      return;
    }
    
    // Filter out floating panels and GraphEditor panels
    const dockedPanels = allPanels.filter(panel => {
      const isInFloatbox = panel.closest('.dock-fbox') !== null;
      const isInGraphEditor = panel.closest('.graph-editor-dock-container') !== null;
      return !isInFloatbox && !isInGraphEditor;
    });
    
    if (dockedPanels.length === 0) {
      console.log('AppShell: No docked app-level panels found (all are floating or in GraphEditor)');
      return;
    }
    
    console.log(`AppShell: Found ${dockedPanels.length} docked app-level panels`);
    
    // Find the top-left panel by position
    let topLeftPanel: Element | null = null;
    let minX = Infinity;
    let minY = Infinity;
    
    dockedPanels.forEach(panel => {
      const rect = panel.getBoundingClientRect();
      console.log(`AppShell: Panel at x=${rect.left}, y=${rect.top}, dockid=${panel.getAttribute('data-dockid')}`);
      // Consider panels that are at the leftmost position and topmost
      if (rect.left < minX || (rect.left === minX && rect.top < minY)) {
        minX = rect.left;
        minY = rect.top;
        topLeftPanel = panel as Element;
      }
    });
    
    if (topLeftPanel) {
      const panel = topLeftPanel as Element; // Type assertion to help TypeScript
      panel.classList.add('top-left-docked-panel');
      const dockBar = panel.querySelector('.dock-bar') as HTMLElement;
      
      // Force padding via inline style as CSS isn't applying for some reason
      if (dockBar && !navState.isPinned) {
        dockBar.style.paddingLeft = '115px';
      } else if (dockBar && navState.isPinned) {
        dockBar.style.paddingLeft = '4px';
      }
      
      const computedPadding = dockBar ? window.getComputedStyle(dockBar).paddingLeft : 'N/A';
      const appShell = document.querySelector('.app-shell');
      const appShellClasses = appShell ? appShell.className : 'N/A';
      console.log(`AppShell: Marked top-left docked panel (dockid=${panel.getAttribute('data-dockid')}) at x=${minX}, y=${minY}`);
      console.log(`AppShell: app-shell classes="${appShellClasses}", computed paddingLeft=${computedPadding}`);
      console.log(`AppShell: panel classes="${panel.className}"`);
    }
  }, [navState.isPinned]);

  // Save layout to IndexedDB when it changes
  const handleLayoutChange = React.useCallback((newLayout: LayoutData, currentTabId?: string) => {
    // Use ref to get latest activeTabId to avoid stale closure issues
    const latestActiveTabId = activeTabIdRef.current;
    console.log(`[${new Date().toISOString()}] [AppShell] onLayoutChange called, currentTabId:`, currentTabId, 'latestActiveTabId:', latestActiveTabId);
    console.log(`[${new Date().toISOString()}] [AppShell] isProgrammaticSwitch:`, isProgrammaticSwitchRef.current);
    
    // Update visible tabs tracking (Phase 1: Visibility optimization)
    updateFromLayout(newLayout);
    
    // IGNORE if this is triggered by our own programmatic updateTab call
    if (isProgrammaticSwitchRef.current) {
      console.log(`[${new Date().toISOString()}] [AppShell] Ignoring layout change - triggered by our own updateTab`);
      return;
    }
    
    // Update active tab when rc-dock changes active tab (when user clicks tabs)
    // BUT don't do this if we're in the middle of updating tabs (prevents infinite loop)
    if (currentTabId && currentTabId !== latestActiveTabId && !isUpdatingTabsRef.current) {
      console.log(`[${new Date().toISOString()}] [AppShell] rc-dock switched active tab to:`, currentTabId);
      tabOperations.switchTab(currentTabId);
    } else if (isUpdatingTabsRef.current) {
      console.log(`[${new Date().toISOString()}] [AppShell] Ignoring layout change during tab update (preventing loop)`);
    } else if (currentTabId === latestActiveTabId) {
      console.log(`[${new Date().toISOString()}] [AppShell] Ignoring: currentTabId ${currentTabId} already matches activeTabId`);
    }

    if (!prevLayoutRef.current) {
      console.log('AppShell: First layout change, setting prevLayoutRef');
      prevLayoutRef.current = newLayout;
      return;
    }

      const prevTabIds = extractTabIds(prevLayoutRef.current);
      const newTabIds = extractTabIds(newLayout);
    
      console.log('AppShell: Previous tab IDs:', prevTabIds);
      console.log('AppShell: New tab IDs:', newTabIds);
      
    // Find tabs that were closed (in prev but not in new)
      const closedTabIds = prevTabIds.filter(id => !newTabIds.includes(id));
      
      if (closedTabIds.length > 0) {
      console.log('AppShell: Tabs removed from rc-dock:', closedTabIds);
      // Mark as recently closed to prevent re-adding
      closedTabIds.forEach(id => recentlyClosedRef.current.add(id));
      // Clear after a short delay (after TabContext has updated)
      setTimeout(() => {
        closedTabIds.forEach(id => recentlyClosedRef.current.delete(id));
      }, 100);
      
      // Just clean up tracking
      setAddedTabs(prev => {
        const next = new Set(prev);
        closedTabIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      console.log('AppShell: No tabs closed');
    }

    prevLayoutRef.current = newLayout;

    // Debounce save to IndexedDB
    setTimeout(() => {
      layoutService.saveLayout(newLayout);
    }, 1000);
    
    // Mark top-left docked panel for Navigator button padding
    // Delay slightly to let DOM update after layout change
    setTimeout(markTopLeftDockedPanel, 100);
  }, [extractTabIds, tabOperations, markTopLeftDockedPanel, updateFromLayout]); // activeTabId now accessed via ref to avoid stale closures
  
  // Run markTopLeftDockedPanel after layout changes, nav state changes, and on resize
  React.useEffect(() => {
    if (!dockLayoutRef) return;
    
    // Initial mark - run multiple times to ensure it catches the DOM after React finishes rendering
    setTimeout(markTopLeftDockedPanel, 50);
    setTimeout(markTopLeftDockedPanel, 200);
    setTimeout(markTopLeftDockedPanel, 500);
    
    // Watch for window resize
    const handleResize = () => {
      markTopLeftDockedPanel();
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [dockLayoutRef, markTopLeftDockedPanel, navState.isPinned]);

  // DIAGNOSTIC: Minimal mode - render ONLY GraphEditor without any UI chrome
  // Use the currently active tab (same as was loaded before adding ?minimal)
  if (isMinimalMode) {
    // Wait for activeTabId to be set by TabContext (happens after tabs load from IndexedDB)
    if (!activeTabId) {
      return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#666' }}>Loading...</div>
        </div>
      );
    }

    const activeTab = tabs.find(t => t.id === activeTabId);
    
    if (!activeTab) {
      return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#666' }}>No active tab found</div>
        </div>
      );
    }

    // Get file type from registry
    const file = fileRegistry.getFile(activeTab.fileId);
    const objectType = (file?.type || activeTab.fileId.split('-')[0]) as any;
    
    // Use getEditorComponent to get the appropriate editor for this tab
    const EditorComponent = getEditorComponent(objectType, activeTab.viewMode);

    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <EditorComponent
            fileId={activeTab.fileId}
            tabId={activeTab.id}
            readonly={false}
            onChange={() => {}}
            viewMode={activeTab.viewMode}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${navState.isPinned ? 'nav-pinned' : 'nav-unpinned'}`} style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
      {/* Menu bar */}
      <div style={{ height: '40px', borderBottom: '1px solid #e0e0e0', flexShrink: 0, boxSizing: 'border-box' }}>
        <MenuBar />
      </div>
      
      {/* Content area - flex layout for dynamic navigator width */}
      <div style={{ 
        flex: 1, 
        display: 'flex',
        flexDirection: 'row',
        position: 'relative', 
        overflow: 'hidden',
        boxSizing: 'border-box',
        minHeight: 0
      }}>
        {/* Navigator button - ONLY when unpinned */}
        {!navState.isPinned && (
          <div 
            ref={navButtonRef}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              height: '36px',
              padding: '8px 16px',
              background: '#ffffff',
              border: 'none',
              borderRight: '1px solid #e0e0e0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              zIndex: 10, // Behind menu bar dropdowns
              cursor: 'pointer',
              userSelect: 'none',
              boxSizing: 'border-box',
              color: '#666'
            }}
            onClick={() => navOperations.togglePin()}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            <span style={{ fontSize: '12px', lineHeight: 1 }}>▶</span>
            <span style={{ fontSize: '13px', fontWeight: 400, lineHeight: 1 }}>Navigator</span>
          </div>
        )}
        
        {/* Navigator panel - when pinned */}
        {navState.isPinned && (
          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            borderRight: isResizing ? '2px solid #0066cc' : '1px solid #e0e0e0',
            background: '#f8f9fa',
            overflow: 'hidden',
            position: 'relative',
            boxSizing: 'border-box',
            width: `${navWidth}px`,
            minWidth: '200px',
            maxWidth: '800px',
            flexShrink: 0,
            transition: isResizing ? 'none' : 'width 0.1s ease-out'
          }}>
            {/* Navigator header - same height as tab bar */}
            <div style={{
              height: '36px',
              padding: '8px 12px',
              background: '#f8f9fa',
              borderBottom: '1px solid #e0e0e0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              userSelect: 'none',
              flexShrink: 0,
              boxSizing: 'border-box',
              overflow: 'hidden', // Prevent text overflow
              whiteSpace: 'nowrap' // Keep text on one line
            }}
            onClick={() => navOperations.togglePin()}
            >
              <span style={{ fontSize: '12px', lineHeight: 1, flexShrink: 0 }}>▼</span>
              <span style={{ 
                fontSize: '13px', 
                fontWeight: 500, 
                lineHeight: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>Navigator</span>
            </div>
            
            {/* Navigator content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <NavigatorContent />
            </div>
            
            {/* Resize handle - always visible with subtle border */}
            <div 
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Capture starting positions
                resizeStartX.current = e.clientX;
                resizeStartWidth.current = navWidth;
                setIsResizing(true);
              }}
              style={{
                position: 'absolute',
                right: '0',
                top: 0,
                bottom: 0,
                width: '3px',
                cursor: 'col-resize',
                background: isResizing ? '#0066cc' : 'transparent',
                borderLeft: isResizing ? 'none' : '1px solid #e0e0e0',
                zIndex: 1, // Low z-index so context menus appear above it
                transition: isResizing ? 'none' : 'background 0.2s, border 0.2s'
              }}
              onMouseEnter={(e) => {
                if (!isResizing) {
                  e.currentTarget.style.background = 'rgba(0, 102, 204, 0.3)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isResizing) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
              title="Drag to resize Navigator"
            />
          </div>
        )}
        
        {/* Navigator panel - overlay when unpinned + hovering */}
        {!navState.isPinned && isHovering && (
          <div 
            style={{ 
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '240px',
              borderRight: '1px solid #e0e0e0',
              background: '#f8f9fa',
              zIndex: 10, // Behind menu bar (which is z-index: 1000+)
              boxShadow: '4px 0 16px rgba(0, 0, 0, 0.2)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden'
            }}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            {/* Header in overlay */}
            <div style={{
              height: '36px',
              padding: '8px 12px',
              background: '#f8f9fa',
              borderBottom: '1px solid #e0e0e0',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              cursor: 'pointer',
              userSelect: 'none',
              flexShrink: 0,
              boxSizing: 'border-box'
            }}
            onClick={() => navOperations.togglePin()}
            >
              <span style={{ fontSize: '12px', lineHeight: 1 }}>▼</span>
              <span style={{ fontSize: '13px', fontWeight: 500, lineHeight: 1 }}>Navigator</span>
              <span 
                style={{ marginLeft: 'auto', fontSize: '12px', cursor: 'pointer', padding: '4px', lineHeight: 1 }}
                onClick={(e) => { e.stopPropagation(); navOperations.togglePin(); }}
                title="Pin"
              >
                📍
              </span>
            </div>
            
            {/* Content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              <NavigatorContent />
            </div>
          </div>
        )}
        
        {/* rc-dock wrapper - takes remaining flex space */}
        {layoutLoaded && (
          <div style={{
            flex: 1,
            minWidth: 0,
            height: '100%',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <DockLayout
              ref={setDockLayoutRef}
              defaultLayout={layout}
              loadTab={loadTab}
              onLayoutChange={handleLayoutChange}
              groups={customGroups}
              style={{ 
                width: '100%',
                height: '100%'
              }}
            />
            
            {/* Welcome screen when no tabs - positioned BEHIND dock panels */}
            {tabs.length === 0 && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: '0',
                right: 0,
                bottom: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#f0ede7',
                zIndex: 0, /* Behind everything */
                pointerEvents: 'auto' // Allow clicking on links
              }}>
                <img src="/dagnet2.png" alt="DagNet" style={{ marginBottom: '16px', maxWidth: '400px', height: 'auto' }} />
                <p style={{ fontSize: '14px', marginBottom: '24px', color: '#666' }}>Conversion Graph Editor</p>
                <p style={{ fontSize: '12px', color: '#999' }}>Open a file from the Navigator to get started</p>
                <p style={{ fontSize: '11px', color: '#aaa', marginTop: '40px' }}>
                  <a href="mailto:greg@nous.co" style={{ color: '#aaa', textDecoration: 'none' }}>
                    greg@nous.co
                  </a> for support
                </p>
                <p style={{ fontSize: '10px', color: '#ccc', marginTop: '8px' }}>
                  v{import.meta.env.VITE_APP_VERSION || '0.91b'}
                </p>
                {/* Initialization options when no user credentials are configured */}
                {hasUserCredentials === false && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '16px' }}>
                    {/* Use sample data - no authentication needed */}
                    <button
                      type="button"
                      onClick={handleUseSampleData}
                      disabled={isInitSubmitting}
                      style={{
                        padding: '8px 16px',
                        fontSize: '13px',
                        fontWeight: 500,
                        borderRadius: 4,
                        border: '1px solid #3b82f6',
                        background: '#3b82f6',
                        color: '#ffffff',
                        cursor: isInitSubmitting ? 'wait' : 'pointer',
                        opacity: isInitSubmitting ? 0.7 : 1,
                      }}
                    >
                      {isInitSubmitting ? 'Loading…' : 'Use sample data'}
                    </button>
                    <span style={{ fontSize: '10px', color: '#999', textAlign: 'center' }}>
                      Explore example conversion graphs (read-only)
                    </span>
                    
                    {/* Init from server secret - for authenticated access */}
                    <button
                      type="button"
                      onClick={() => {
                        setInitSecret('');
                        setInitError(null);
                        setShowInitCredsModal(true);
                      }}
                      disabled={isInitSubmitting}
                      style={{
                        marginTop: '8px',
                        padding: '6px 12px',
                        fontSize: '12px',
                        borderRadius: 4,
                        border: '1px solid #d1d5db',
                        background: '#ffffff',
                        color: '#374151',
                        cursor: isInitSubmitting ? 'wait' : 'pointer',
                        opacity: isInitSubmitting ? 0.7 : 1,
                      }}
                    >
                      Initialize credentials from server secret…
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab Context Menu */}
        {contextMenu && (
          <TabContextMenu
            tabId={contextMenu.tabId}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onRequestCommit={(preselectedFiles) => {
              // Open commit modal - remote-ahead check happens inside commitFiles
              setCommitModalState({ isOpen: true, preselectedFiles });
              setContextMenu(null); // Close context menu
            }}
          />
        )}

        {/* Commit Modal - at AppShell level so it persists when context menu closes */}
        {commitModalState.isOpen && (
          <CommitModal
            isOpen={commitModalState.isOpen}
            onClose={() => setCommitModalState({ isOpen: false, preselectedFiles: [] })}
            onCommit={handleCommitFiles}
            preselectedFiles={commitModalState.preselectedFiles}
          />
        )}

        {/* Safety nudge modals (currently: pull conflict resolution UI) */}
        {stalenessNudgeModals}

        {/* Init Credentials Modal */}
        {showInitCredsModal && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10000,
            }}
            onClick={() => {
              if (!isInitSubmitting) {
                setShowInitCredsModal(false);
              }
            }}
          >
            <div
              style={{
                background: '#fff',
                borderRadius: 8,
                boxShadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
                maxWidth: 420,
                width: '90%',
                overflow: 'hidden',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                style={{
                  padding: '20px 24px',
                  borderBottom: '1px solid #e5e7eb',
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: 18,
                    fontWeight: 600,
                    color: '#111827',
                  }}
                >
                  Initialize Credentials
                </h3>
                <p
                  style={{
                    margin: '8px 0 0',
                    fontSize: 13,
                    color: '#4b5563',
                    lineHeight: 1.4,
                  }}
                >
                  Enter the initialization secret provided in your deployment configuration. If it matches the
                  server&apos;s <code>INIT_CREDENTIALS_SECRET</code>, DagNet will load credentials from
                  <code> INIT_CREDENTIALS_JSON</code> and apply them as <code>credentials.yaml</code>.
                </p>
              </div>
              <div
                style={{
                  padding: '16px 24px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: '#374151',
                    marginBottom: 4,
                  }}
                >
                  Secret
                </label>
                <input
                  type="password"
                  value={initSecret}
                  onChange={(e) => setInitSecret(e.target.value)}
                  autoFocus
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 13,
                    borderRadius: 4,
                    border: '1px solid #d1d5db',
                    outline: 'none',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (!isInitSubmitting) {
                        handleInitCredentialsFromSecret();
                      }
                    }
                  }}
                />
                {initError && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 12,
                      color: '#b91c1c',
                    }}
                  >
                    {initError}
                  </div>
                )}
              </div>
              <div
                style={{
                  padding: '12px 24px 16px',
                  borderTop: '1px solid #e5e7eb',
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!isInitSubmitting) {
                      setShowInitCredsModal(false);
                    }
                  }}
                  style={{
                    padding: '6px 12px',
                    fontSize: 13,
                    borderRadius: 4,
                    border: '1px solid #d1d5db',
                    background: '#fff',
                    color: '#374151',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInitCredentialsFromSecret}
                  disabled={isInitSubmitting}
                  style={{
                    padding: '6px 12px',
                    fontSize: 13,
                    borderRadius: 4,
                    border: 'none',
                    background: isInitSubmitting ? '#9ca3af' : '#2563eb',
                    color: '#fff',
                    cursor: isInitSubmitting ? 'default' : 'pointer',
                  }}
                >
                  {isInitSubmitting ? 'Initializing…' : 'Initialize'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AppShellContent() {
  const { isDashboardMode } = useDashboardMode();
  if (isDashboardMode) {
    return (
      <>
        <AutomationBanner />
        <DashboardShell />
      </>
    );
  }
  return (
    <>
      <AutomationBanner />
      <MainAppShellContent />
    </>
  );
}

/**
 * App Shell with Providers
 */
export function AppShell() {
  // Check for ?clear or ?clearall parameters to force state reset
  React.useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    
    if (urlParams.has('clearall')) {
      console.warn('🗑️ CLEARING ALL DATA AND SETTINGS due to ?clearall parameter');
      db.clearAllIncludingSettings()
        .then(() => {
          console.log('✅ All data and settings cleared successfully');
          // Remove the ?clearall parameter from URL
          const newUrl = window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
          // Reload to start fresh
          window.location.reload();
        })
        .catch(error => {
          console.error('❌ Failed to clear all data and settings:', error);
        });
    } else if (urlParams.has('clear')) {
      console.warn('🗑️ CLEARING ALL LOCAL STATE due to ?clear parameter');
      db.clearAll()
        .then(() => {
          console.log('✅ Local state cleared successfully');
          // Remove the ?clear parameter from URL
          const newUrl = window.location.pathname;
          window.history.replaceState({}, document.title, newUrl);
          // Reload to start fresh
          window.location.reload();
        })
        .catch(error => {
          console.error('❌ Failed to clear local state:', error);
        });
    }
  }, []);

  return (
    <ErrorBoundary>
      <Toaster 
        position="bottom-center"
        toastOptions={{
          duration: 3000,
          style: {
            background: '#363636',
            color: '#fff',
            fontSize: '14px',
          },
          success: {
            iconTheme: {
              primary: '#10b981',
              secondary: '#fff',
            },
          },
          error: {
            iconTheme: {
              primary: '#ef4444',
              secondary: '#fff',
            },
          },
        }}
      />
      <DashboardModeProvider>
        <DialogProvider>
          <ValidationProvider>
            <TabProvider>
              <NavigatorProvider>
                <VisibleTabsProvider>
                  <CopyPasteProvider>
                    <AppShellContent />
                  </CopyPasteProvider>
                </VisibleTabsProvider>
              </NavigatorProvider>
            </TabProvider>
          </ValidationProvider>
        </DialogProvider>
      </DashboardModeProvider>
    </ErrorBoundary>
  );
}

