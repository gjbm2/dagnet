#!/usr/bin/env python3
"""
Deep Analysis of Chrome Performance Trace
Extracts call stacks, React components, and detailed bottleneck information
"""

import json
import sys
from collections import defaultdict
from typing import Dict, List, Any, Tuple

def microseconds_to_ms(us):
    """Convert microseconds to milliseconds"""
    return us / 1000.0

def extract_call_stack(event, all_events, depth=0, max_depth=10):
    """Recursively extract call stack from nested events"""
    stack = []
    
    if depth > max_depth:
        return stack
    
    name = event.get('name', '')
    dur = event.get('dur', 0)
    args = event.get('args', {})
    
    # Extract function/script info
    data = args.get('data', {})
    func_name = data.get('functionName', '')
    script_name = data.get('scriptName', '')
    url = data.get('url', '')
    
    entry = {
        'name': name,
        'duration_ms': microseconds_to_ms(dur),
        'function': func_name,
        'script': script_name,
        'url': url,
        'depth': depth
    }
    
    stack.append(entry)
    
    # For very long tasks, look for nested events
    # Chrome trace nests child events inside parent events
    # But the JSON format flattens them, so we need to find events that overlap in time
    if dur > 10000:  # > 10ms, worth drilling into
        ts = event.get('ts', 0)
        end_ts = ts + dur
        
        # Find child events (same thread, overlapping time range)
        children = []
        for other in all_events:
            if other.get('ph') != 'X':
                continue
            if other.get('pid') != event.get('pid'):
                continue
            if other.get('tid') != event.get('tid'):
                continue
            if other is event:
                continue
            
            other_ts = other.get('ts', 0)
            other_dur = other.get('dur', 0)
            other_end = other_ts + other_dur
            
            # Child if it starts after parent and ends before parent
            if other_ts >= ts and other_end <= end_ts:
                # Additional filter: significant children only
                if other_dur > 1000:  # > 1ms
                    children.append((other, other_ts))
        
        # Sort children by start time
        children.sort(key=lambda x: x[1])
        
        # Recursively extract their stacks (limited to top 10 children)
        for child, _ in children[:10]:
            child_stack = extract_call_stack(child, all_events, depth + 1, max_depth)
            stack.extend(child_stack)
    
    return stack

def analyze_react_components(events):
    """Find React component render information"""
    print("\n" + "="*80)
    print("REACT COMPONENT ANALYSIS")
    print("="*80)
    
    # Look for React-specific events
    react_events = []
    
    for event in events:
        name = event.get('name', '')
        args = event.get('args', {})
        data = args.get('data', {})
        
        # React component renders often show as FunctionCall with component names
        func_name = data.get('functionName', '')
        script_name = data.get('scriptName', '')
        
        # Look for React patterns
        if any(pattern in func_name for pattern in [
            'GraphCanvas', 'ConversionEdge', 'EdgeBeads', 'buildScenario',
            'GraphEditor', 'AppShell', 'renderWithHooks', 'beginWork'
        ]):
            if 'dur' in event:
                duration_ms = microseconds_to_ms(event['dur'])
                if duration_ms > 0.5:  # Significant time
                    react_events.append({
                        'function': func_name,
                        'script': script_name,
                        'duration_ms': duration_ms,
                        'ts': event.get('ts', 0)
                    })
        
        # Also check script names
        if any(pattern in script_name for pattern in [
            'GraphCanvas', 'ConversionEdge', 'EdgeBeads', 'buildScenario',
            'GraphEditor', 'AppShell'
        ]):
            if 'dur' in event:
                duration_ms = microseconds_to_ms(event['dur'])
                if duration_ms > 0.5:
                    react_events.append({
                        'function': func_name or name,
                        'script': script_name,
                        'duration_ms': duration_ms,
                        'ts': event.get('ts', 0)
                    })
    
    if react_events:
        # Group by function/script
        by_function = defaultdict(lambda: {'count': 0, 'total_ms': 0, 'max_ms': 0})
        
        for evt in react_events:
            key = evt['function'] or evt['script'] or 'unknown'
            by_function[key]['count'] += 1
            by_function[key]['total_ms'] += evt['duration_ms']
            by_function[key]['max_ms'] = max(by_function[key]['max_ms'], evt['duration_ms'])
        
        print(f"\nFound {len(react_events)} React-related function calls")
        print("\nReact functions by total time:")
        print(f"{'Function/Component':<60} {'Count':<8} {'Total ms':<12} {'Avg ms':<12} {'Max ms':<12}")
        print("-" * 104)
        
        for func, stats in sorted(by_function.items(), key=lambda x: x[1]['total_ms'], reverse=True)[:20]:
            avg = stats['total_ms'] / stats['count']
            print(f"{func[:60]:<60} {stats['count']:<8} {stats['total_ms']:<12.2f} {avg:<12.2f} {stats['max_ms']:<12.2f}")
    else:
        print("\nNo React-specific function names found in trace")
        print("This is normal for minified/production builds")
        print("Enable 'JavaScript Profiler' in Performance settings for detailed stacks")

