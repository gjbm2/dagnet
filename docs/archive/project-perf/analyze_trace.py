#!/usr/bin/env python3
"""
Analyze Chrome Performance Trace JSON
Extracts key metrics and bottlenecks for render performance diagnosis
"""

import json
import sys
from collections import defaultdict
from typing import Dict, List, Any

def microseconds_to_ms(us):
    """Convert microseconds to milliseconds"""
    return us / 1000.0

def analyze_trace(trace_file):
    """Parse and analyze Chrome Performance trace"""
    
    print(f"Loading trace file: {trace_file}")
    with open(trace_file, 'r') as f:
        data = json.load(f)
    
    events = data.get('traceEvents', [])
    print(f"Total events: {len(events)}")
    
    # Find the renderer process (where React runs)
    # Usually the process with name "Renderer" or has CrRendererMain thread
    renderer_pids = set()
    for event in events:
        if event.get('name') == 'process_name' and event.get('args', {}).get('name') == 'Renderer':
            renderer_pids.add(event['pid'])
        elif event.get('name') == 'thread_name' and event.get('args', {}).get('name') == 'CrRendererMain':
            renderer_pids.add(event['pid'])
    
    print(f"\nRenderer process IDs: {renderer_pids}")
    
    # Filter to renderer process events only
    renderer_events = [e for e in events if e.get('pid') in renderer_pids]
    print(f"Renderer events: {len(renderer_events)}")
    
    # Analyze different categories
    analyze_long_tasks(renderer_events)
    analyze_function_calls(renderer_events)
    analyze_rendering_work(renderer_events)
    analyze_timeline(renderer_events)
    
def analyze_long_tasks(events):
    """Find tasks that took > 10ms"""
    print("\n" + "="*80)
    print("LONG TASKS (> 10ms)")
    print("="*80)
    
    long_tasks = []
    
    for event in events:
        # Look for duration events (ph: X = complete event)
        if event.get('ph') == 'X' and 'dur' in event:
            duration_ms = microseconds_to_ms(event['dur'])
            if duration_ms > 10:
                long_tasks.append({
                    'name': event.get('name', 'Unknown'),
                    'duration_ms': duration_ms,
                    'ts': event.get('ts', 0),
                    'cat': event.get('cat', ''),
                    'args': event.get('args', {})
                })
    
    # Sort by duration
    long_tasks.sort(key=lambda x: x['duration_ms'], reverse=True)
    
    print(f"\nFound {len(long_tasks)} tasks > 10ms")
    print("\nTop 20 longest tasks:")
    print(f"{'Duration':<12} {'Category':<30} {'Name':<50}")
    print("-" * 92)
    
    for task in long_tasks[:20]:
        print(f"{task['duration_ms']:>10.2f}ms {task['cat']:<30} {task['name']:<50}")
    
    # Group by category
    print("\n\nLong tasks by category:")
    by_category = defaultdict(lambda: {'count': 0, 'total_ms': 0})
    for task in long_tasks:
        cat = task['cat'] or 'uncategorized'
        by_category[cat]['count'] += 1
        by_category[cat]['total_ms'] += task['duration_ms']
    
    for cat, stats in sorted(by_category.items(), key=lambda x: x[1]['total_ms'], reverse=True):
        print(f"  {cat:<40} {stats['count']:>4} tasks, {stats['total_ms']:>8.2f}ms total")

def analyze_function_calls(events):
    """Analyze JavaScript function execution"""
    print("\n" + "="*80)
    print("JAVASCRIPT FUNCTION CALLS")
    print("="*80)
    
    # Look for FunctionCall, EvaluateScript, v8.run events
    js_events = []
    
    for event in events:
        name = event.get('name', '')
        cat = event.get('cat', '')
        
        if any(x in name for x in ['FunctionCall', 'EvaluateScript', 'v8.run', 'V8.Execute']):
            if 'dur' in event:
                duration_ms = microseconds_to_ms(event['dur'])
                if duration_ms > 1:  # Only significant ones
                    js_events.append({
                        'name': name,
                        'duration_ms': duration_ms,
                        'args': event.get('args', {}),
                        'ts': event.get('ts', 0)
                    })
    
    if js_events:
        js_events.sort(key=lambda x: x['duration_ms'], reverse=True)
        print(f"\nFound {len(js_events)} significant JavaScript executions (> 1ms)")
        print("\nTop 20:")
        print(f"{'Duration':<12} {'Event':<50} {'Details':<50}")
        print("-" * 112)
        
        for evt in js_events[:20]:
            details = evt['args'].get('data', {})
            func_name = details.get('functionName', '') or details.get('scriptName', '') or ''
            print(f"{evt['duration_ms']:>10.2f}ms {evt['name']:<50} {func_name[:50]:<50}")
    else:
        print("\nNo significant JavaScript executions found (or not captured in this trace)")

