#!/usr/bin/env python3
"""
Analyze what triggered CanvasInner commits
"""

import json
import sys

def analyze_canvas_commits(profiler_file):
    with open(profiler_file, 'r') as f:
        data = json.load(f)
    
    roots = data.get('dataForRoots', [])
    if not roots or len(roots) == 0:
        print("No roots found")
        return
    
    root = roots[0]
    commits = root.get('commitData', [])
    
    print("="*80)
    print("CANVASINNER COMMIT ANALYSIS - What triggered each heavy re-render?")
    print("="*80)
    print()
    
    for i, commit in enumerate(commits):
        updaters = commit.get('updaters', [])
        has_canvas_inner = any(u.get('displayName') == 'CanvasInner' for u in updaters)
        
        if not has_canvas_inner:
            continue
        
        duration = commit.get('duration', 0)
        timestamp = commit.get('timestamp', 0)
        fiber_count = len(commit.get('fiberActualDurations', []))
        
        print(f"{'='*80}")
        print(f"Commit #{i+1} - CanvasInner re-render")
        print(f"{'='*80}")
        print(f"Timestamp: {timestamp:.1f}ms")
        print(f"Duration: {duration}ms")
        print(f"Fibers: {fiber_count}")
        print()
        
        print("UPDATERS (components that triggered this commit):")
        for updater in updaters:
            print(f"  - {updater.get('displayName')} (id={updater.get('id')})")
            print(f"    Type: {updater.get('type')}")
            if updater.get('hocDisplayNames'):
                print(f"    HOCs: {updater.get('hocDisplayNames')}")
        print()
        
        # Look at changeDescriptions to see what actually changed
        change_descriptions = commit.get('changeDescriptions', [])
        
        if change_descriptions:
            print(f"CHANGE DESCRIPTIONS ({len(change_descriptions)} components changed):")
            print()
            
            # Group changes by type
            context_changes = []
            props_changes = []
            hooks_changes = []
            state_changes = []
            
            for change in change_descriptions:
                fiber_id = change[0]
                desc = change[1]
                
                if desc.get('context'):
                    context_changes.append((fiber_id, desc))
                if desc.get('props'):
                    props_changes.append((fiber_id, desc))
                if desc.get('hooks'):
                    hooks_changes.append((fiber_id, desc))
                if desc.get('state'):
                    state_changes.append((fiber_id, desc))
            
            if context_changes:
                print(f"  Context changes: {len(context_changes)}")
                for fiber_id, desc in context_changes[:5]:
                    print(f"    Fiber {fiber_id}: context={desc.get('context')}")
                if len(context_changes) > 5:
                    print(f"    ... and {len(context_changes) - 5} more")
                print()
            
            if props_changes:
                print(f"  Props changes: {len(props_changes)}")
                for fiber_id, desc in props_changes[:10]:
                    print(f"    Fiber {fiber_id}: props={desc.get('props')}")
                if len(props_changes) > 10:
                    print(f"    ... and {len(props_changes) - 10} more")
                print()
            
            if hooks_changes:
                print(f"  Hook changes: {len(hooks_changes)}")
                for fiber_id, desc in hooks_changes[:5]:
                    print(f"    Fiber {fiber_id}: hooks={desc.get('hooks')}, didHooksChange={desc.get('didHooksChange')}")
                if len(hooks_changes) > 5:
                    print(f"    ... and {len(hooks_changes) - 5} more")
                print()
            
            if state_changes:
                print(f"  State changes: {len(state_changes)}")
                for fiber_id, desc in state_changes[:5]:
                    print(f"    Fiber {fiber_id}: state={desc.get('state')}")
                if len(state_changes) > 5:
                    print(f"    ... and {len(state_changes) - 5} more")
                print()
        
        print()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 analyze_canvas_commits.py <profiler.json>")
        sys.exit(1)
    
    analyze_canvas_commits(sys.argv[1])