def find_longest_task_details(events):
    """Deep dive into the longest task"""
    print("\n" + "="*80)
    print("LONGEST TASK DEEP DIVE")
    print("="*80)
    
    # Find the absolute longest task
    longest = None
    max_dur = 0
    
    for event in events:
        if event.get('ph') == 'X' and 'dur' in event:
            dur = event['dur']
            if dur > max_dur:
                max_dur = dur
                longest = event
    
    if not longest:
        print("No long tasks found")
        return
    
    duration_ms = microseconds_to_ms(max_dur)
    print(f"\nLongest task: {duration_ms:.2f}ms")
    print(f"Name: {longest.get('name', 'Unknown')}")
    print(f"Category: {longest.get('cat', 'Unknown')}")
    print(f"Timestamp: {longest.get('ts', 0)}")
    
    args = longest.get('args', {})
    data = args.get('data', {})
    
    print(f"\nTask details:")
    for key, value in data.items():
        if isinstance(value, str) and len(value) < 200:
            print(f"  {key}: {value}")
        elif isinstance(value, (int, float, bool)):
            print(f"  {key}: {value}")
    
    # Extract call stack
    print(f"\nExtracting call stack from {duration_ms:.2f}ms task...")
    stack = extract_call_stack(longest, events, 0, 15)
    
    print(f"\nCall stack ({len(stack)} entries):")
    print(f"{'Depth':<6} {'Duration':<12} {'Name':<40} {'Function/Script':<50}")
    print("-" * 108)
    
    for entry in stack[:30]:  # Show top 30
        indent = "  " * entry['depth']
        func_info = entry['function'] or entry['script'] or entry['url'] or ''
        print(f"{entry['depth']:<6} {entry['duration_ms']:>10.2f}ms {indent}{entry['name']:<40} {func_info[:50]:<50}")

def analyze_function_call_patterns(events):
    """Analyze patterns in function calls - repeated calls, accumulation"""
    print("\n" + "="*80)
    print("FUNCTION CALL PATTERNS (Repeated Calls)")
    print("="*80)
    
    # Track all function calls with timing
    function_calls = defaultdict(lambda: {'calls': [], 'total_ms': 0, 'count': 0})
    
    for event in events:
        if event.get('name') == 'FunctionCall' and 'dur' in event:
            args = event.get('args', {})
            data = args.get('data', {})
            func_name = data.get('functionName', 'anonymous')
            script_name = data.get('scriptName', '')
            
            # Create a key that identifies the function
            key = f"{func_name} [{script_name.split('/')[-1] if script_name else 'unknown'}]"
            
            duration_ms = microseconds_to_ms(event['dur'])
            
            function_calls[key]['calls'].append({
                'duration_ms': duration_ms,
                'ts': event.get('ts', 0)
            })
            function_calls[key]['total_ms'] += duration_ms
            function_calls[key]['count'] += 1
    
    # Find functions called many times
    print("\nFunctions called most frequently:")
    print(f"{'Function':<70} {'Count':<8} {'Total ms':<12} {'Avg ms':<12}")
    print("-" * 102)
    
    by_count = sorted(function_calls.items(), key=lambda x: x[1]['count'], reverse=True)
    for func, stats in by_count[:20]:
        avg = stats['total_ms'] / stats['count'] if stats['count'] > 0 else 0
        if stats['count'] > 5:  # Only show if called multiple times
            print(f"{func[:70]:<70} {stats['count']:<8} {stats['total_ms']:<12.2f} {avg:<12.2f}")
    
    # Find functions with highest cumulative time
    print("\n\nFunctions by cumulative time (top time consumers):")
    print(f"{'Function':<70} {'Count':<8} {'Total ms':<12} {'Avg ms':<12}")
    print("-" * 102)
    
    by_total = sorted(function_calls.items(), key=lambda x: x[1]['total_ms'], reverse=True)
    for func, stats in by_total[:20]:
        avg = stats['total_ms'] / stats['count'] if stats['count'] > 0 else 0
        if stats['total_ms'] > 1:  # Only show if significant time
            print(f"{func[:70]:<70} {stats['count']:<8} {stats['total_ms']:<12.2f} {avg:<12.2f}")

