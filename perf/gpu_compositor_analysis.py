#!/usr/bin/env python3
"""
GPU Compositor Analysis

Focuses on:
- Layer composition work
- Rasterization tasks
- UpdateLayerTree operations
- Paint operations
- GPU memory usage
"""

import json
import sys
from collections import defaultdict

def analyze_gpu_compositor(trace_file):
    print("="*80)
    print("GPU COMPOSITOR & RENDERING ANALYSIS")
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
    
    # Track compositor work
    raster_tasks = []
    update_layer_tasks = []
    paint_tasks = []
    composite_tasks = []
    draw_frame_tasks = []
    
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        name = event.get('name', '')
        ts = event.get('ts', 0)
        dur = event.get('dur', 0)
        ph = event.get('ph')
        
        if ph != 'X':  # Only complete events
            continue
        
        duration_ms = dur / 1000
        
        if duration_ms == 0:
            continue
        
        args = event.get('args', {})
        
        if 'RasterTask' in name:
            raster_tasks.append({
                'ts': ts,
                'duration': duration_ms,
                'args': args
            })
        elif 'UpdateLayer' in name:
            update_layer_tasks.append({
                'ts': ts,
                'duration': duration_ms,
                'args': args
            })
        elif 'Paint' == name or 'PaintImage' in name:
            paint_tasks.append({
                'ts': ts,
                'duration': duration_ms,
                'args': args
            })
        elif 'Composite' in name or 'CompositeLayers' in name:
            composite_tasks.append({
                'ts': ts,
                'duration': duration_ms,
                'args': args
            })
        elif 'DrawFrame' in name:
            draw_frame_tasks.append({
                'ts': ts,
                'duration': duration_ms,
                'args': args
            })
    
    # Get time range
    all_tasks = raster_tasks + update_layer_tasks + paint_tasks + composite_tasks + draw_frame_tasks
    if not all_tasks:
        print("No compositor work found")
        return
    
    min_ts = min(t['ts'] for t in all_tasks)
    max_ts = max(t['ts'] for t in all_tasks)
    duration_s = (max_ts - min_ts) / 1_000_000
    
    print(f"Analysis window: {duration_s:.2f}s")
    print()
    
    # Raster tasks analysis
    print("="*80)
    print("RASTERIZATION TASKS")
    print("="*80)
    print()
    
    if raster_tasks:
        raster_tasks.sort(key=lambda x: x['duration'], reverse=True)
        
        print(f"Total RasterTask calls: {len(raster_tasks)}")
        total_raster = sum(t['duration'] for t in raster_tasks)
        print(f"Total rasterization time: {total_raster:.2f}ms")
        print(f"Average per task: {total_raster/len(raster_tasks):.2f}ms")
        print(f"Max single task: {raster_tasks[0]['duration']:.2f}ms")
        print()
        
        # Group by time windows
        WINDOW_MS = 100
        current_window = []
        windows = []
        
        sorted_raster = sorted(raster_tasks, key=lambda x: x['ts'])
        for task in sorted_raster:
            if not current_window:
                current_window = [task]
            else:
                time_diff = (task['ts'] - current_window[0]['ts']) / 1000
                if time_diff <= WINDOW_MS:
                    current_window.append(task)
                else:
                    windows.append(current_window)
                    current_window = [task]
        if current_window:
            windows.append(current_window)
        
        if len(windows) > 1:
            print(f"Rasterization occurred in {len(windows)} bursts (grouped by {WINDOW_MS}ms windows)")
            print()
            print("Top 10 rasterization bursts:")
            print(f"{'Time (s)':<12} {'Tasks':<8} {'Total ms':<12} {'Avg ms':<12}")
            print("-"*50)
            
            windows.sort(key=lambda w: sum(t['duration'] for t in w), reverse=True)
            for window in windows[:10]:
                time_s = (window[0]['ts'] - min_ts) / 1_000_000
                total = sum(t['duration'] for t in window)
                avg = total / len(window)
                print(f"{time_s:>10.3f}s {len(window):<8} {total:>10.2f}ms {avg:>10.2f}ms")
            print()
    else:
        print("No rasterization tasks found")
        print()
    
    # UpdateLayer analysis
    print("="*80)
    print("UPDATE LAYER OPERATIONS")
    print("="*80)
    print()
    
    if update_layer_tasks:
        update_layer_tasks.sort(key=lambda x: x['duration'], reverse=True)
        
        print(f"Total UpdateLayer calls: {len(update_layer_tasks)}")
        total_update = sum(t['duration'] for t in update_layer_tasks)
        print(f"Total update time: {total_update:.2f}ms")
        print(f"Average per task: {total_update/len(update_layer_tasks):.2f}ms")
        print()
        
        print("Top 20 longest UpdateLayer operations:")
        print(f"{'Time (s)':<12} {'Duration':<12}")
        print("-"*30)
        for task in update_layer_tasks[:20]:
            time_s = (task['ts'] - min_ts) / 1_000_000
            print(f"{time_s:>10.3f}s {task['duration']:>10.2f}ms")
        print()
    else:
        print("No UpdateLayer operations found")
        print()
    
    # Paint analysis
    if paint_tasks:
        print("="*80)
        print("PAINT OPERATIONS")
        print("="*80)
        print()
        
        print(f"Total Paint calls: {len(paint_tasks)}")
        total_paint = sum(t['duration'] for t in paint_tasks)
        print(f"Total paint time: {total_paint:.2f}ms")
        print(f"Average per task: {total_paint/len(paint_tasks):.2f}ms")
        print()
    
    # Composite analysis
    if composite_tasks:
        print("="*80)
        print("COMPOSITE OPERATIONS")
        print("="*80)
        print()
        
        print(f"Total Composite calls: {len(composite_tasks)}")
        total_composite = sum(t['duration'] for t in composite_tasks)
        print(f"Total composite time: {total_composite:.2f}ms")
        print(f"Average per task: {total_composite/len(composite_tasks):.2f}ms")
        print()
    
    # Summary
    print("="*80)
    print("RENDERING PIPELINE SUMMARY")
    print("="*80)
    print()
    
    total_rendering = (
        sum(t['duration'] for t in paint_tasks) +
        sum(t['duration'] for t in update_layer_tasks) +
        sum(t['duration'] for t in raster_tasks) +
        sum(t['duration'] for t in composite_tasks)
    )
    
    print(f"{'Stage':<30} {'Calls':<10} {'Total ms':<15} {'% of Total':<12}")
    print("-"*70)
    
    if paint_tasks:
        paint_total = sum(t['duration'] for t in paint_tasks)
        paint_pct = (paint_total / total_rendering * 100) if total_rendering > 0 else 0
        print(f"{'Paint':<30} {len(paint_tasks):<10} {paint_total:>13.2f}ms {paint_pct:>10.1f}%")
    
    if update_layer_tasks:
        update_total = sum(t['duration'] for t in update_layer_tasks)
        update_pct = (update_total / total_rendering * 100) if total_rendering > 0 else 0
        print(f"{'UpdateLayer':<30} {len(update_layer_tasks):<10} {update_total:>13.2f}ms {update_pct:>10.1f}%")
    
    if raster_tasks:
        raster_total = sum(t['duration'] for t in raster_tasks)
        raster_pct = (raster_total / total_rendering * 100) if total_rendering > 0 else 0
        print(f"{'Rasterization':<30} {len(raster_tasks):<10} {raster_total:>13.2f}ms {raster_pct:>10.1f}%")
    
    if composite_tasks:
        composite_total = sum(t['duration'] for t in composite_tasks)
        composite_pct = (composite_total / total_rendering * 100) if total_rendering > 0 else 0
        print(f"{'Composite':<30} {len(composite_tasks):<10} {composite_total:>13.2f}ms {composite_pct:>10.1f}%")
    
    print("-"*70)
    print(f"{'TOTAL RENDERING WORK':<30} {'':<10} {total_rendering:>13.2f}ms")
    print()
    
    # Analysis
    print("="*80)
    print("DIAGNOSIS")
    print("="*80)
    print()
    
    if total_rendering < 20:
        print("✅ GOOD: Total rendering work is minimal (< 20ms)")
        print("   Problem is likely in JavaScript, not rendering")
    elif total_rendering < 50:
        print("⚠️  MODERATE: Some rendering work during interaction")
        print("   May contribute to jank but not the primary cause")
    else:
        print("❌ CRITICAL: Heavy rendering work during interaction")
        print("   This is causing significant performance issues")
        
        if raster_tasks and sum(t['duration'] for t in raster_tasks) > total_rendering * 0.5:
            print("   → Primary cause: Excessive rasterization")
            print("   → Indicates: Too many layer changes or repaints")
        if update_layer_tasks and sum(t['duration'] for t in update_layer_tasks) > total_rendering * 0.3:
            print("   → Significant UpdateLayer work")
            print("   → Indicates: Layer tree is being rebuilt frequently")
    
    print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 gpu_compositor_analysis.py <trace.json>")
        sys.exit(1)
    
    analyze_gpu_compositor(sys.argv[1])

