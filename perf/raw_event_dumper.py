#!/usr/bin/env python3
"""
Raw Event Dumper

Dumps a sample of raw events to see their actual structure
and identify patterns we're missing.
"""

import json
import sys
from collections import defaultdict

def dump_raw_events(trace_file, max_events=200):
    print("="*80)
    print("RAW EVENT STRUCTURE DUMP")
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
    
    # Get renderer events
    renderer_events = [e for e in events if e.get('pid') == renderer_pid]
    
    print(f"Total renderer events: {len(renderer_events)}")
    print()
    
    # Sample different event types
    print("="*80)
    print("SAMPLE EVENTS BY TYPE")
    print("="*80)
    print()
    
    # Get unique event names
    event_names = set(e.get('name', '') for e in renderer_events)
    print(f"Unique event names: {len(event_names)}")
    print()
    
    # Show sample of each type
    samples_per_type = {}
    for event in renderer_events:
        name = event.get('name', '')
        if name not in samples_per_type:
            samples_per_type[name] = []
        if len(samples_per_type[name]) < 3:  # Keep first 3 samples
            samples_per_type[name].append(event)
    
    # Print samples for interesting types
    interesting_types = [
        'RunTask',
        'FunctionCall',
        'TimerFire',
        'TimerInstall',
        'RasterTask',
        'UpdateLayer',
        'UpdateLayerTree',
        'Layout',
        'Paint',
        'Commit',
        'ScheduleStyleRecalculation',
        'InvalidateLayout'
    ]
    
    for event_type in interesting_types:
        if event_type in samples_per_type:
            print(f"\n{'='*80}")
            print(f"{event_type} (showing {len(samples_per_type[event_type])} samples)")
            print('='*80)
            for i, event in enumerate(samples_per_type[event_type]):
                print(f"\nSample {i+1}:")
                print(json.dumps(event, indent=2))
    
    # List all event types with counts
    print("\n" + "="*80)
    print("ALL EVENT TYPES (sorted by frequency)")
    print("="*80)
    print()
    
    event_counts = defaultdict(int)
    for event in renderer_events:
        event_counts[event.get('name', '')] += 1
    
    sorted_counts = sorted(event_counts.items(), key=lambda x: x[1], reverse=True)
    
    print(f"{'Event Name':<50} {'Count':<10}")
    print("-"*65)
    for name, count in sorted_counts[:50]:
        print(f"{name:<50} {count:<10}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 raw_event_dumper.py <trace.json> [max_samples]")
        sys.exit(1)
    
    max_events = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    dump_raw_events(sys.argv[1], max_events)