def find_event_clusters(events, window_ms=100):
    """Find clusters of activity (bursts of work)"""
    print("\n" + "="*80)
    print(f"ACTIVITY CLUSTERS (bursts within {window_ms}ms windows)")
    print("="*80)
    
    # Get all events with timestamps
    timed_events = [(e.get('ts', 0), microseconds_to_ms(e.get('dur', 0)), e.get('name', '')) 
                    for e in events if 'ts' in e and 'dur' in e and e.get('ph') == 'X']
    
    timed_events.sort(key=lambda x: x[0])  # Sort by timestamp
    
    if not timed_events:
        print("No timed events found")
        return
    
    # Find clusters: periods where many events happen in quick succession
    clusters = []
    current_cluster = []
    window_us = window_ms * 1000  # Convert to microseconds
    
    for ts, dur_ms, name in timed_events:
        if not current_cluster:
            current_cluster = [(ts, dur_ms, name)]
        else:
            # Check if this event is within window of cluster start
            cluster_start = current_cluster[0][0]
            if ts - cluster_start < window_us:
                current_cluster.append((ts, dur_ms, name))
            else:
                # Cluster ended, save if significant
                if len(current_cluster) > 10 or sum(e[1] for e in current_cluster) > 10:
                    clusters.append(current_cluster)
                current_cluster = [(ts, dur_ms, name)]
    
    # Don't forget last cluster
    if current_cluster and (len(current_cluster) > 10 or sum(e[1] for e in current_cluster) > 10):
        clusters.append(current_cluster)
    
    print(f"\nFound {len(clusters)} activity clusters")
    print("\nTop 10 clusters by total work:")
    print(f"{'Cluster':<10} {'Time (s)':<12} {'Events':<8} {'Total ms':<12} {'Avg ms':<12} {'Top Events':<50}")
    print("-" * 104)
    
    # Analyze each cluster
    cluster_analysis = []
    min_ts = min(e[0] for e in timed_events)
    
    for i, cluster in enumerate(clusters):
        cluster_start = cluster[0][0]
        cluster_end = cluster[-1][0]
        total_ms = sum(e[1] for e in cluster)
        time_s = microseconds_to_ms(cluster_start - min_ts) / 1000.0
        
        # Find most common event names in cluster
        event_names = defaultdict(int)
        for _, _, name in cluster:
            event_names[name] += 1
        
        top_events = sorted(event_names.items(), key=lambda x: x[1], reverse=True)[:3]
        top_events_str = ', '.join(f"{name}({count})" for name, count in top_events)
        
        cluster_analysis.append({
            'index': i,
            'time_s': time_s,
            'count': len(cluster),
            'total_ms': total_ms,
            'avg_ms': total_ms / len(cluster),
            'top_events': top_events_str
        })
    
    # Sort by total work
    cluster_analysis.sort(key=lambda x: x['total_ms'], reverse=True)
    
    for c in cluster_analysis[:10]:
        print(f"{c['index']:<10} {c['time_s']:<12.3f} {c['count']:<8} {c['total_ms']:<12.2f} {c['avg_ms']:<12.3f} {c['top_events'][:50]:<50}")

