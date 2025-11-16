#!/usr/bin/env python3
"""
Deep React Scheduler Analysis

Extracts:
- React scheduler work (performWorkUntilDeadline)
- What triggers each scheduler cycle
- Commit phase work
- Effect cleanup/execution
- Component render times
"""

import json
import sys
from collections import defaultdict

def analyze_react_scheduler(trace_file):
    print("="*80)
    print("REACT SCHEDULER DEEP DIVE")
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
    print(f"Renderer process ID: {renderer_pid}")
    print()
    
    # Extract React scheduler work
    scheduler_cycles = []
    commit_phases = []
    effect_work = []
    react_renders = []
    
    # Track nested events
    event_stack = []
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        ph = event.get('ph')
        name = event.get('name', '')
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        
        if ph == 'B':  # Begin
            event_stack.append({
                'name': name,
                'ts': ts,
                'args': event.get('args', {})
            })
        elif ph == 'E':  # End
            if event_stack and event_stack[-1]['name'] == name:
                start_event = event_stack.pop()
                duration = (ts - start_event['ts']) / 1000  # Convert to ms
                
                # Identify React-specific work
                if 'performWorkUntilDeadline' in name or 'performConcurrentWork' in name:
                    scheduler_cycles.append({
                        'name': name,
                        'start': start_event['ts'],
                        'duration': duration,
                        'args': start_event['args']
                    })
                elif 'commit' in name.lower() and duration > 1:
                    commit_phases.append({
                        'name': name,
                        'start': start_event['ts'],
                        'duration': duration,
                        'args': start_event['args']
                    })
                elif 'useEffect' in name or 'useLayoutEffect' in name:
                    effect_work.append({
                        'name': name,
                        'start': start_event['ts'],
                        'duration': duration,
                        'args': start_event['args']
                    })
        elif ph == 'X':  # Complete event
            duration = dur / 1000  # Convert to ms
            
            if 'performWorkUntilDeadline' in name or 'performConcurrentWork' in name:
                scheduler_cycles.append({
                    'name': name,
                    'start': ts,
                    'duration': duration,
                    'args': event.get('args', {})
                })
            elif 'commit' in name.lower() and duration > 1:
                commit_phases.append({
                    'name': name,
                    'start': ts,
                    'duration': duration,
                    'args': event.get('args', {})
                })
            elif 'FunctionCall' in name:
                fn_name = event.get('args', {}).get('data', {}).get('functionName', '')
                if fn_name:
                    react_renders.append({
                        'function': fn_name,
                        'start': ts,
                        'duration': duration
                    })
    
    # Analyze scheduler cycles
    print("="*80)
    print("REACT SCHEDULER CYCLES")
    print("="*80)
    print()
    
    if scheduler_cycles:
        print(f"Found {len(scheduler_cycles)} scheduler work cycles")
        print()
        
        # Sort by duration
        scheduler_cycles.sort(key=lambda x: x['duration'], reverse=True)
        
        print("Top 20 longest scheduler cycles:")
        print(f"{'Duration':<12} {'Time (s)':<12} {'Name':<50}")
        print("-"*80)
        
        for cycle in scheduler_cycles[:20]:
            time_s = (cycle['start'] - scheduler_cycles[0]['start']) / 1_000_000
            print(f"{cycle['duration']:>10.2f}ms {time_s:>10.3f}s {cycle['name']:<50}")
        
        print()
        print(f"Total scheduler time: {sum(c['duration'] for c in scheduler_cycles):.2f}ms")
        print(f"Average per cycle: {sum(c['duration'] for c in scheduler_cycles) / len(scheduler_cycles):.2f}ms")
        print()
    else:
        print("No React scheduler cycles found in trace")
        print("This is normal if React is in production mode with minimal instrumentation")
        print()
    
    # Analyze commit phases
    print("="*80)
    print("REACT COMMIT PHASES")
    print("="*80)
    print()
    
    if commit_phases:
        commit_phases.sort(key=lambda x: x['duration'], reverse=True)
        
        print(f"Found {len(commit_phases)} commit phases")
        print()
        print("Top 20 longest commits:")
        print(f"{'Duration':<12} {'Time (s)':<12} {'Name':<50}")
        print("-"*80)
        
        for commit in commit_phases[:20]:
            time_s = (commit['start'] - commit_phases[0]['start']) / 1_000_000
            print(f"{commit['duration']:>10.2f}ms {time_s:>10.3f}s {commit['name']:<50}")
        
        print()
        print(f"Total commit time: {sum(c['duration'] for c in commit_phases):.2f}ms")
        print()
    else:
        print("No commit phases found (expected in production build)")
        print()
    
    # Analyze effect work
    if effect_work:
        print("="*80)
        print("REACT EFFECTS")
        print("="*80)
        print()
        
        effect_work.sort(key=lambda x: x['duration'], reverse=True)
        
        print(f"Found {len(effect_work)} effect executions")
        print()
        print("Top 20 longest effects:")
        print(f"{'Duration':<12} {'Time (s)':<12} {'Name':<50}")
        print("-"*80)
        
        for effect in effect_work[:20]:
            time_s = (effect['start'] - effect_work[0]['start']) / 1_000_000
            print(f"{effect['duration']:>10.2f}ms {time_s:>10.3f}s {effect['name']:<50}")
        
        print()
    
    # Analyze function calls
    if react_renders:
        print("="*80)
        print("REACT COMPONENT RENDERS")
        print("="*80)
        print()
        
        # Group by function name
        function_stats = defaultdict(lambda: {'count': 0, 'total_time': 0, 'max_time': 0})
        
        for render in react_renders:
            fn = render['function']
            function_stats[fn]['count'] += 1
            function_stats[fn]['total_time'] += render['duration']
            function_stats[fn]['max_time'] = max(function_stats[fn]['max_time'], render['duration'])
        
        # Sort by total time
        sorted_funcs = sorted(function_stats.items(), key=lambda x: x[1]['total_time'], reverse=True)
        
        print(f"Found {len(react_renders)} component render calls")
        print()
        print("Top 20 components by total render time:")
        print(f"{'Function':<40} {'Count':<8} {'Total ms':<12} {'Avg ms':<12} {'Max ms':<12}")
        print("-"*90)
        
        for fn, stats in sorted_funcs[:20]:
            avg = stats['total_time'] / stats['count']
            print(f"{fn:<40} {stats['count']:<8} {stats['total_time']:>10.2f}ms {avg:>10.2f}ms {stats['max_time']:>10.2f}ms")
        
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 react_scheduler_analysis.py <trace.json>")
        sys.exit(1)
    
    analyze_react_scheduler(sys.argv[1])

