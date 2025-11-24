#!/usr/bin/env python3
"""
Timeline Correlator

Correlates:
- Console log timestamps with trace events
- React renders with GPU work
- User input events with subsequent work
- Identifies cascading render patterns
"""

import json
import sys
from datetime import datetime

def parse_timestamp(ts_str):
    """Parse ISO timestamp to microseconds"""
    try:
        # Format: 2025-11-15T20:12:53.440Z
        dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
        return int(dt.timestamp() * 1_000_000)
    except:
        return None

def analyze_timeline(trace_file, console_logs=None):
    print("="*80)
    print("TIMELINE CORRELATION ANALYSIS")
    print("="*80)
    print()
    
    with open(trace_file, 'r') as f:
        data = json.load(f)
    
    events = data.get('traceEvents', [])
    
    # Find time range
    timestamps = [e['ts'] for e in events if 'ts' in e and e.get('ph') in ['B', 'E', 'X', 'I']]
    if not timestamps:
        print("No timestamps found in trace")
        return
    
    min_ts = min(timestamps)
    max_ts = max(timestamps)
    duration_s = (max_ts - min_ts) / 1_000_000
    
    print(f"Trace duration: {duration_s:.2f}s")
    print(f"Start timestamp: {min_ts}")
    print(f"End timestamp: {max_ts}")
    print()
    
    # Find renderer process
    renderer_pids = set()
    for event in events:
        if event.get('cat', '').startswith('disabled-by-default-devtools.timeline'):
            renderer_pids.add(event.get('pid'))
    
    if not renderer_pids:
        print("No renderer process found")
        return
    
    renderer_pid = list(renderer_pids)[0]
    
    # Extract key event types
    input_events = []
    run_tasks = []
    render_events = []
    commit_events = []
    raster_events = []
    update_layer_events = []
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        name = event.get('name', '')
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        ph = event.get('ph')
        
        if ph not in ['X', 'B', 'E']:
            continue
        
        # Calculate duration for complete events
        if ph == 'X':
            duration_ms = dur / 1000
        else:
            duration_ms = None
        
        # Categorize events
        if 'Input' in name or 'Mouse' in name or 'Wheel' in name or 'Scroll' in name:
            input_events.append({
                'name': name,
                'ts': ts,
                'duration': duration_ms,
                'time_s': (ts - min_ts) / 1_000_000
            })
        elif name == 'RunTask':
            if duration_ms and duration_ms > 5:  # Only significant tasks
                run_tasks.append({
                    'name': name,
                    'ts': ts,
                    'duration': duration_ms,
                    'time_s': (ts - min_ts) / 1_000_000
                })
        elif 'FunctionCall' in name or 'performWork' in name:
            if duration_ms and duration_ms > 1:
                render_events.append({
                    'name': name,
                    'ts': ts,
                    'duration': duration_ms,
                    'time_s': (ts - min_ts) / 1_000_000,
                    'function': event.get('args', {}).get('data', {}).get('functionName', '')
                })
        elif 'Commit' in name or 'commit' in name:
            if duration_ms and duration_ms > 1:
                commit_events.append({
                    'name': name,
                    'ts': ts,
                    'duration': duration_ms,
                    'time_s': (ts - min_ts) / 1_000_000
                })
        elif 'RasterTask' in name:
            if duration_ms:
                raster_events.append({
                    'name': name,
                    'ts': ts,
                    'duration': duration_ms,
                    'time_s': (ts - min_ts) / 1_000_000
                })
        elif 'UpdateLayer' in name:
            if duration_ms:
                update_layer_events.append({
                    'name': name,
                    'ts': ts,
                    'duration': duration_ms,
                    'time_s': (ts - min_ts) / 1_000_000
                })
    
    # Build timeline
    print("="*80)
    print("EVENT TIMELINE (significant events > 5ms)")
    print("="*80)
    print()
    
    # Combine all events
    all_events = []
    all_events.extend([{**e, 'type': 'Input'} for e in input_events])
    all_events.extend([{**e, 'type': 'RunTask'} for e in run_tasks])
    all_events.extend([{**e, 'type': 'Render'} for e in render_events])
    all_events.extend([{**e, 'type': 'Commit'} for e in commit_events])
    all_events.extend([{**e, 'type': 'Raster'} for e in raster_events if e['duration'] > 5])
    all_events.extend([{**e, 'type': 'UpdateLayer'} for e in update_layer_events if e['duration'] > 5])
    
    # Sort by time
    all_events.sort(key=lambda x: x['ts'])
    
    print(f"{'Time (s)':<10} {'Type':<12} {'Duration':<12} {'Name/Details':<60}")
    print("-"*100)
    
    for event in all_events:
        if event['duration'] is not None:
            details = event.get('function', '') or event['name']
            print(f"{event['time_s']:>8.3f}s {event['type']:<12} {event['duration']:>10.2f}ms {details:<60}")
    
    print()
    
    # Identify cascading patterns
    print("="*80)
    print("CASCADING RENDER PATTERNS")
    print("="*80)
    print()
    
    # Group RunTasks by time windows (within 100ms)
    WINDOW_MS = 100
    task_clusters = []
    current_cluster = []
    
    for task in run_tasks:
        if not current_cluster:
            current_cluster = [task]
        else:
            # Check if within window of last task in cluster
            time_diff_ms = (task['ts'] - current_cluster[-1]['ts']) / 1000
            if time_diff_ms <= WINDOW_MS:
                current_cluster.append(task)
            else:
                # Start new cluster
                if len(current_cluster) >= 2:  # Only care about clusters with multiple tasks
                    task_clusters.append(current_cluster)
                current_cluster = [task]
    
    if len(current_cluster) >= 2:
        task_clusters.append(current_cluster)
    
    if task_clusters:
        print(f"Found {len(task_clusters)} cascading render clusters (multiple RunTasks within {WINDOW_MS}ms)")
        print()
        
        for i, cluster in enumerate(task_clusters):
            total_duration = sum(t['duration'] for t in cluster)
            start_time = cluster[0]['time_s']
            end_time = cluster[-1]['time_s']
            span_ms = (end_time - start_time) * 1000
            
            print(f"Cluster {i+1}:")
            print(f"  Time: {start_time:.3f}s - {end_time:.3f}s (span: {span_ms:.1f}ms)")
            print(f"  Tasks: {len(cluster)}")
            print(f"  Total work: {total_duration:.2f}ms")
            print(f"  Avg per task: {total_duration/len(cluster):.2f}ms")
            
            # Find nearby events
            nearby_raster = [r for r in raster_events if abs(r['time_s'] - start_time) < 0.2]
            nearby_update = [u for u in update_layer_events if abs(u['time_s'] - start_time) < 0.2]
            
            if nearby_raster:
                print(f"  Nearby RasterTask: {len(nearby_raster)} calls, {sum(r['duration'] for r in nearby_raster):.2f}ms total")
            if nearby_update:
                print(f"  Nearby UpdateLayer: {len(nearby_update)} calls, {sum(u['duration'] for u in nearby_update):.2f}ms total")
            
            print()
    else:
        print("No significant cascading render patterns detected")
        print()
    
    # Summary statistics
    print("="*80)
    print("SUMMARY STATISTICS")
    print("="*80)
    print()
    
    print(f"Input events: {len(input_events)}")
    print(f"Significant RunTasks (> 5ms): {len(run_tasks)}")
    if run_tasks:
        print(f"  Total: {sum(t['duration'] for t in run_tasks):.2f}ms")
        print(f"  Average: {sum(t['duration'] for t in run_tasks)/len(run_tasks):.2f}ms")
        print(f"  Max: {max(t['duration'] for t in run_tasks):.2f}ms")
    
    print(f"Significant Render events (> 1ms): {len(render_events)}")
    if render_events:
        print(f"  Total: {sum(r['duration'] for r in render_events):.2f}ms")
    
    print(f"Commit events: {len(commit_events)}")
    if commit_events:
        print(f"  Total: {sum(c['duration'] for c in commit_events):.2f}ms")
    
    print(f"RasterTask events: {len(raster_events)}")
    if raster_events:
        print(f"  Total: {sum(r['duration'] for r in raster_events):.2f}ms")
    
    print(f"UpdateLayer events: {len(update_layer_events)}")
    if update_layer_events:
        print(f"  Total: {sum(u['duration'] for u in update_layer_events):.2f}ms")
    
    print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 timeline_correlator.py <trace.json>")
        sys.exit(1)
    
    analyze_timeline(sys.argv[1])