def extract_script_execution_details(events):
    """Extract details about script execution (what JS files ran)"""
    print("\n" + "="*80)
    print("SCRIPT EXECUTION BREAKDOWN")
    print("="*80)
    
    # Track execution by script
    by_script = defaultdict(lambda: {'count': 0, 'total_ms': 0, 'functions': defaultdict(float)})
    
    for event in events:
        if event.get('name') in ['FunctionCall', 'EvaluateScript', 'v8.run']:
            args = event.get('args', {})
            data = args.get('data', {})
            
            script_name = data.get('scriptName', '') or data.get('url', '')
            func_name = data.get('functionName', 'anonymous')
            
            if not script_name:
                script_name = 'unknown'
            
            # Simplify script name (just filename)
            if '/' in script_name:
                script_name = script_name.split('/')[-1]
            
            if script_name.startswith('http'):
                continue  # Skip external scripts
            
            if 'dur' in event:
                duration_ms = microseconds_to_ms(event['dur'])
                
                by_script[script_name]['count'] += 1
                by_script[script_name]['total_ms'] += duration_ms
                by_script[script_name]['functions'][func_name] += duration_ms
    
    print("\nJavaScript execution by script file:")
    print(f"{'Script File':<50} {'Calls':<8} {'Total ms':<12} {'Avg ms':<12}")
    print("-" * 82)
    
    for script, stats in sorted(by_script.items(), key=lambda x: x[1]['total_ms'], reverse=True)[:20]:
        avg = stats['total_ms'] / stats['count'] if stats['count'] > 0 else 0
        print(f"{script[:50]:<50} {stats['count']:<8} {stats['total_ms']:<12.2f} {avg:<12.2f}")
        
        # Show top 3 functions in this script
        top_funcs = sorted(stats['functions'].items(), key=lambda x: x[1], reverse=True)[:3]
        for func, dur in top_funcs:
            if func:
                print(f"    └─ {func[:60]}: {dur:.2f}ms")

def correlate_with_console_logs(events, console_log_file=None):
    """Correlate trace timeline with console logs"""
    print("\n" + "="*80)
    print("CORRELATION WITH CONSOLE LOGS")
    print("="*80)
    
    if not console_log_file:
        print("\nNo console log file provided (use --console-log <file>)")
        return
    
    try:
        with open(console_log_file, 'r') as f:
            console_lines = f.readlines()
        
        print(f"\nLoaded {len(console_lines)} console log lines")
        
        # Extract timestamps from console logs
        # Format: GraphCanvas.tsx:206 [2025-11-15T13:38:30.651Z] [GraphCanvas] Render frame #31 start
        import re
        from datetime import datetime
        
        console_events = []
        for line in console_lines:
            # Extract timestamp
            match = re.search(r'\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]', line)
            if match:
                ts_str = match.group(1)
                # Extract frame number if present
                frame_match = re.search(r'Render frame #(\d+)', line)
                frame_num = int(frame_match.group(1)) if frame_match else None
                
                console_events.append({
                    'timestamp': ts_str,
                    'frame': frame_num,
                    'line': line.strip()
                })
        
        print(f"Extracted {len(console_events)} timestamped console events")
        
        # Find render frames and their timings
        render_frames = [e for e in console_events if 'Render frame #' in e['line']]
        print(f"\nFound {len(render_frames)} render frame logs")
        
        if render_frames:
            print("\nRender frames timeline:")
            for evt in render_frames[:20]:
                render_part = evt['line'][evt['line'].find('Render'):]
                print(f"  {evt['timestamp']}: {render_part}")
        
    except FileNotFoundError:
        print(f"\nConsole log file not found: {console_log_file}")

