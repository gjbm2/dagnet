#!/usr/bin/env python3
"""
Manual Console Log to Trace Correlator

Since console logs aren't in the trace, we'll correlate based on 
timing patterns from tmp.log
"""

import sys
from datetime import datetime

# Console logs from tmp.log
console_logs = """
GraphCanvas.tsx:192 [2025-11-15T20:12:53.440Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:53.440Z] [GraphCanvas] Render frame #18 start
GraphCanvas.tsx:192 [2025-11-15T20:12:53.449Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:53.449Z] [GraphCanvas] Render frame #19 start
AppShell.tsx:59 AppShell render - navState: {isOpen: true, isPinned: true, searchQuery: '', selectedRepo: 'dagnet', selectedBranch: 'project-data', …}
EditMenu.tsx:26 EditMenu render: {activeTabId: 'tab-graph-test-project-data-interactive', fileId: 'graph-test-project-data', viewMode: 'interactive', isGraphEditor: true, isFormEditor: false, …}
DataMenu.tsx:469 [DataMenu] RENDER STATE: {selectedEdgeId: null, selectedNodeId: null, hasEdgeSelection: false, hasNodeSelection: false, hasSelection: false, …}
GraphEditor.tsx:158 [GraphEditor graph-test-project-data] RENDER: tabId=tab-graph-test-project-data-interactive, isVisible=true, visibleTabs=[tab-graph-test-project-data-interactive]
GraphEditor.tsx:1257 [2025-11-15T20:12:53.980Z] GraphEditor render: {fileId: 'graph-test-project-data', hasData: true, hasNodes: true, nodeCount: 7, isDirty: true, …}
GraphCanvas.tsx:192 [2025-11-15T20:12:53.984Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:53.984Z] [GraphCanvas] Render frame #20 start
GraphCanvas.tsx:192 [2025-11-15T20:12:54.030Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:54.031Z] [GraphCanvas] Render frame #21 start
GraphCanvas.tsx:192 [2025-11-15T20:12:54.158Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:54.158Z] [GraphCanvas] Render frame #22 start
GraphCanvas.tsx:192 [2025-11-15T20:12:54.672Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:54.673Z] [GraphCanvas] Render frame #23 start
AppShell.tsx:59 AppShell render - navState: {isOpen: true, isPinned: true, searchQuery: '', selectedRepo: 'dagnet', selectedBranch: 'project-data', …}
EditMenu.tsx:26 EditMenu render: {activeTabId: 'tab-graph-test-project-data-interactive', fileId: 'graph-test-project-data', viewMode: 'interactive', isGraphEditor: true, isFormEditor: false, …}
DataMenu.tsx:469 [DataMenu] RENDER STATE: {selectedEdgeId: null, selectedNodeId: null, hasEdgeSelection: false, hasNodeSelection: false, hasSelection: false, …}
GraphEditor.tsx:158 [GraphEditor graph-test-project-data] RENDER: tabId=tab-graph-test-project-data-interactive, isVisible=true, visibleTabs=[tab-graph-test-project-data-interactive]
GraphEditor.tsx:1257 [2025-11-15T20:12:55.093Z] GraphEditor render: {fileId: 'graph-test-project-data', hasData: true, hasNodes: true, nodeCount: 7, isDirty: true, …}
GraphCanvas.tsx:192 [2025-11-15T20:12:55.095Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.095Z] [GraphCanvas] Render frame #24 start
GraphCanvas.tsx:192 [2025-11-15T20:12:55.116Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.117Z] [GraphCanvas] Render frame #25 start
GraphCanvas.tsx:192 [2025-11-15T20:12:55.156Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.156Z] [GraphCanvas] Render frame #26 start
GraphCanvas.tsx:192 [2025-11-15T20:12:55.373Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.374Z] [GraphCanvas] Render frame #27 start
AppShell.tsx:59 AppShell render - navState: {isOpen: true, isPinned: true, searchQuery: '', selectedRepo: 'dagnet', selectedBranch: 'project-data', …}
EditMenu.tsx:26 EditMenu render: {activeTabId: 'tab-graph-test-project-data-interactive', fileId: 'graph-test-project-data', viewMode: 'interactive', isGraphEditor: true, isFormEditor: false, …}
DataMenu.tsx:469 [DataMenu] RENDER STATE: {selectedEdgeId: null, selectedNodeId: null, hasEdgeSelection: false, hasNodeSelection: false, hasSelection: false, …}
GraphEditor.tsx:158 [GraphEditor graph-test-project-data] RENDER: tabId=tab-graph-test-project-data-interactive, isVisible=true, visibleTabs=[tab-graph-test-project-data-interactive]
GraphEditor.tsx:1257 [2025-11-15T20:12:55.755Z] GraphEditor render: {fileId: 'graph-test-project-data', hasData: true, hasNodes: true, nodeCount: 7, isDirty: true, …}
GraphCanvas.tsx:192 [2025-11-15T20:12:55.759Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.759Z] [GraphCanvas] Render frame #28 start
GraphCanvas.tsx:192 [2025-11-15T20:12:55.793Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.794Z] [GraphCanvas] Render frame #29 start
GraphCanvas.tsx:192 [2025-11-15T20:12:55.797Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.798Z] [GraphCanvas] Render frame #30 start
GraphCanvas.tsx:192 [2025-11-15T20:12:55.949Z] [GraphCanvas] effectiveWhatIfDSL on render: {tabId: 'tab-graph-test-project-data-interactive', propWhatIfDSL: null, tabWhatIfDSL: null, effectiveWhatIfDSL: null, overridesVersion: ''}
GraphCanvas.tsx:206 [2025-11-15T20:12:55.950Z] [GraphCanvas] Render frame #31 start
"""

