#!/usr/bin/env python3
"""
Continuous Work Loop Detector

Identifies sustained work patterns that indicate:
- Animation loops that don't stop
- Continuous re-renders
- ResizeObserver loops
- Effect loops
"""

import json
import sys
from collections import defaultdict

def detect_continuous_work(trace_file):
    print("="*80)
    print("CONTINUOUS WORK LOOP DETECTOR")
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
    
    # Extract ALL events by type
    events_by_type = defaultdict(list)
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        name = event.get('name', '')
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        ph = event.get('ph')
        
        if ph == 'X' and dur > 0:  # Complete events only
            duration_ms = dur / 1000
            events_by_type[name].append({
                'ts': ts,
                'duration': duration_ms,
                'args': event.get('args', {})
            })
    
    # Get time range
    all_events = []
    for event_list in events_by_type.values():
        all_events.extend(event_list)
    
    if not all_events:
        print("No events found")
        return
    
    all_events.sort(key=lambda x: x['ts'])
    min_ts = all_events[0]['ts']
    max_ts = all_events[-1]['ts']
    duration_s = (max_ts - min_ts) / 1_000_000
    
    print(f"Analysis window: {duration_s:.2f}s")
    print()
    
    # Analyze each event type for sustained activity
    print("="*80)
    print("SUSTAINED ACTIVITY DETECTION")
    print("="*80)
    print()
    
    sustained_events = []
    
    for event_type, event_list in events_by_type.items():
        if len(event_list) < 10:  # Need at least 10 occurrences
            continue
        
        # Sort by timestamp
        event_list.sort(key=lambda x: x['ts'])
        
        # Calculate rate over entire window
        first_ts = event_list[0]['ts']
        last_ts = event_list[-1]['ts']
        span_s = (last_ts - first_ts) / 1_000_000
        
        if span_s < 0.1:  # Too short to analyze
            continue
        
        rate_per_sec = len(event_list) / span_s
        total_time = sum(e['duration'] for e in event_list)
        
        # Check if sustained (high rate over long duration)
        if rate_per_sec > 20 and span_s > 1.0:
            sustained_events.append({
                'type': event_type,
                'count': len(event_list),
                'span_s': span_s,
                'rate': rate_per_sec,
                'total_time': total_time,
                'avg_duration': total_time / len(event_list)
            })
    
    # Sort by rate (highest first)
    sustained_events.sort(key=lambda x: x['rate'], reverse=True)
    
    if sustained_events:
        print(f"Found {len(sustained_events)} event types with sustained activity (> 20 calls/sec over > 1s)")
        print()
        print(f"{'Event Type':<40} {'Count':<8} {'Span (s)':<10} {'Rate/s':<10} {'Total ms':<12} {'Avg ms':<10}")
        print("-"*100)
        
        for event in sustained_events:
            print(f"{event['type']:<40} {event['count']:<8} {event['span_s']:>8.2f}s {event['rate']:>8.1f} {event['total_time']:>10.2f}ms {event['avg_duration']:>8.3f}ms")
        
        print()
        
        # Identify critical sustained work
        critical_types = []
        for event in sustained_events:
            if event['rate'] > 50 or event['total_time'] > 500:
                critical_types.append(event)
        
        if critical_types:
            print("="*80)
            print("🚨 CRITICAL SUSTAINED WORK LOOPS")
            print("="*80)
            print()
            
            for event in critical_types:
                print(f"{event['type']}:")
                print(f"  Rate: {event['rate']:.1f} calls/second")
                print(f"  Duration: {event['span_s']:.2f}s continuous")
                print(f"  Total CPU time: {event['total_time']:.2f}ms")
                print(f"  Average per call: {event['avg_duration']:.3f}ms")
                
                # Diagnose based on type
                if event['rate'] > 55 and event['rate'] < 65:
                    print(f"  ⚠️  Running at ~60Hz (once per frame)")
                    print(f"  ⚠️  This is a CONTINUOUS RENDER LOOP")
                elif 'Raster' in event['type']:
                    print(f"  ⚠️  Continuous rasterization indicates layer changes on every frame")
                elif 'UpdateLayer' in event['type']:
                    print(f"  ⚠️  Continuous layer updates indicate DOM/CSS changes on every frame")
                elif 'Layout' in event['type']:
                    print(f"  ⚠️  Continuous layout indicates forced reflows or size queries")
                
                print()
    else:
        print("✅ No sustained work loops detected")
        print()
    
    # Analyze specific problematic patterns
    print("="*80)
    print("SPECIFIC PATTERN ANALYSIS")
    print("="*80)
    print()
    
    # Check for ResizeObserver
    resize_events = events_by_type.get('ResizeObserverCallback', [])
    if resize_events:
        print(f"ResizeObserver callbacks: {len(resize_events)}")
        total_resize = sum(e['duration'] for e in resize_events)
        print(f"  Total time: {total_resize:.2f}ms")
        
        if len(resize_events) > 100:
            print(f"  🚨 CRITICAL: {len(resize_events)} ResizeObserver callbacks")
            print(f"     This indicates a resize loop")
        print()
    
    # Check for RAF
    raf_events = [e for e_list in events_by_type.values() for e in e_list if 'requestAnimationFrame' in str(e.get('args', {}))]
    if raf_events:
        print(f"requestAnimationFrame callbacks: {len(raf_events)}")
        print()
    
    # Check for setTimeout/setInterval
    timer_events = events_by_type.get('TimerFire', [])
    if timer_events:
        print(f"Timer events: {len(timer_events)}")
        total_timer = sum(e['duration'] for e in timer_events)
        print(f"  Total time: {total_timer:.2f}ms")
        
        if len(timer_events) > 100:
            print(f"  ⚠️  Many timer events - may indicate polling or repeated setTimeout")
        print()
    
    # Check for React work
    react_work = events_by_type.get('FunctionCall', [])
    if react_work:
        # Count performWorkUntilDeadline
        perf_work_calls = [e for e in react_work if 'performWork' in str(e.get('args', {}))]
        if perf_work_calls:
            print(f"React performWorkUntilDeadline calls: {len(perf_work_calls)}")
            total_perf = sum(e['duration'] for e in perf_work_calls)
            print(f"  Total time: {total_perf:.2f}ms")
            
            # Calculate rate
            if len(perf_work_calls) >= 2:
                first_ts = min(e['ts'] for e in perf_work_calls)
                last_ts = max(e['ts'] for e in perf_work_calls)
                span_s = (last_ts - first_ts) / 1_000_000
                rate = len(perf_work_calls) / span_s if span_s > 0 else 0
                
                print(f"  Rate: {rate:.1f} calls/second")
                
                if rate > 30:
                    print(f"  🚨 CRITICAL: React scheduler running at > 30 Hz")
                    print(f"     This indicates continuous state updates")
            print()
    
    print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 continuous_work_detector.py <trace.json>")
        sys.exit(1)
    
    detect_continuous_work(sys.argv[1])