def summarize_findings(events):
    """Generate executive summary of findings"""
    print("\n" + "="*80)
    print("EXECUTIVE SUMMARY")
    print("="*80)
    
    # Count long tasks
    long_tasks_10ms = len([e for e in events if e.get('ph') == 'X' and 'dur' in e and e['dur'] > 10000])
    long_tasks_50ms = len([e for e in events if e.get('ph') == 'X' and 'dur' in e and e['dur'] > 50000])
    long_tasks_100ms = len([e for e in events if e.get('ph') == 'X' and 'dur' in e and e['dur'] > 100000])
    
    # Find timestamps
    timed = [e for e in events if 'ts' in e and 'dur' in e and e.get('ph') == 'X']
    if timed:
        min_ts = min(e['ts'] for e in timed)
        max_ts = max(e['ts'] + e['dur'] for e in timed)
        duration_s = microseconds_to_ms(max_ts - min_ts) / 1000.0
    else:
        duration_s = 0
    
    # Total JS time
    total_js = sum(microseconds_to_ms(e['dur']) for e in events 
                   if e.get('name') in ['FunctionCall', 'EvaluateScript', 'v8.run', 'V8.Execute'] 
                   and 'dur' in e)
    
    # Rendering time
    total_rendering = sum(microseconds_to_ms(e['dur']) for e in events 
                         if e.get('name') in ['Layout', 'Paint', 'UpdateLayoutTree', 'CompositeLayers']
                         and 'dur' in e)
    
    print(f"\n📊 Key Metrics:")
    print(f"  Recording duration: {duration_s:.2f} seconds")
    print(f"  Long tasks > 10ms: {long_tasks_10ms} (expected: 0-2 for simple pan)")
    print(f"  Long tasks > 50ms: {long_tasks_50ms} (CRITICAL - guaranteed dropped frames)")
    print(f"  Long tasks > 100ms: {long_tasks_100ms} (CATASTROPHIC - multi-frame freeze)")
    print(f"  Total JavaScript time: {total_js:.2f}ms (expected: < 20ms for pan)")
    print(f"  Total rendering time: {total_rendering:.2f}ms (expected: < 20ms)")
    
    print(f"\n🎯 Diagnosis:")
    
    if long_tasks_100ms > 0:
        print(f"  ❌ CRITICAL: {long_tasks_100ms} tasks took > 100ms each")
        print(f"     This causes multi-frame freezes and visible jank")
        print(f"     Root cause: Synchronous JavaScript blocking the main thread")
    
    if long_tasks_50ms > 5:
        print(f"  ❌ CRITICAL: {long_tasks_50ms} tasks took > 50ms")
        print(f"     Each one drops 3+ frames (60fps = 16ms per frame)")
    
    if total_js > 100:
        print(f"  ⚠️  WARNING: Total JavaScript time is {total_js:.0f}ms")
        print(f"     For a simple pan, this should be < 20ms")
        print(f"     Indicates unnecessary computation during interaction")
    
    if total_rendering > 50:
        print(f"  ⚠️  WARNING: Significant rendering work ({total_rendering:.0f}ms)")
        print(f"     May indicate layout thrashing or forced reflows")
    else:
        print(f"  ✅ GOOD: Rendering work is minimal ({total_rendering:.0f}ms)")
        print(f"     Problem is pure JavaScript, not DOM/layout")
    
    print(f"\n💡 Likely Root Causes:")
    print(f"  1. React re-renders triggered by pan event")
    print(f"  2. Expensive memos (renderEdges, highlightMetadata) recomputing")
    print(f"  3. Dependency instability causing cascading updates")
    print(f"  4. Effect loops or synchronous state updates")
    
    print(f"\n🔧 Recommended Actions:")
    print(f"  1. Identify which dependency is changing during pan")
    print(f"  2. Add dependency change tracking to renderEdges useMemo")
    print(f"  3. Ensure graph/scenariosContext don't change identity during pan")
    print(f"  4. Consider debouncing/throttling pan event handlers")

def main():
    if len(sys.argv) < 2:
        print("Usage: python deep_analyze_trace.py <trace-file.json> [--console-log <log-file>]")
        sys.exit(1)
    
    trace_file = sys.argv[1]
    console_log_file = None
    
    if '--console-log' in sys.argv:
        idx = sys.argv.index('--console-log')
        if idx + 1 < len(sys.argv):
            console_log_file = sys.argv[idx + 1]
    
    print("="*80)
    print("DEEP CHROME PERFORMANCE TRACE ANALYSIS")
    print("="*80)
    
    with open(trace_file, 'r') as f:
        data = json.load(f)
    
    events = data.get('traceEvents', [])
    
    # Find renderer process
    renderer_pids = set()
    for event in events:
        if event.get('name') == 'process_name' and event.get('args', {}).get('name') == 'Renderer':
            renderer_pids.add(event['pid'])
        elif event.get('name') == 'thread_name' and event.get('args', {}).get('name') == 'CrRendererMain':
            renderer_pids.add(event['pid'])
    
    renderer_events = [e for e in events if e.get('pid') in renderer_pids]
    
    # Run all analyses
    find_longest_task_details(renderer_events)
    analyze_function_call_patterns(renderer_events)
    analyze_react_components(renderer_events)
    extract_script_execution_details(renderer_events)
    find_event_clusters(renderer_events, window_ms=50)
    
    if console_log_file:
        correlate_with_console_logs(renderer_events, console_log_file)
    
    summarize_findings(renderer_events)
    
    print("\n" + "="*80)

if __name__ == '__main__':
    main()

