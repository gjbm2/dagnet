#!/usr/bin/env python3
"""
Console-Trace Correlator

Extracts console.log timestamps from the trace and correlates
them with RunTask events to understand the causal chain.
"""

import json
import sys
import re
from datetime import datetime

def parse_console_timestamp(message):
    """Extract timestamp from console log message"""
    # Pattern: [2025-11-15T20:12:53.440Z]
    match = re.search(r'\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]', message)
    if match:
        ts_str = match.group(1)
        try:
            dt = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
            return dt.timestamp() * 1_000_000  # Return microseconds
        except:
            pass
    return None

def analyze_console_correlation(trace_file):
    print("="*80)
    print("CONSOLE LOG CORRELATION ANALYSIS")
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
    
    # Extract console logs
    console_logs = []
    for event in events:
        if event.get('name') == 'ConsoleMessage' or 'Console' in event.get('name', ''):
            args = event.get('args', {})
            message = args.get('message', '') or args.get('text', '')
            ts = event.get('ts', 0)
            
            if message:
                log_ts = parse_console_timestamp(message)
                console_logs.append({
                    'ts': ts,
                    'log_ts': log_ts,
                    'message': message[:200]  # Truncate long messages
                })
    
    # Extract RunTasks
    run_tasks = []
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        if event.get('name') == 'RunTask' and event.get('ph') == 'X':
            dur_ms = event.get('dur', 0) / 1000
            if dur_ms > 5:  # Only significant tasks
                run_tasks.append({
                    'ts': event.get('ts', 0),
                    'duration': dur_ms
                })
    
    if not run_tasks or not console_logs:
        print(f"Found {len(console_logs)} console logs and {len(run_tasks)} RunTasks")
        print()
        if not console_logs:
            print("⚠️  No console logs found in trace")
            print("   Make sure to record with 'Log' checkbox enabled in Performance tab")
        return
    
    # Sort both by timestamp
    console_logs.sort(key=lambda x: x['ts'])
    run_tasks.sort(key=lambda x: x['ts'])
    
    print(f"Found {len(console_logs)} console logs")
    print(f"Found {len(run_tasks)} significant RunTasks (> 5ms)")
    print()
    
    # Get time range
    min_ts = min(console_logs[0]['ts'], run_tasks[0]['ts'])
    
    # Build correlation
    print("="*80)
    print("CONSOLE LOGS WITH NEAREST RUNTASK")
    print("="*80)
    print()
    
    print(f"{'Time (s)':<10} {'Log Delta':<12} {'Task Dur':<12} {'Message':<60}")
    print("-"*100)
    
    for log in console_logs:
        # Find nearest RunTask (before or after)
        nearest_task = None
        min_delta = float('inf')
        
        for task in run_tasks:
            delta_ms = abs(task['ts'] - log['ts']) / 1000
            if delta_ms < min_delta:
                min_delta = delta_ms
                nearest_task = task
        
        time_s = (log['ts'] - min_ts) / 1_000_000
        task_dur = nearest_task['duration'] if nearest_task else 0
        
        # Extract key info from message
        if 'GraphCanvas' in log['message'] and 'Render frame' in log['message']:
            frame_match = re.search(r'Render frame #(\d+)', log['message'])
            frame_num = frame_match.group(1) if frame_match else '?'
            message = f"GraphCanvas frame #{frame_num}"
        elif 'AppShell' in log['message']:
            message = "AppShell render"
        elif 'GraphEditor' in log['message'] and 'RENDER' in log['message']:
            message = "GraphEditor render"
        elif 'Navigator' in log['message']:
            message = "Navigator render"
        else:
            message = log['message'][:50]
        
        print(f"{time_s:>8.3f}s {min_delta:>10.2f}ms {task_dur:>10.2f}ms {message:<60}")
    
    print()
    
    # Identify clusters of rapid logging
    print("="*80)
    print("RAPID LOG CLUSTERS (multiple logs within 100ms)")
    print("="*80)
    print()
    
    CLUSTER_WINDOW_MS = 100
    clusters = []
    current_cluster = []
    
    for log in console_logs:
        if not current_cluster:
            current_cluster = [log]
        else:
            time_diff_ms = (log['ts'] - current_cluster[0]['ts']) / 1000
            if time_diff_ms <= CLUSTER_WINDOW_MS:
                current_cluster.append(log)
            else:
                if len(current_cluster) >= 3:  # At least 3 logs
                    clusters.append(current_cluster)
                current_cluster = [log]
    
    if len(current_cluster) >= 3:
        clusters.append(current_cluster)
    
    if clusters:
        print(f"Found {len(clusters)} clusters")
        print()
        
        for i, cluster in enumerate(clusters[:10]):
            time_s = (cluster[0]['ts'] - min_ts) / 1_000_000
            span_ms = (cluster[-1]['ts'] - cluster[0]['ts']) / 1000
            
            # Extract render frame numbers
            frame_nums = []
            for log in cluster:
                if 'Render frame #' in log['message']:
                    match = re.search(r'Render frame #(\d+)', log['message'])
                    if match:
                        frame_nums.append(int(match.group(1)))
            
            print(f"Cluster {i+1}:")
            print(f"  Time: {time_s:.3f}s")
            print(f"  Logs: {len(cluster)} in {span_ms:.1f}ms")
            if frame_nums:
                print(f"  GraphCanvas frames: {min(frame_nums)} - {max(frame_nums)} (Δ={max(frame_nums)-min(frame_nums)+1})")
            
            # Count component types
            component_counts = defaultdict(int)
            for log in cluster:
                if 'GraphCanvas' in log['message']:
                    component_counts['GraphCanvas'] += 1
                elif 'AppShell' in log['message']:
                    component_counts['AppShell'] += 1
                elif 'GraphEditor' in log['message']:
                    component_counts['GraphEditor'] += 1
                elif 'Navigator' in log['message']:
                    component_counts['Navigator'] += 1
            
            if component_counts:
                print(f"  Components: {dict(component_counts)}")
            
            print()
    else:
        print("No rapid log clusters found")
        print()
    
    # Summary
    print("="*80)
    print("SUMMARY")
    print("="*80)
    print()
    
    # Count logs by component
    component_logs = defaultdict(int)
    for log in console_logs:
        if 'GraphCanvas' in log['message']:
            component_logs['GraphCanvas'] += 1
        elif 'AppShell' in log['message']:
            component_logs['AppShell'] += 1
        elif 'GraphEditor' in log['message']:
            component_logs['GraphEditor'] += 1
        elif 'Navigator' in log['message']:
            component_logs['Navigator'] += 1
        elif 'DataMenu' in log['message']:
            component_logs['DataMenu'] += 1
        elif 'EditMenu' in log['message']:
            component_logs['EditMenu'] += 1
    
    print("Logs by component:")
    for component, count in sorted(component_logs.items(), key=lambda x: x[1], reverse=True):
        print(f"  {component:<20} {count:>4} logs")
    
    print()
    
    # Estimate render rate
    graphcanvas_logs = [l for l in console_logs if 'GraphCanvas' in l['message'] and 'Render frame' in l['message']]
    if graphcanvas_logs and len(graphcanvas_logs) >= 2:
        first_ts = graphcanvas_logs[0]['ts']
        last_ts = graphcanvas_logs[-1]['ts']
        span_s = (last_ts - first_ts) / 1_000_000
        render_rate = len(graphcanvas_logs) / span_s if span_s > 0 else 0
        
        print(f"GraphCanvas render rate: {render_rate:.1f} renders/second")
        print(f"  ({len(graphcanvas_logs)} renders over {span_s:.2f}s)")
        print()
        
        if render_rate > 30:
            print("🚨 CRITICAL: GraphCanvas rendering at > 30 Hz")
            print("   This is extremely high for a pan/zoom interaction")
            print("   Indicates continuous re-render loop")
            print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 console_trace_correlator.py <trace.json>")
        sys.exit(1)
    
    analyze_console_correlation(sys.argv[1])

