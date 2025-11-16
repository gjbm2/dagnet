#!/usr/bin/env python3
"""
Frame-by-Frame Analysis

Identifies:
- What's running on EVERY frame
- Continuous work loops
- Animation frame callbacks
- requestAnimationFrame patterns
- ResizeObserver/IntersectionObserver work
"""

import json
import sys
from collections import defaultdict

def analyze_frame_patterns(trace_file):
    print("="*80)
    print("FRAME-BY-FRAME WORK ANALYSIS")
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
    
    # Extract all RunTask and FunctionCall events
    run_tasks = []
    function_calls = []
    raf_callbacks = []
    observer_callbacks = []
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        name = event.get('name', '')
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        ph = event.get('ph')
        args = event.get('args', {})
        
        if ph != 'X':  # Only complete events
            continue
        
        duration_ms = dur / 1000
        
        if duration_ms == 0:
            continue
        
        if name == 'RunTask':
            run_tasks.append({
                'ts': ts,
                'duration': duration_ms,
                'args': args
            })
        elif name == 'FunctionCall':
            fn_name = args.get('data', {}).get('functionName', '')
            script_url = args.get('data', {}).get('scriptName', '')
            
            function_calls.append({
                'ts': ts,
                'duration': duration_ms,
                'function': fn_name,
                'script': script_url
            })
            
            # Identify RAF callbacks
            if 'requestAnimationFrame' in fn_name or 'RAF' in fn_name:
                raf_callbacks.append({
                    'ts': ts,
                    'duration': duration_ms,
                    'function': fn_name
                })
            
            # Identify Observer callbacks
            if 'Observer' in fn_name or 'observe' in fn_name.lower():
                observer_callbacks.append({
                    'ts': ts,
                    'duration': duration_ms,
                    'function': fn_name
                })
    
    if not run_tasks:
        print("No RunTask events found")
        return
    
    # Sort by timestamp
    run_tasks.sort(key=lambda x: x['ts'])
    
    # Calculate intervals between tasks
    intervals = []
    for i in range(1, len(run_tasks)):
        interval_us = run_tasks[i]['ts'] - run_tasks[i-1]['ts']
        interval_ms = interval_us / 1000
        intervals.append(interval_ms)
    
    # Identify patterns
    print("="*80)
    print("RUNTASK PATTERN ANALYSIS")
    print("="*80)
    print()
    
    print(f"Total RunTask events: {len(run_tasks)}")
    total_duration = sum(t['duration'] for t in run_tasks)
    print(f"Total cumulative time: {total_duration:.2f}ms")
    print(f"Average duration: {total_duration/len(run_tasks):.2f}ms")
    print()
    
    if intervals:
        avg_interval = sum(intervals) / len(intervals)
        min_interval = min(intervals)
        max_interval = max(intervals)
        
        print("Interval statistics (time BETWEEN tasks):")
        print(f"  Average: {avg_interval:.2f}ms")
        print(f"  Min: {min_interval:.2f}ms")
        print(f"  Max: {max_interval:.2f}ms")
        print()
        
        # Check if intervals cluster around frame boundaries
        frame_60hz = 16.67  # 60fps
        frame_30hz = 33.33  # 30fps
        
        # Count intervals near frame boundaries
        near_60hz = sum(1 for i in intervals if abs(i - frame_60hz) < 2)
        near_30hz = sum(1 for i in intervals if abs(i - frame_30hz) < 2)
        
        print(f"Intervals near 60Hz (16.67ms ±2ms): {near_60hz} ({near_60hz/len(intervals)*100:.1f}%)")
        print(f"Intervals near 30Hz (33.33ms ±2ms): {near_30hz} ({near_30hz/len(intervals)*100:.1f}%)")
        print()
        
        if near_60hz / len(intervals) > 0.7:
            print("🚨 CRITICAL FINDING: RunTasks are occurring at 60Hz (every frame)")
            print("   This indicates a continuous render/work loop")
            print("   Possible causes:")
            print("   - Continuous state updates triggering renders")
            print("   - requestAnimationFrame loop that never stops")
            print("   - ResizeObserver or IntersectionObserver firing continuously")
            print("   - React effect loop")
            print()
        
        # Look for repeated patterns in durations
        duration_buckets = defaultdict(int)
        for task in run_tasks:
            # Round to nearest 0.5ms
            bucket = round(task['duration'] * 2) / 2
            duration_buckets[bucket] += 1
        
        print("Duration distribution (most common):")
        sorted_buckets = sorted(duration_buckets.items(), key=lambda x: x[1], reverse=True)
        for duration, count in sorted_buckets[:10]:
            pct = count / len(run_tasks) * 100
            print(f"  {duration:>6.1f}ms: {count:>4} tasks ({pct:>5.1f}%)")
        print()
    
    # Analyze function call patterns
    print("="*80)
    print("FUNCTION CALL ANALYSIS")
    print("="*80)
    print()
    
    if function_calls:
        # Group by function name
        function_stats = defaultdict(lambda: {'count': 0, 'total_time': 0, 'timestamps': []})
        
        for call in function_calls:
            fn = call['function'] or 'anonymous'
            function_stats[fn]['count'] += 1
            function_stats[fn]['total_time'] += call['duration']
            function_stats[fn]['timestamps'].append(call['ts'])
        
        # Sort by count
        sorted_by_count = sorted(function_stats.items(), key=lambda x: x[1]['count'], reverse=True)
        
        print("Most frequently called functions:")
        print(f"{'Function':<50} {'Count':<10} {'Total ms':<12} {'Avg ms':<12}")
        print("-"*90)
        
        for fn, stats in sorted_by_count[:20]:
            avg = stats['total_time'] / stats['count']
            print(f"{fn:<50} {stats['count']:<10} {stats['total_time']:>10.2f}ms {avg:>10.2f}ms")
        
        print()
        
        # Check for periodic patterns
        print("Checking for periodic function call patterns...")
        print()
        
        for fn, stats in sorted_by_count[:10]:
            if stats['count'] < 10:
                continue
            
            # Calculate intervals
            timestamps = sorted(stats['timestamps'])
            intervals = []
            for i in range(1, len(timestamps)):
                interval_ms = (timestamps[i] - timestamps[i-1]) / 1000
                intervals.append(interval_ms)
            
            if intervals:
                avg_interval = sum(intervals) / len(intervals)
                min_interval = min(intervals)
                max_interval = max(intervals)
                
                # Check if periodic (most intervals within 20% of average)
                tolerance = avg_interval * 0.2
                periodic_count = sum(1 for i in intervals if abs(i - avg_interval) < tolerance)
                periodicity = periodic_count / len(intervals)
                
                if periodicity > 0.6:  # 60% of intervals are regular
                    print(f"  {fn}:")
                    print(f"    Calls: {stats['count']}")
                    print(f"    Average interval: {avg_interval:.2f}ms (periodicity: {periodicity*100:.1f}%)")
                    
                    # Check if it's frame-rate aligned
                    if abs(avg_interval - 16.67) < 2:
                        print(f"    🚨 PERIODIC AT 60Hz (every frame)")
                    elif abs(avg_interval - 33.33) < 3:
                        print(f"    ⚠️  PERIODIC AT 30Hz (every 2 frames)")
                    print()
    else:
        print("No function calls found (trace may not have JS profiling enabled)")
        print()
    
    # RAF callbacks
    if raf_callbacks:
        print("="*80)
        print("requestAnimationFrame CALLBACKS")
        print("="*80)
        print()
        
        print(f"Found {len(raf_callbacks)} RAF callbacks")
        print(f"Total time: {sum(c['duration'] for c in raf_callbacks):.2f}ms")
        print()
        
        # Check if they're continuous
        sorted_raf = sorted(raf_callbacks, key=lambda x: x['ts'])
        if len(sorted_raf) > 10:
            first_ts = sorted_raf[0]['ts']
            last_ts = sorted_raf[-1]['ts']
            span_s = (last_ts - first_ts) / 1_000_000
            print(f"RAF callbacks span: {span_s:.2f}s")
            print(f"Average rate: {len(sorted_raf) / span_s:.1f} calls/second")
            
            if len(sorted_raf) / span_s > 50:
                print("🚨 CRITICAL: RAF callbacks running at > 50Hz continuously")
                print("   This indicates an animation or work loop that never stops")
            print()
    
    # Observer callbacks
    if observer_callbacks:
        print("="*80)
        print("OBSERVER CALLBACKS")
        print("="*80)
        print()
        
        print(f"Found {len(observer_callbacks)} observer callbacks")
        print(f"Total time: {sum(c['duration'] for c in observer_callbacks):.2f}ms")
        print()
        
        for obs in observer_callbacks[:20]:
            time_s = (obs['ts'] - run_tasks[0]['ts']) / 1_000_000
            print(f"  {time_s:>8.3f}s {obs['duration']:>10.2f}ms {obs['function']}")
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 frame_by_frame_analysis.py <trace.json>")
        sys.exit(1)
    
    analyze_frame_patterns(sys.argv[1])

