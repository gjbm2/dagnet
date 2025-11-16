#!/usr/bin/env python3
"""
Nested Work Analyzer

Extracts what's INSIDE the long RunTasks by building
the complete event tree structure.
"""

import json
import sys
from collections import defaultdict

def build_event_tree(events, renderer_pid):
    """Build tree of nested events using Begin/End pairs"""
    
    # First pass: create event objects
    event_objects = []
    for event in events:
        if event.get('pid') != renderer_pid:
            continue
        
        ph = event.get('ph')
        if ph in ['B', 'E', 'X']:
            event_objects.append(event)
    
    # Second pass: build tree
    stack = []
    roots = []
    
    for event in event_objects:
        ph = event.get('ph')
        name = event.get('name', '')
        ts = event.get('ts', 0)
        
        if ph == 'B':  # Begin
            node = {
                'name': name,
                'ts': ts,
                'dur': None,
                'children': [],
                'args': event.get('args', {}),
                'cat': event.get('cat', ''),
                'parent': stack[-1] if stack else None
            }
            
            if stack:
                stack[-1]['children'].append(node)
            else:
                roots.append(node)
            
            stack.append(node)
            
        elif ph == 'E':  # End
            if stack and stack[-1]['name'] == name:
                node = stack.pop()
                node['dur'] = (ts - node['ts']) / 1000  # Convert to ms
                
        elif ph == 'X':  # Complete
            dur_ms = event.get('dur', 0) / 1000
            node = {
                'name': name,
                'ts': ts,
                'dur': dur_ms,
                'children': [],
                'args': event.get('args', {}),
                'cat': event.get('cat', ''),
                'parent': None
            }
            
            if stack:
                stack[-1]['children'].append(node)
                node['parent'] = stack[-1]
            else:
                roots.append(node)
    
    return roots

def print_tree(node, indent=0, max_depth=8):
    """Print event tree"""
    if indent > max_depth:
        return
    
    dur_str = f"{node['dur']:.2f}ms" if node['dur'] is not None else "N/A"
    print(f"{'  ' * indent}{node['name']:<50} {dur_str:>12}")
    
    # Sort children by duration (descending)
    sorted_children = sorted(
        [c for c in node['children'] if c.get('dur', 0) > 0.5],  # Only show > 0.5ms
        key=lambda x: x.get('dur', 0),
        reverse=True
    )
    
    for child in sorted_children[:10]:  # Top 10 children only
        print_tree(child, indent + 1, max_depth)

def analyze_nested_work(trace_file):
    print("="*80)
    print("NESTED WORK TREE ANALYSIS")
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
    print(f"Building event tree for renderer process: {renderer_pid}")
    print()
    
    # Build tree
    roots = build_event_tree(events, renderer_pid)
    
    print(f"Found {len(roots)} root events")
    print()
    
    # Find long RunTasks
    long_run_tasks = []
    for root in roots:
        dur = root.get('dur')
        if root['name'] == 'RunTask' and dur is not None and dur > 15:
            long_run_tasks.append(root)
    
    if not long_run_tasks:
        print("No long RunTasks found (> 15ms)")
        return
    
    # Sort by duration
    long_run_tasks.sort(key=lambda x: x.get('dur', 0), reverse=True)
    
    print(f"Found {len(long_run_tasks)} RunTasks > 15ms")
    print()
    
    print("="*80)
    print("TOP 10 LONGEST RUNTASKS (with nested work)")
    print("="*80)
    print()
    
    for i, task in enumerate(long_run_tasks[:10]):
        time_s = (task['ts'] - long_run_tasks[0]['ts']) / 1_000_000
        print(f"#{i+1}: {task['dur']:.2f}ms at {time_s:.3f}s")
        print("-"*80)
        print_tree(task, indent=0, max_depth=6)
        print()
    
    # Categorize work by child event types
    print("="*80)
    print("WORK BREAKDOWN (what's inside long RunTasks)")
    print("="*80)
    print()
    
    work_categories = defaultdict(lambda: {'count': 0, 'total_time': 0})
    
    def categorize_children(node):
        for child in node['children']:
            if child.get('dur', 0) > 0:
                work_categories[child['name']]['count'] += 1
                work_categories[child['name']]['total_time'] += child['dur']
                categorize_children(child)
    
    for task in long_run_tasks:
        categorize_children(task)
    
    sorted_work = sorted(work_categories.items(), key=lambda x: x[1]['total_time'], reverse=True)
    
    print(f"{'Work Type':<50} {'Count':<10} {'Total ms':<12} {'Avg ms':<12}")
    print("-"*90)
    
    for work_type, stats in sorted_work[:30]:
        avg = stats['total_time'] / stats['count'] if stats['count'] > 0 else 0
        print(f"{work_type:<50} {stats['count']:<10} {stats['total_time']:>10.2f}ms {avg:>10.2f}ms")
    
    print()
    
    # Look for specific patterns
    print("="*80)
    print("PATTERN DETECTION")
    print("="*80)
    print()
    
    # Check for resize observer work
    resize_work = work_categories.get('ResizeObserver', {}).get('total_time', 0)
    if resize_work > 10:
        print(f"⚠️  ResizeObserver work detected: {resize_work:.2f}ms total")
        print("   May indicate continuous resize events")
        print()
    
    # Check for style recalc
    style_work = (
        work_categories.get('UpdateLayoutTree', {}).get('total_time', 0) +
        work_categories.get('RecalcStyle', {}).get('total_time', 0)
    )
    if style_work > 20:
        print(f"⚠️  Style recalculation work: {style_work:.2f}ms total")
        print("   May indicate CSS changes or forced reflows")
        print()
    
    # Check for layout work
    layout_work = work_categories.get('Layout', {}).get('total_time', 0)
    if layout_work > 20:
        print(f"⚠️  Layout work: {layout_work:.2f}ms total")
        print("   May indicate DOM changes or forced layout reads")
        print()
    
    # Check for paint work
    paint_work = work_categories.get('Paint', {}).get('total_time', 0)
    if paint_work > 20:
        print(f"⚠️  Paint work: {paint_work:.2f}ms total")
        print("   May indicate visual updates on every frame")
        print()
    
    # Check for GC
    gc_work = sum(
        stats['total_time'] 
        for name, stats in work_categories.items() 
        if 'GC' in name or 'garbage' in name.lower()
    )
    if gc_work > 30:
        print(f"⚠️  Garbage collection: {gc_work:.2f}ms total")
        print("   May indicate excessive object allocation")
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 nested_work_analyzer.py <trace.json>")
        sys.exit(1)
    
    analyze_nested_work(sys.argv[1])

