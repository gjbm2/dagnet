#!/usr/bin/env python3
"""
React DevTools Profiler Data Analyzer

Analyzes React profiler JSON export to find:
- Which components rendered most
- What triggered each render
- Render cascades and dependencies
"""

import json
import sys
from collections import defaultdict

def analyze_profiler_data(profiler_file):
    print("="*80)
    print("REACT DEVTOOLS PROFILER ANALYSIS")
    print("="*80)
    print()
    
    with open(profiler_file, 'r') as f:
        data = json.load(f)
    
    # React profiler exports have different structures depending on version
    # Try to extract the relevant data
    
    if 'dataForRoots' in data:
        roots = data['dataForRoots']
        print(f"Found {len(roots)} React roots")
        print()
        
        for root_id, root_data in roots.items():
            print(f"Root: {root_id}")
            
            if 'commitData' in root_data:
                commits = root_data['commitData']
                print(f"  Commits: {len(commits)}")
                
                # Analyze commits
                for i, commit in enumerate(commits):
                    duration = commit.get('duration', 0)
                    timestamp = commit.get('timestamp', 0)
                    
                    print(f"\n  Commit #{i+1}:")
                    print(f"    Duration: {duration}ms")
                    print(f"    Timestamp: {timestamp}")
                    
                    # Get fiber data
                    if 'fiberActualDurations' in commit:
                        fibers = commit['fiberActualDurations']
                        print(f"    Fibers rendered: {len(fibers)}")
                        
                        # Sort by duration
                        sorted_fibers = sorted(fibers, key=lambda x: x[1] if len(x) > 1 else 0, reverse=True)
                        
                        print(f"    Top 10 slowest components:")
                        for fiber_data in sorted_fibers[:10]:
                            if len(fiber_data) >= 2:
                                fiber_id = fiber_data[0]
                                fiber_dur = fiber_data[1]
                                print(f"      Fiber {fiber_id}: {fiber_dur}ms")
    
    elif 'version' in data:
        print(f"Profiler version: {data.get('version')}")
        
        # Try different structure
        if 'profilerData' in data:
            profiler_data = data['profilerData']
            print(json.dumps(profiler_data, indent=2)[:1000])
    
    else:
        # Unknown structure - dump keys
        print("Unknown profiler data structure")
        print("Top-level keys:", list(data.keys()))
        print()
        
        # Try to find anything useful
        for key, value in data.items():
            print(f"\n{key}:")
            if isinstance(value, dict):
                print(f"  Type: dict with {len(value)} keys")
                print(f"  Keys: {list(value.keys())[:10]}")
            elif isinstance(value, list):
                print(f"  Type: list with {len(value)} items")
                if len(value) > 0:
                    print(f"  First item type: {type(value[0])}")
                    if isinstance(value[0], dict):
                        print(f"  First item keys: {list(value[0].keys())}")
            else:
                print(f"  Type: {type(value)}")
                print(f"  Value: {str(value)[:200]}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 react_profiler_analyzer.py <profiler-data.json>")
        sys.exit(1)
    
    analyze_profiler_data(sys.argv[1])

