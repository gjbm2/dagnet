#!/usr/bin/env python3
"""
Timing Pattern Analyzer

Since we don't have JS profiling, analyze the TIMING patterns
of RunTask events to infer what's causing them.
"""

import json
import sys
import statistics

def analyze_timing_patterns(trace_file):
    print("="*80)
    print("TIMING PATTERN FORENSICS")
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
    
    # Extract all RunTasks with timestamps
    run_tasks = []
    for event in events:
        if event.get('pid') != renderer_pid or event.get('name') != 'RunTask':
            continue
        
        if event.get('ph') == 'X':
            run_tasks.append({
                'ts': event.get('ts', 0),
                'dur': event.get('dur', 0) / 1000,  # ms
                'tid': event.get('tid', 0)
            })
    
    if not run_tasks:
        print("No RunTask events found")
        return
    
    run_tasks.sort(key=lambda x: x['ts'])
    
    print(f"Total RunTask events: {len(run_tasks)}")
    print()
    
    # Calculate intervals between consecutive tasks
    intervals = []
    for i in range(1, len(run_tasks)):
        interval_us = run_tasks[i]['ts'] - run_tasks[i-1]['ts']
        interval_ms = interval_us / 1000
        intervals.append(interval_ms)
    
    if not intervals:
        print("Not enough RunTasks to analyze")
        return
    
    # Statistical analysis of intervals
    print("="*80)
    print("INTERVAL STATISTICS")
    print("="*80)
    print()
    
    mean_interval = statistics.mean(intervals)
    median_interval = statistics.median(intervals)
    stdev_interval = statistics.stdev(intervals) if len(intervals) > 1 else 0
    min_interval = min(intervals)
    max_interval = max(intervals)
    
    print(f"Mean interval:     {mean_interval:>8.2f}ms")
    print(f"Median interval:   {median_interval:>8.2f}ms")
    print(f"Std deviation:     {stdev_interval:>8.2f}ms")
    print(f"Min interval:      {min_interval:>8.2f}ms")
    print(f"Max interval:      {max_interval:>8.2f}ms")
    print()
    
    # Percentiles
    percentiles = [10, 25, 50, 75, 90, 95, 99]
    print("Percentiles:")
    for p in percentiles:
        val = sorted(intervals)[int(len(intervals) * p / 100)]
        print(f"  {p}th: {val:>8.2f}ms")
    print()
    
    # Histogram
    print("="*80)
    print("INTERVAL HISTOGRAM")
    print("="*80)
    print()
    
    # Create buckets
    buckets = {
        '0-1ms': 0,
        '1-2ms': 0,
        '2-5ms': 0,
        '5-10ms': 0,
        '10-20ms': 0,
        '20-50ms': 0,
        '50-100ms': 0,
        '>100ms': 0
    }
    
    for interval in intervals:
        if interval < 1:
            buckets['0-1ms'] += 1
        elif interval < 2:
            buckets['1-2ms'] += 1
        elif interval < 5:
            buckets['2-5ms'] += 1
        elif interval < 10:
            buckets['5-10ms'] += 1
        elif interval < 20:
            buckets['10-20ms'] += 1
        elif interval < 50:
            buckets['20-50ms'] += 1
        elif interval < 100:
            buckets['50-100ms'] += 1
        else:
            buckets['>100ms'] += 1
    
    total = len(intervals)
    for bucket, count in buckets.items():
        pct = count / total * 100
        bar = '█' * int(pct / 2)
        print(f"{bucket:<12} {count:>6} ({pct:>5.1f}%) {bar}")
    
    print()
    
    # Detect clusters
    print("="*80)
    print("TEMPORAL CLUSTERING ANALYSIS")
    print("="*80)
    print()
    
    # Find rapid-fire clusters (multiple tasks within 5ms)
    clusters = []
    current_cluster = [run_tasks[0]]
    
    for i in range(1, len(run_tasks)):
        time_diff_ms = (run_tasks[i]['ts'] - current_cluster[-1]['ts']) / 1000
        
        if time_diff_ms < 5:  # Within 5ms = same burst
            current_cluster.append(run_tasks[i])
        else:
            if len(current_cluster) >= 3:  # Cluster = 3+ tasks
                clusters.append(current_cluster)
            current_cluster = [run_tasks[i]]
    
    if len(current_cluster) >= 3:
        clusters.append(current_cluster)
    
    print(f"Found {len(clusters)} rapid-fire clusters (3+ tasks within 5ms)")
    print()
    
    if clusters:
        # Analyze clusters
        cluster_sizes = [len(c) for c in clusters]
        avg_cluster_size = statistics.mean(cluster_sizes)
        max_cluster_size = max(cluster_sizes)
        
        print(f"Average cluster size: {avg_cluster_size:.1f} tasks")
        print(f"Largest cluster: {max_cluster_size} tasks")
        print()
        
        # Show largest clusters
        clusters.sort(key=lambda x: len(x), reverse=True)
        
        print("Top 10 largest clusters:")
        print(f"{'Time (s)':<12} {'Tasks':<8} {'Span (ms)':<12} {'First Dur':<12} {'Last Dur':<12}")
        print("-"*70)
        
        min_ts = run_tasks[0]['ts']
        for cluster in clusters[:10]:
            time_s = (cluster[0]['ts'] - min_ts) / 1_000_000
            span_ms = (cluster[-1]['ts'] - cluster[0]['ts']) / 1000
            first_dur = cluster[0]['dur']
            last_dur = cluster[-1]['dur']
            
            print(f"{time_s:>10.3f}s {len(cluster):<8} {span_ms:>10.2f}ms {first_dur:>10.2f}ms {last_dur:>10.2f}ms")
        
        print()
    
    # Look for periodic patterns
    print("="*80)
    print("PERIODICITY ANALYSIS")
    print("="*80)
    print()
    
    # Check intervals around common periods
    frame_60hz = 16.67
    frame_30hz = 33.33
    frame_120hz = 8.33
    
    tolerance = 2.0  # ±2ms
    
    near_120hz = sum(1 for i in intervals if abs(i - frame_120hz) < tolerance)
    near_60hz = sum(1 for i in intervals if abs(i - frame_60hz) < tolerance)
    near_30hz = sum(1 for i in intervals if abs(i - frame_30hz) < tolerance)
    
    print(f"Intervals near 120Hz (8.33ms ±{tolerance}ms):  {near_120hz:>5} ({near_120hz/total*100:>5.1f}%)")
    print(f"Intervals near 60Hz (16.67ms ±{tolerance}ms): {near_60hz:>5} ({near_60hz/total*100:>5.1f}%)")
    print(f"Intervals near 30Hz (33.33ms ±{tolerance}ms): {near_30hz:>5} ({near_30hz/total*100:>5.1f}%)")
    print()
    
    # Check for continuous work (median interval < 5ms)
    if median_interval < 5:
        print("🚨 CRITICAL: Median interval is < 5ms")
        print(f"   Tasks are being scheduled CONTINUOUSLY")
        print(f"   This is NOT frame-based work (60Hz would be ~16.67ms)")
        print(f"   This indicates:")
        print(f"   - Continuous state updates")
        print(f"   - Effect loop")
        print(f"   - Observer callback loop")
        print(f"   - Or similar runaway condition")
        print()
    
    # Look for duration patterns
    print("="*80)
    print("DURATION PATTERN ANALYSIS")
    print("="*80)
    print()
    
    durations = [t['dur'] for t in run_tasks]
    mean_dur = statistics.mean(durations)
    median_dur = statistics.median(durations)
    
    print(f"Mean duration:     {mean_dur:>8.2f}ms")
    print(f"Median duration:   {median_dur:>8.2f}ms")
    print()
    
    # Duration buckets
    dur_buckets = {
        '0-1ms': 0,
        '1-5ms': 0,
        '5-10ms': 0,
        '10-20ms': 0,
        '20-50ms': 0,
        '>50ms': 0
    }
    
    for dur in durations:
        if dur < 1:
            dur_buckets['0-1ms'] += 1
        elif dur < 5:
            dur_buckets['1-5ms'] += 1
        elif dur < 10:
            dur_buckets['5-10ms'] += 1
        elif dur < 20:
            dur_buckets['10-20ms'] += 1
        elif dur < 50:
            dur_buckets['20-50ms'] += 1
        else:
            dur_buckets['>50ms'] += 1
    
    print("Duration distribution:")
    for bucket, count in dur_buckets.items():
        pct = count / len(durations) * 100
        bar = '█' * int(pct / 2)
        print(f"{bucket:<12} {count:>6} ({pct:>5.1f}%) {bar}")
    
    print()
    
    # Check for bimodal distribution (mix of fast and slow tasks)
    zero_dur = sum(1 for d in durations if d == 0)
    if zero_dur > len(durations) * 0.5:
        print(f"⚠️  {zero_dur} tasks ({zero_dur/len(durations)*100:.1f}%) have 0ms duration")
        print(f"   These are likely event dispatches or callbacks that execute quickly")
        print()
    
    long_tasks = [d for d in durations if d > 10]
    if long_tasks:
        print(f"Long tasks (> 10ms): {len(long_tasks)}")
        print(f"  Total time in long tasks: {sum(long_tasks):.2f}ms")
        print(f"  % of total time: {sum(long_tasks) / sum(durations) * 100:.1f}%")
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 timing_pattern_analyzer.py <trace.json>")
        sys.exit(1)
    
    analyze_timing_patterns(sys.argv[1])