def analyze():
    print("="*80)
    print("MANUAL CONSOLE-TRACE CORRELATION")
    print("="*80)
    print()
    
    lines = [l.strip() for l in console_logs.strip().split('\n') if l.strip()]
    
    # Parse console timestamps
    events = []
    for line in lines:
        if '[2025-11-15T' in line:
            # Extract timestamp
            ts_str = line.split('[')[1].split(']')[0]
            dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
            ts_ms = dt.timestamp() * 1000
            
            # Extract component and event type
            if 'GraphCanvas' in line and 'Render frame #' in line:
                frame_num = line.split('Render frame #')[1].split()[0]
                events.append({
                    'ts_ms': ts_ms,
                    'component': 'GraphCanvas',
                    'event': f'Frame #{frame_num}'
                })
            elif 'AppShell' in line:
                events.append({
                    'ts_ms': ts_ms,
                    'component': 'AppShell',
                    'event': 'render'
                })
            elif 'GraphEditor' in line and 'RENDER' in line:
                events.append({
                    'ts_ms': ts_ms,
                    'component': 'GraphEditor',
                    'event': 'render'
                })
            elif 'EditMenu' in line:
                events.append({
                    'ts_ms': ts_ms,
                    'component': 'EditMenu',
                    'event': 'render'
                })
            elif 'DataMenu' in line:
                events.append({
                    'ts_ms': ts_ms,
                    'component': 'DataMenu',
                    'event': 'render'
                })
    
    # Sort by time
    events.sort(key=lambda x: x['ts_ms'])
    
    # Calculate time from first event
    base_ts = events[0]['ts_ms']
    
    print(f"Captured {len(events)} render events from console logs")
    print()
    print(f"{'Delta (ms)':<12} {'Component':<15} {'Event':<20}")
    print("-"*50)
    
    for event in events:
        delta_ms = event['ts_ms'] - base_ts
        print(f"{delta_ms:>10.0f}ms {event['component']:<15} {event['event']:<20}")
    
    print()
    
    # Analyze render patterns
    print("="*80)
    print("RENDER PATTERN ANALYSIS")
    print("="*80)
    print()
    
    # Count renders by component
    component_counts = {}
    for event in events:
        comp = event['component']
        component_counts[comp] = component_counts.get(comp, 0) + 1
    
    print("Renders by component:")
    for comp, count in sorted(component_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"  {comp:<20} {count:>3} renders")
    
    print()
    
    # Calculate GraphCanvas render rate
    gc_events = [e for e in events if e['component'] == 'GraphCanvas']
    if len(gc_events) >= 2:
        first = gc_events[0]['ts_ms']
        last = gc_events[-1]['ts_ms']
        span_s = (last - first) / 1000
        rate = len(gc_events) / span_s if span_s > 0 else 0
        
        print(f"GraphCanvas render rate: {rate:.1f} renders/second")
        print(f"  ({len(gc_events)} renders over {span_s:.2f}s)")
        print()
    
    # Find cascades (AppShell → GraphEditor → GraphCanvas)
    print("Cascading render sequences:")
    print()
    
    i = 0
    cascade_num = 1
    while i < len(events):
        # Look for AppShell followed by GraphEditor followed by GraphCanvas
        if events[i]['component'] == 'AppShell':
            cascade = [events[i]]
            j = i + 1
            
            # Look ahead for related renders within 50ms
            while j < len(events) and (events[j]['ts_ms'] - events[i]['ts_ms']) < 50:
                cascade.append(events[j])
                j += 1
            
            if len(cascade) >= 3:
                span_ms = cascade[-1]['ts_ms'] - cascade[0]['ts_ms']
                print(f"Cascade #{cascade_num} (span: {span_ms:.1f}ms):")
                for event in cascade:
                    delta = event['ts_ms'] - cascade[0]['ts_ms']
                    print(f"  +{delta:>5.1f}ms {event['component']:<15} {event['event']}")
                print()
                cascade_num += 1
            
            i = j
        else:
            i += 1

analyze()

