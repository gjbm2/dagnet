"""Debug a specific failing seed"""
import networkx as nx
import random
from test_inclusion_exclusion import generate_random_dag
from graph_analysis import get_competing_first_hops, find_minimal_merge
from optimized_inclusion_exclusion import validate_optimized_with_flow

seed = 516200
G = generate_random_dag(20, edge_probability=0.15, seed=seed)

print(f"Seed: {seed}")
print(f"Edges: {list(G.edges())[:20]}...")  # First 20 edges
print(f"\nTotal edges: {G.number_of_edges()}")

# Find an edge with competition
for edge in G.edges():
    source, target = edge
    merge = find_minimal_merge(G, source, target)
    competing = get_competing_first_hops(G, source, target, merge)
    if competing:
        print(f"\n{'='*60}")
        print(f"Edge under test: {source}→{target}")
        print(f"Merge node returned by find_minimal_merge: {merge}")
        print(f"Competing first hops: {competing}")
        
        print(f"\nAll paths from {source} to {merge}:")
        try:
            all_paths = list(nx.all_simple_paths(G, source, merge))
            for p in all_paths:
                print(f"  {' → '.join(p)}")
        except:
            print("  (no paths)")
        
        print(f"\nPaths starting with {source}→{target}:")
        if target in G:
            try:
                paths_via_target = [p for p in all_paths if len(p) > 1 and p[1] == target]
                for p in paths_via_target:
                    print(f"  {' → '.join(p)}")
            except:
                pass
        
        break

print("\nQuestion: What are we trying to isolate?")
print(f"  Option A: Just edge {source}→{target} (regardless of where it goes after)")
print(f"  Option B: All {source}→{merge} paths that start with {source}→{target}")

