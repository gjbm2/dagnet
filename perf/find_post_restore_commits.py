#!/usr/bin/env python3
"""
Find React commits that happen AFTER atomic restoration completes

Based on console logs showing:
- ATOMIC RESTORE START: timestamp T0
- Frame #56 render during flushSync
- ATOMIC RESTORE COMPLETE: timestamp T1 (42.1ms after T0)

We want to find all commits that happen AFTER T1
"""

import json
import sys

def find_post_restore_commits(profiler_file):
    with open(profiler_file, 'r') as f:
        data = json.load(f)
    
    roots = data.get('dataForRoots', [])
    if not roots or len(roots) == 0:
        print("No roots found")
        return
    
    root = roots[0]
    commits = root.get('commitData', [])
    
    print(f"Total commits in profile: {len(commits)}")
    print()
    
    # Find commits with CanvasInner as updater (these are the heavy ones)
    canvas_commits = []
    for i, commit in enumerate(commits):
        updaters = commit.get('updaters', [])
        duration = commit.get('duration', 0)
        timestamp = commit.get('timestamp', 0)
        
        has_canvas_inner = any(u.get('displayName') == 'CanvasInner' for u in updaters)
        
        if has_canvas_inner:
            canvas_commits.append({
                'index': i + 1,
                'timestamp': timestamp,
                'duration': duration,
                'updaters': [u.get('displayName') for u in updaters],
                'fiber_count': len(commit.get('fiberActualDurations', []))
            })
    
    print("="*80)
    print("CANVASINNER COMMITS (Heavy ReactFlow re-renders)")
    print("="*80)
    print()
    
    for commit in canvas_commits:
        print(f"Commit #{commit['index']}:")
        print(f"  Timestamp: {commit['timestamp']:.1f}ms")
        print(f"  Duration: {commit['duration']}ms")
        print(f"  Updaters: {', '.join(commit['updaters'])}")
        print(f"  Fibers: {commit['fiber_count']}")
        print()
    
    # Look for timing patterns
    if len(canvas_commits) >= 2:
        print("="*80)
        print("TIMING PATTERN ANALYSIS")
        print("="*80)
        print()
        
        for i in range(1, len(canvas_commits)):
            prev = canvas_commits[i-1]
            curr = canvas_commits[i]
            interval = curr['timestamp'] - prev['timestamp']
            
            print(f"Interval between Commit #{prev['index']} and #{curr['index']}: {interval:.1f}ms")
        
        print()
        print("If these CanvasInner commits are happening close together (~10-50ms apart),")
        print("it suggests ReactFlow is being triggered multiple times in quick succession,")
        print("which would interrupt the atomic restoration frame.")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 find_post_restore_commits.py <profiler.json>")
        sys.exit(1)
    
    find_post_restore_commits(sys.argv[1])

