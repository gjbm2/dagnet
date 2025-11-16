#!/usr/bin/env python3
"""
ReactFlow Events Analyzer

Specifically looks for ReactFlow-related events:
- Mouse/wheel input
- Pan/zoom handlers
- Node/edge updates
- Store updates
"""

import json
import sys
from collections import defaultdict

def analyze_reactflow(trace_file):
    print("="*80)
    print("REACTFLOW EVENTS ANALYSIS")
    print("="*80)
    print()
    
    with open(trace_file, 'r') as f:
        data = json.load(f)
    
    events = data.get('traceEvents', [])
    
    # Find renderer process
    renderer_pids = set()
    for event in events:
        if event.get('cat', '').startswith('disabled-by-default-devtools.timeline'):
            renderer_pids.add(event.get('pid'))
    
    if not renderer_pids:
        print("No renderer process found")
        return
    
    renderer_pid = list(renderer_pids)[0]
    
    # Track input events
    input_events = []
    mouse_events = []
    wheel_events = []
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        name = event.get('name', '')
        cat = event.get('cat', '')
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        args = event.get('args', {})
        
        if 'input' in cat.lower() or 'Input' in name:
            input_events.append({
                'name': name,
                'ts': ts,
                'duration': dur / 1000 if dur else 0,
                'type': args.get('type', '')
            })
        
        if 'Mouse' in name or 'mouse' in name.lower():
            mouse_events.append({
                'name': name,
                'ts': ts,
                'duration': dur / 1000 if dur else 0,
                'args': args
            })
        
        if 'Wheel' in name or 'wheel' in name.lower() or 'Scroll' in name:
            wheel_events.append({
                'name': name,
                'ts': ts,
                'duration': dur / 1000 if dur else 0,
                'args': args
            })
    
    # Analyze input patterns
    print("="*80)
    print("INPUT EVENT PATTERNS")
    print("="*80)
    print()
    
    print(f"Total input events: {len(input_events)}")
    print(f"Mouse events: {len(mouse_events)}")
    print(f"Wheel/scroll events: {len(wheel_events)}")
    print()
    
    if wheel_events:
        wheel_events.sort(key=lambda x: x['ts'])
        min_ts = wheel_events[0]['ts']
        max_ts = wheel_events[-1]['ts']
        span_s = (max_ts - min_ts) / 1_000_000
        
        print(f"Wheel event span: {span_s:.2f}s")
        print(f"Wheel event rate: {len(wheel_events) / span_s:.1f} events/second")
        print()
        
        # Calculate intervals
        intervals = []
        for i in range(1, len(wheel_events)):
            interval_ms = (wheel_events[i]['ts'] - wheel_events[i-1]['ts']) / 1000
            intervals.append(interval_ms)
        
        if intervals:
            avg_interval = sum(intervals) / len(intervals)
            print(f"Average interval between wheel events: {avg_interval:.2f}ms")
            print()
    
    if mouse_events:
        mouse_events.sort(key=lambda x: x['ts'])
        
        # Group by event name
        mouse_by_type = defaultdict(int)
        for event in mouse_events:
            mouse_by_type[event['name']] += 1
        
        print("Mouse events by type:")
        for event_type, count in sorted(mouse_by_type.items(), key=lambda x: x[1], reverse=True):
            print(f"  {event_type}: {count}")
        print()
    
    # Look for FunctionCall events from reactflow.js
    print("="*80)
    print("REACTFLOW SCRIPT ACTIVITY")
    print("="*80)
    print()
    
    reactflow_calls = []
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        if event.get('name') == 'FunctionCall':
            args = event.get('args', {})
            data = args.get('data', {})
            script = data.get('scriptName', '') or data.get('url', '')
            
            if 'reactflow' in script.lower():
                reactflow_calls.append({
                    'ts': event.get('ts', 0),
                    'duration': event.get('dur', 0) / 1000,
                    'function': data.get('functionName', ''),
                    'script': script
                })
    
    if reactflow_calls:
        print(f"Found {len(reactflow_calls)} ReactFlow function calls")
        
        # Group by function
        by_function = defaultdict(list)
        for call in reactflow_calls:
            by_function[call['function']].append(call)
        
        print()
        print(f"{'Function':<40} {'Count':<10} {'Total ms':<12}")
        print("-"*70)
        for fn, calls in sorted(by_function.items(), key=lambda x: len(x[1]), reverse=True):
            total = sum(c['duration'] for c in calls)
            print(f"{fn:<40} {len(calls):<10} {total:>10.2f}ms")
        print()
    else:
        print("No ReactFlow function calls found")
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 reactflow_events_analyzer.py <trace.json>")
        sys.exit(1)
    
    analyze_reactflow(sys.argv[1])