def analyze_rendering_work(events):
    """Analyze rendering, layout, painting"""
    print("\n" + "="*80)
    print("RENDERING WORK (Style, Layout, Paint)")
    print("="*80)
    
    categories = {
        'UpdateLayoutTree': [],
        'Layout': [],
        'Paint': [],
        'CompositeLayers': [],
        'UpdateLayerTree': [],
        'RecalculateStyles': []
    }
    
    for event in events:
        name = event.get('name', '')
        if name in categories and 'dur' in event:
            duration_ms = microseconds_to_ms(event['dur'])
            categories[name].append(duration_ms)
    
    print("\nRendering operations summary:")
    total_rendering = 0
    for name, durations in categories.items():
        if durations:
            total = sum(durations)
            total_rendering += total
            avg = total / len(durations)
            max_dur = max(durations)
            print(f"  {name:<25} {len(durations):>4} calls, {total:>8.2f}ms total, {avg:>6.2f}ms avg, {max_dur:>6.2f}ms max")
    
    print(f"\n  {'TOTAL RENDERING TIME':<25} {total_rendering:>8.2f}ms")
    
    if total_rendering > 20:
        print("\n  ⚠️  WARNING: Significant rendering work during interaction!")
        print("     This suggests DOM changes are triggering layout/paint cycles.")
        print("     Should be minimal for viewport-only pan operations.")

def analyze_timeline(events):
    """Analyze timeline and frame timing"""
    print("\n" + "="*80)
    print("TIMELINE ANALYSIS")
    print("="*80)
    
    # Find min/max timestamps to establish timeline
    timestamps = [e['ts'] for e in events if 'ts' in e and e.get('ph') == 'X']
    if not timestamps:
        print("No timeline data available")
        return
    
    min_ts = min(timestamps)
    max_ts = max(timestamps)
    duration_s = microseconds_to_ms(max_ts - min_ts) / 1000.0
    
    print(f"\nRecording duration: {duration_s:.2f} seconds")
    print(f"Timestamp range: {min_ts} - {max_ts}")
    
    # Bucket events into 100ms windows
    window_size = 100000  # 100ms in microseconds
    windows = defaultdict(lambda: {'count': 0, 'total_ms': 0, 'categories': defaultdict(float)})
    
    for event in events:
        if event.get('ph') == 'X' and 'ts' in event and 'dur' in event:
            window_idx = (event['ts'] - min_ts) // window_size
            duration_ms = microseconds_to_ms(event['dur'])
            cat = event.get('cat', 'unknown')
            
            windows[window_idx]['count'] += 1
            windows[window_idx]['total_ms'] += duration_ms
            windows[window_idx]['categories'][cat] += duration_ms
    
    print(f"\nActivity by 100ms window:")
    print(f"{'Window':<8} {'Time (s)':<12} {'Events':<8} {'Total ms':<12} {'Avg ms/event':<15}")
    print("-" * 65)
    
    for window_idx in sorted(windows.keys())[:50]:  # Show first 50 windows (5 seconds)
        stats = windows[window_idx]
        time_s = (window_idx * window_size + min_ts - min_ts) / 1000000.0
        avg_ms = stats['total_ms'] / stats['count'] if stats['count'] > 0 else 0
        
        marker = "  ⚠️" if stats['total_ms'] > 50 else ""
        print(f"{window_idx:<8} {time_s:<12.3f} {stats['count']:<8} {stats['total_ms']:<12.2f} {avg_ms:<15.2f}{marker}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python analyze_trace.py <trace-file.json>")
        sys.exit(1)
    
    trace_file = sys.argv[1]
    analyze_trace(trace_file)
    
    print("\n" + "="*80)
    print("ANALYSIS COMPLETE")
    print("="*80)
    print("\nKey questions to answer:")
    print("1. How many long tasks (> 10ms)? Should be 0-2 for a simple pan")
    print("2. What's the total rendering time? Should be < 20ms")
    print("3. Which functions dominate the long tasks?")
    print("4. Is there rendering work (Layout/Paint) during pan? Should be minimal")
    print("\nNext steps:")
    print("- Identify the top 3 bottleneck functions")
    print("- Check if rendering work is happening (shouldn't be for pan)")
    print("- Correlate with React Profiler data to see which components triggered the work")

if __name__ == '__main__':
    main()

