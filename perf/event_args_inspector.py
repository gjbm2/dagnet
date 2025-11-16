#!/usr/bin/env python3
"""
Event Args Inspector

Extracts actual data from event args to see what's triggering the work.
Looks at:
- FunctionCall args (function names, script names)
- RunTask args
- Timer args
- Any custom data fields
"""

import json
import sys
from collections import defaultdict

def inspect_event_args(trace_file):
    print("="*80)
    print("EVENT ARGS DEEP INSPECTION")
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
    
    # Collect events with meaningful args
    function_calls = []
    run_tasks_with_data = []
    timer_events = []
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        name = event.get('name', '')
        args = event.get('args', {})
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        ph = event.get('ph')
        
        if ph != 'X':
            continue
        
        duration_ms = dur / 1000
        
        if name == 'FunctionCall' and duration_ms > 0.1:
            data = args.get('data', {})
            function_calls.append({
                'ts': ts,
                'duration': duration_ms,
                'functionName': data.get('functionName', ''),
                'scriptName': data.get('scriptName', ''),
                'scriptId': data.get('scriptId', ''),
                'url': data.get('url', '')
            })
        
        elif name == 'RunTask':
            # Check if has meaningful data
            if args:
                run_tasks_with_data.append({
                    'ts': ts,
                    'duration': duration_ms,
                    'args': args
                })
        
        elif 'Timer' in name:
            timer_events.append({
                'ts': ts,
                'duration': duration_ms,
                'name': name,
                'args': args
            })
    
    # Analyze FunctionCalls
    print("="*80)
    print("FUNCTION CALL DETAILS")
    print("="*80)
    print()
    
    if function_calls:
        # Get time range
        min_ts = min(fc['ts'] for fc in function_calls)
        
        # Group by script
        by_script = defaultdict(list)
        for fc in function_calls:
            script = fc['scriptName'] or fc['url'] or 'unknown'
            # Clean up script name
            if '?' in script:
                script = script.split('?')[0]
            by_script[script].append(fc)
        
        print(f"Found {len(function_calls)} function calls across {len(by_script)} scripts")
        print()
        
        # Sort scripts by total time
        script_stats = []
        for script, calls in by_script.items():
            total_time = sum(c['duration'] for c in calls)
            script_stats.append({
                'script': script,
                'calls': calls,
                'count': len(calls),
                'total_time': total_time
            })
        
        script_stats.sort(key=lambda x: x['total_time'], reverse=True)
        
        print(f"{'Script':<50} {'Calls':<10} {'Total ms':<12}")
        print("-"*80)
        for stat in script_stats[:20]:
            print(f"{stat['script']:<50} {stat['count']:<10} {stat['total_time']:>10.2f}ms")
        
        print()
        print()
        
        # Show top functions by total time
        function_stats = defaultdict(lambda: {'count': 0, 'total_time': 0, 'calls': []})
        for fc in function_calls:
            fn = fc['functionName'] or 'anonymous'
            function_stats[fn]['count'] += 1
            function_stats[fn]['total_time'] += fc['duration']
            function_stats[fn]['calls'].append(fc)
        
        sorted_fns = sorted(function_stats.items(), key=lambda x: x[1]['total_time'], reverse=True)
        
        print("Top functions by total time:")
        print(f"{'Function':<50} {'Count':<10} {'Total ms':<12} {'Avg ms':<12}")
        print("-"*90)
        for fn, stats in sorted_fns[:30]:
            avg = stats['total_time'] / stats['count']
            print(f"{fn:<50} {stats['count']:<10} {stats['total_time']:>10.2f}ms {avg:>10.2f}ms")
        
        print()
        print()
        
        # Show performWorkUntilDeadline calls in detail
        perf_work_calls = [fc for fc in function_calls if 'performWork' in fc['functionName']]
        if perf_work_calls:
            perf_work_calls.sort(key=lambda x: x['duration'], reverse=True)
            
            print(f"performWorkUntilDeadline calls: {len(perf_work_calls)}")
            print(f"Total time: {sum(c['duration'] for c in perf_work_calls):.2f}ms")
            print()
            print("Top 20 longest:")
            print(f"{'Time (s)':<12} {'Duration':<12} {'Script':<50}")
            print("-"*80)
            for call in perf_work_calls[:20]:
                time_s = (call['ts'] - min_ts) / 1_000_000
                script = call['scriptName'].split('?')[0] if call['scriptName'] else 'unknown'
                print(f"{time_s:>10.3f}s {call['duration']:>10.2f}ms {script:<50}")
            print()
    else:
        print("No FunctionCall events found")
        print("Enable 'JavaScript Profiler' in Performance settings")
        print()
    
    # Analyze Timer events
    if timer_events:
        print("="*80)
        print("TIMER EVENTS")
        print("="*80)
        print()
        
        print(f"Found {len(timer_events)} timer events")
        
        timer_by_type = defaultdict(list)
        for timer in timer_events:
            timer_by_type[timer['name']].append(timer)
        
        print()
        for timer_type, timers in sorted(timer_by_type.items(), key=lambda x: len(x[1]), reverse=True):
            print(f"{timer_type}: {len(timers)} calls, {sum(t['duration'] for t in timers):.2f}ms total")
        
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 event_args_inspector.py <trace.json>")
        sys.exit(1)
    
    inspect_event_args(sys.argv[1])

