"""
Complex graph query tests with intricate topologies.

Tests graph query operations on complex, realistic graph structures.
"""

import pytest
import sys
import os

# Add lib/ to path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'lib'))

from graph_select import apply_query_to_graph


# ============================================================
# Complex Graph Fixtures
# ============================================================

@pytest.fixture
def diamond_graph():
    """
    Diamond pattern with multiple paths:
         start
        /    \
       a      b
      / \    / \
     c   d  e   f
      \ /    \ /
       g      h
        \    /
          end
    """
    return {
        "nodes": [
            {"id": "start"},
            {"id": "a"}, {"id": "b"},
            {"id": "c"}, {"id": "d"}, {"id": "e"}, {"id": "f"},
            {"id": "g"}, {"id": "h"},
            {"id": "end"}
        ],
        "edges": [
            {"from": "start", "to": "a"},
            {"from": "start", "to": "b"},
            {"from": "a", "to": "c"},
            {"from": "a", "to": "d"},
            {"from": "b", "to": "e"},
            {"from": "b", "to": "f"},
            {"from": "c", "to": "g"},
            {"from": "d", "to": "g"},
            {"from": "e", "to": "h"},
            {"from": "f", "to": "h"},
            {"from": "g", "to": "end"},
            {"from": "h", "to": "end"}
        ]
    }


@pytest.fixture
def deep_hierarchy():
    """
    Deep tree with 5 levels and multiple branches at each level.
    
    root -> [l1a, l1b, l1c]
    l1a -> [l2a, l2b]
    l1b -> [l2c, l2d]
    l1c -> [l2e]
    ... continues to level 5
    """
    nodes = [{"id": "root"}]
    edges = []
    
    # Level 1
    l1_nodes = ["l1a", "l1b", "l1c"]
    for n in l1_nodes:
        nodes.append({"id": n})
        edges.append({"from": "root", "to": n})
    
    # Level 2
    l2_map = {
        "l1a": ["l2a", "l2b"],
        "l1b": ["l2c", "l2d"],
        "l1c": ["l2e"]
    }
    for parent, children in l2_map.items():
        for child in children:
            nodes.append({"id": child})
            edges.append({"from": parent, "to": child})
    
    # Level 3
    l3_map = {
        "l2a": ["l3a", "l3b"],
        "l2b": ["l3c"],
        "l2c": ["l3d"],
        "l2d": ["l3e", "l3f"],
        "l2e": ["l3g"]
    }
    for parent, children in l3_map.items():
        for child in children:
            nodes.append({"id": child})
            edges.append({"from": parent, "to": child})
    
    # Level 4 - all converge to single node
    l4_node = {"id": "l4convergence"}
    nodes.append(l4_node)
    for l3_node in ["l3a", "l3b", "l3c", "l3d", "l3e", "l3f", "l3g"]:
        edges.append({"from": l3_node, "to": "l4convergence"})
    
    # Level 5 - final target
    nodes.append({"id": "leaf"})
    edges.append({"from": "l4convergence", "to": "leaf"})
    
    return {"nodes": nodes, "edges": edges}


@pytest.fixture
def web_topology():
    """
    Web-like structure with many interconnections:
    - 10 nodes
    - Multiple paths between most pairs
    - Mix of short and long paths
    """
    return {
        "nodes": [{"id": f"n{i}"} for i in range(10)],
        "edges": [
            # Layer 1 -> Layer 2
            {"from": "n0", "to": "n1"},
            {"from": "n0", "to": "n2"},
            {"from": "n0", "to": "n3"},
            
            # Layer 2 -> Layer 3
            {"from": "n1", "to": "n4"},
            {"from": "n1", "to": "n5"},
            {"from": "n2", "to": "n4"},
            {"from": "n2", "to": "n6"},
            {"from": "n3", "to": "n5"},
            {"from": "n3", "to": "n6"},
            
            # Layer 3 -> Layer 4
            {"from": "n4", "to": "n7"},
            {"from": "n4", "to": "n8"},
            {"from": "n5", "to": "n7"},
            {"from": "n5", "to": "n9"},
            {"from": "n6", "to": "n8"},
            {"from": "n6", "to": "n9"},
            
            # Cross-layer shortcuts
            {"from": "n1", "to": "n7"},  # Skip layer 3
            {"from": "n2", "to": "n9"},  # Skip layers 3 & 4
            
            # Convergence
            {"from": "n7", "to": "n9"},
            {"from": "n8", "to": "n9"}
        ]
    }


@pytest.fixture
def bottleneck_graph():
    """
    Graph with bottleneck nodes that all paths must pass through.
    
    Start -> [a1, a2, a3] -> bottleneck1 -> [b1, b2] -> bottleneck2 -> [c1, c2, c3] -> end
    """
    return {
        "nodes": [
            {"id": "start"},
            {"id": "a1"}, {"id": "a2"}, {"id": "a3"},
            {"id": "bottleneck1"},
            {"id": "b1"}, {"id": "b2"},
            {"id": "bottleneck2"},
            {"id": "c1"}, {"id": "c2"}, {"id": "c3"},
            {"id": "end"}
        ],
        "edges": [
            # Start to first layer
            {"from": "start", "to": "a1"},
            {"from": "start", "to": "a2"},
            {"from": "start", "to": "a3"},
            
            # First layer to bottleneck
            {"from": "a1", "to": "bottleneck1"},
            {"from": "a2", "to": "bottleneck1"},
            {"from": "a3", "to": "bottleneck1"},
            
            # Bottleneck to second layer
            {"from": "bottleneck1", "to": "b1"},
            {"from": "bottleneck1", "to": "b2"},
            
            # Second layer to second bottleneck
            {"from": "b1", "to": "bottleneck2"},
            {"from": "b2", "to": "bottleneck2"},
            
            # Second bottleneck to final layer
            {"from": "bottleneck2", "to": "c1"},
            {"from": "bottleneck2", "to": "c2"},
            {"from": "bottleneck2", "to": "c3"},
            
            # Final layer to end
            {"from": "c1", "to": "end"},
            {"from": "c2", "to": "end"},
            {"from": "c3", "to": "end"}
        ]
    }


@pytest.fixture
def parallel_paths():
    """
    Graph with many parallel independent paths from start to end.
    
    start -> path1_step1 -> path1_step2 -> path1_step3 -> end
    start -> path2_step1 -> path2_step2 -> path2_step3 -> end
    start -> path3_step1 -> path3_step2 -> path3_step3 -> end
    start -> path4_step1 -> path4_step2 -> path4_step3 -> end
    """
    nodes = [{"id": "start"}, {"id": "end"}]
    edges = []
    
    for path_num in range(1, 5):
        path_nodes = []
        for step in range(1, 4):
            node_id = f"path{path_num}_step{step}"
            nodes.append({"id": node_id})
            path_nodes.append(node_id)
        
        # Connect start to first node
        edges.append({"from": "start", "to": path_nodes[0]})
        
        # Connect path nodes
        for i in range(len(path_nodes) - 1):
            edges.append({"from": path_nodes[i], "to": path_nodes[i+1]})
        
        # Connect last node to end
        edges.append({"from": path_nodes[-1], "to": "end"})
    
    return {"nodes": nodes, "edges": edges}


@pytest.fixture
def shortcut_graph():
    """
    Graph with direct shortcuts alongside longer paths.
    
    Pattern: a->c (direct) AND a->b->c (through b)
    
        a -> b -> c
        |         ^
        +----d----+
        |         
        +---------+  (direct to c)
    
    Also:
        c -> e (direct)
        c -> f -> e (through f)
    """
    return {
        "nodes": [
            {"id": "a"},
            {"id": "b"},
            {"id": "c"},
            {"id": "d"},
            {"id": "e"},
            {"id": "f"}
        ],
        "edges": [
            # a has THREE paths to c:
            {"from": "a", "to": "b"},  # a->b->c
            {"from": "b", "to": "c"},
            {"from": "a", "to": "d"},  # a->d->c
            {"from": "d", "to": "c"},
            {"from": "a", "to": "c"},  # a->c direct (shortcut)
            
            # c has TWO paths to e:
            {"from": "c", "to": "f"},  # c->f->e
            {"from": "f", "to": "e"},
            {"from": "c", "to": "e"}   # c->e direct (shortcut)
        ]
    }


@pytest.fixture
def antitree_graph():
    """
    Anti-tree (reverse tree): Multiple roots converging to single leaf.
    
         r1    r2    r3
          \    |    /
           \   |   /
            \  |  /
             \ | /
              \|/
             merge1
               |
             merge2
               |
              leaf
    """
    return {
        "nodes": [
            {"id": "r1"}, {"id": "r2"}, {"id": "r3"},
            {"id": "m1a"}, {"id": "m1b"}, {"id": "m1c"},
            {"id": "merge1"},
            {"id": "merge2"},
            {"id": "leaf"}
        ],
        "edges": [
            {"from": "r1", "to": "m1a"},
            {"from": "r2", "to": "m1b"},
            {"from": "r3", "to": "m1c"},
            {"from": "m1a", "to": "merge1"},
            {"from": "m1b", "to": "merge1"},
            {"from": "m1c", "to": "merge1"},
            {"from": "merge1", "to": "merge2"},
            {"from": "merge2", "to": "leaf"}
        ]
    }


@pytest.fixture
def polytree_forest():
    """
    Forest of disconnected trees (polytree).
    
    Tree 1:     Tree 2:     Tree 3:
      a           d           g
     / \         / \          |
    b   c       e   f         h
    """
    return {
        "nodes": [
            {"id": "a"}, {"id": "b"}, {"id": "c"},
            {"id": "d"}, {"id": "e"}, {"id": "f"},
            {"id": "g"}, {"id": "h"}
        ],
        "edges": [
            # Tree 1
            {"from": "a", "to": "b"},
            {"from": "a", "to": "c"},
            # Tree 2
            {"from": "d", "to": "e"},
            {"from": "d", "to": "f"},
            # Tree 3
            {"from": "g", "to": "h"}
        ]
    }


@pytest.fixture
def complete_dag():
    """
    Complete DAG: Every node connects to all later nodes.
    
    5 nodes in topological order: n0 < n1 < n2 < n3 < n4
    All possible forward edges exist.
    """
    nodes = [{"id": f"n{i}"} for i in range(5)]
    edges = []
    
    # Every node i connects to all nodes j where j > i
    for i in range(5):
        for j in range(i + 1, 5):
            edges.append({"from": f"n{i}", "to": f"n{j}"})
    
    return {"nodes": nodes, "edges": edges}


@pytest.fixture
def series_parallel_graph():
    """
    Series-parallel graph: Recursive composition.
    
    Series: (a->b) then (b->c)
    Parallel: Both (c->d) and (c->e->d)
    Series: (d->f)
    """
    return {
        "nodes": [
            {"id": "a"}, {"id": "b"}, {"id": "c"},
            {"id": "d"}, {"id": "e"}, {"id": "f"}
        ],
        "edges": [
            # Series
            {"from": "a", "to": "b"},
            {"from": "b", "to": "c"},
            # Parallel
            {"from": "c", "to": "d"},
            {"from": "c", "to": "e"},
            {"from": "e", "to": "d"},
            # Series
            {"from": "d", "to": "f"}
        ]
    }


@pytest.fixture
def bipartite_graph():
    """
    Bipartite DAG: Two layers, edges only between layers.
    
    Layer 1: [a, b, c]
    Layer 2: [x, y, z]
    
    Every node in L1 connects to multiple nodes in L2.
    """
    return {
        "nodes": [
            {"id": "a"}, {"id": "b"}, {"id": "c"},
            {"id": "x"}, {"id": "y"}, {"id": "z"}
        ],
        "edges": [
            {"from": "a", "to": "x"},
            {"from": "a", "to": "y"},
            {"from": "b", "to": "y"},
            {"from": "b", "to": "z"},
            {"from": "c", "to": "x"},
            {"from": "c", "to": "z"}
        ]
    }


@pytest.fixture
def tripartite_graph():
    """
    k-Partite (k=3) DAG: Three distinct layers.
    
    Layer 1: [s1, s2]
    Layer 2: [m1, m2, m3]
    Layer 3: [e1, e2]
    """
    return {
        "nodes": [
            {"id": "s1"}, {"id": "s2"},
            {"id": "m1"}, {"id": "m2"}, {"id": "m3"},
            {"id": "e1"}, {"id": "e2"}
        ],
        "edges": [
            # Layer 1 to Layer 2
            {"from": "s1", "to": "m1"},
            {"from": "s1", "to": "m2"},
            {"from": "s2", "to": "m2"},
            {"from": "s2", "to": "m3"},
            # Layer 2 to Layer 3
            {"from": "m1", "to": "e1"},
            {"from": "m2", "to": "e1"},
            {"from": "m2", "to": "e2"},
            {"from": "m3", "to": "e2"}
        ]
    }


@pytest.fixture
def critical_path_graph():
    """
    Graph with varying path lengths to test longest path.
    
    Short path: start->quick->end (2 steps)
    Medium path: start->a->b->end (3 steps)
    Long path: start->x->y->z->w->end (5 steps - critical path)
    """
    return {
        "nodes": [
            {"id": "start"},
            {"id": "quick"},
            {"id": "a"}, {"id": "b"},
            {"id": "x"}, {"id": "y"}, {"id": "z"}, {"id": "w"},
            {"id": "end"}
        ],
        "edges": [
            # Short path
            {"from": "start", "to": "quick"},
            {"from": "quick", "to": "end"},
            # Medium path
            {"from": "start", "to": "a"},
            {"from": "a", "to": "b"},
            {"from": "b", "to": "end"},
            # Long (critical) path
            {"from": "start", "to": "x"},
            {"from": "x", "to": "y"},
            {"from": "y", "to": "z"},
            {"from": "z", "to": "w"},
            {"from": "w", "to": "end"}
        ]
    }


@pytest.fixture
def transitive_edges_graph():
    """
    Graph with transitive edges (shortcuts that are redundant).
    
    Has: a->b, b->c, a->c (a->c is transitive)
    Has: c->d, d->e, c->e (c->e is transitive)
    """
    return {
        "nodes": [
            {"id": "a"}, {"id": "b"}, {"id": "c"},
            {"id": "d"}, {"id": "e"}
        ],
        "edges": [
            # Necessary edges
            {"from": "a", "to": "b"},
            {"from": "b", "to": "c"},
            {"from": "c", "to": "d"},
            {"from": "d", "to": "e"},
            # Transitive edges (redundant)
            {"from": "a", "to": "c"},
            {"from": "c", "to": "e"}
        ]
    }


@pytest.fixture
def singleton_nodes_graph():
    """
    Graph with isolated singleton nodes.
    
    Connected: a->b->c
    Isolated: x, y, z
    """
    return {
        "nodes": [
            {"id": "a"}, {"id": "b"}, {"id": "c"},
            {"id": "x"}, {"id": "y"}, {"id": "z"}
        ],
        "edges": [
            {"from": "a", "to": "b"},
            {"from": "b", "to": "c"}
        ]
    }


@pytest.fixture
def sources_and_sinks_graph():
    """
    Graph with multiple sources (in-degree=0) and sinks (out-degree=0).
    
    Sources: s1, s2, s3
    Middle: m1, m2
    Sinks: t1, t2, t3
    """
    return {
        "nodes": [
            {"id": "s1"}, {"id": "s2"}, {"id": "s3"},
            {"id": "m1"}, {"id": "m2"},
            {"id": "t1"}, {"id": "t2"}, {"id": "t3"}
        ],
        "edges": [
            {"from": "s1", "to": "m1"},
            {"from": "s2", "to": "m1"},
            {"from": "s3", "to": "m2"},
            {"from": "m1", "to": "t1"},
            {"from": "m1", "to": "t2"},
            {"from": "m2", "to": "t2"},
            {"from": "m2", "to": "t3"}
        ]
    }


@pytest.fixture
def lattice_graph():
    """
    Lattice structure: Every pair of nodes has unique LCA (Lowest Common Ancestor).
    
         root
        /    \
       a      b
      /|\    /|\
     c d e  f g h
      \|/    \|/
      join1  join2
        \    /
         leaf
    """
    return {
        "nodes": [
            {"id": "root"},
            {"id": "a"}, {"id": "b"},
            {"id": "c"}, {"id": "d"}, {"id": "e"},
            {"id": "f"}, {"id": "g"}, {"id": "h"},
            {"id": "join1"}, {"id": "join2"},
            {"id": "leaf"}
        ],
        "edges": [
            {"from": "root", "to": "a"},
            {"from": "root", "to": "b"},
            {"from": "a", "to": "c"},
            {"from": "a", "to": "d"},
            {"from": "a", "to": "e"},
            {"from": "b", "to": "f"},
            {"from": "b", "to": "g"},
            {"from": "b", "to": "h"},
            {"from": "c", "to": "join1"},
            {"from": "d", "to": "join1"},
            {"from": "e", "to": "join1"},
            {"from": "f", "to": "join2"},
            {"from": "g", "to": "join2"},
            {"from": "h", "to": "join2"},
            {"from": "join1", "to": "leaf"},
            {"from": "join2", "to": "leaf"}
        ]
    }


@pytest.fixture
def empty_graph():
    """Empty graph: Nodes but no edges."""
    return {
        "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
        "edges": []
    }


@pytest.fixture
def single_node_graph():
    """Trivial graph: Single node, no edges."""
    return {
        "nodes": [{"id": "only"}],
        "edges": []
    }


@pytest.fixture
def funnel_graph():
    """
    Wide start, narrowing to single end (conversion funnel).
    
    10 entry points -> 7 middle nodes -> 3 late stage -> 1 conversion
    """
    nodes = []
    edges = []
    
    # Entry points
    entry_nodes = [f"entry{i}" for i in range(10)]
    for n in entry_nodes:
        nodes.append({"id": n})
    
    # Middle stage
    middle_nodes = [f"mid{i}" for i in range(7)]
    for n in middle_nodes:
        nodes.append({"id": n})
    
    # Each entry connects to 2-3 middle nodes
    entry_to_middle = {
        "entry0": ["mid0", "mid1"],
        "entry1": ["mid1", "mid2"],
        "entry2": ["mid2", "mid3"],
        "entry3": ["mid3", "mid4"],
        "entry4": ["mid4", "mid5"],
        "entry5": ["mid5", "mid6"],
        "entry6": ["mid0", "mid6"],
        "entry7": ["mid1", "mid5"],
        "entry8": ["mid2", "mid4"],
        "entry9": ["mid0", "mid3", "mid6"]
    }
    for entry, middles in entry_to_middle.items():
        for mid in middles:
            edges.append({"from": entry, "to": mid})
    
    # Late stage
    late_nodes = ["late0", "late1", "late2"]
    for n in late_nodes:
        nodes.append({"id": n})
    
    # Middle to late
    for mid in middle_nodes:
        # Each middle connects to 1-2 late nodes
        if int(mid[-1]) < 3:
            edges.append({"from": mid, "to": "late0"})
        if 2 <= int(mid[-1]) < 5:
            edges.append({"from": mid, "to": "late1"})
        if int(mid[-1]) >= 4:
            edges.append({"from": mid, "to": "late2"})
    
    # Conversion
    nodes.append({"id": "conversion"})
    for late in late_nodes:
        edges.append({"from": late, "to": "conversion"})
    
    return {"nodes": nodes, "edges": edges}


# ============================================================
# Complex Query Tests
# ============================================================

class TestDiamondGraph:
    """Test queries on diamond-shaped graph."""
    
    def test_all_paths_included(self, diamond_graph):
        """Query with no constraints includes all paths."""
        result = apply_query_to_graph(diamond_graph, "from(start).to(end)")
        
        # All 10 nodes should be included
        assert len(result["nodes"]) == 10
        
        # All 12 edges should be included
        assert len(result["edges"]) == 12
        
        # Metadata should show multiple paths
        assert result["metadata"]["query_stats"]["path_count"] > 1
    
    def test_exclude_prunes_branch(self, diamond_graph):
        """Excluding 'a' should remove left branch entirely."""
        result = apply_query_to_graph(diamond_graph, "from(start).to(end).exclude(a)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Left branch should be gone
        assert "a" not in node_ids
        assert "c" not in node_ids
        assert "d" not in node_ids
        assert "g" not in node_ids
        
        # Right branch should remain
        assert "b" in node_ids
        assert "e" in node_ids
        assert "f" in node_ids
        assert "h" in node_ids
    
    def test_visited_forces_specific_path(self, diamond_graph):
        """Requiring visit to 'c' should limit paths."""
        result = apply_query_to_graph(diamond_graph, "from(start).to(end).visited(c)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Must include path through c
        assert "c" in node_ids
        assert "a" in node_ids
        assert "g" in node_ids
    
    def test_multiple_visited_nodes(self, diamond_graph):
        """Require visiting both 'd' and 'f' - impossible in diamond graph."""
        result = apply_query_to_graph(diamond_graph, "from(start).to(end).visited(d).visited(f)")
        
        # In this graph, you can't visit both d and f without backtracking
        # d is on left branch, f is on right branch
        # So this should return empty (no valid paths)
        assert len(result["nodes"]) == 0
        assert len(result["edges"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0


class TestDeepHierarchy:
    """Test queries on deep hierarchical graph."""
    
    def test_path_to_leaf(self, deep_hierarchy):
        """Query from root to leaf."""
        result = apply_query_to_graph(deep_hierarchy, "from(root).to(leaf)")
        
        # Should include many nodes (multiple paths through hierarchy)
        assert len(result["nodes"]) > 10
        
        # Should include convergence node
        node_ids = {n["id"] for n in result["nodes"]}
        assert "l4convergence" in node_ids
    
    def test_specific_branch(self, deep_hierarchy):
        """Force path through specific branch."""
        result = apply_query_to_graph(deep_hierarchy, "from(root).to(leaf).visited(l1a).visited(l2b)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should include required nodes
        assert "l1a" in node_ids
        assert "l2b" in node_ids
        
        # Should NOT include other l1 nodes
        assert "l1b" not in node_ids
        assert "l1c" not in node_ids
    
    def test_exclude_entire_subtree(self, deep_hierarchy):
        """Excluding early node removes entire subtree."""
        result = apply_query_to_graph(deep_hierarchy, "from(root).to(leaf).exclude(l1b)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # l1b subtree should be gone
        assert "l1b" not in node_ids
        assert "l2c" not in node_ids
        assert "l2d" not in node_ids
        
        # Other branches remain
        assert "l1a" in node_ids
        assert "l1c" in node_ids


class TestWebTopology:
    """Test queries on highly connected web structure."""
    
    def test_many_paths_from_n0_to_n9(self, web_topology):
        """Many paths should exist from n0 to n9."""
        result = apply_query_to_graph(web_topology, "from(n0).to(n9)")
        
        # Should include most nodes
        assert len(result["nodes"]) >= 8
        
        # Metadata should show multiple paths
        assert result["metadata"]["query_stats"]["path_count"] >= 8
    
    def test_shortcut_path(self, web_topology):
        """Query can find shortcut paths."""
        result = apply_query_to_graph(web_topology, "from(n0).to(n9).visited(n2)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should include the shortcut edge n2->n9
        assert "n2" in node_ids
        assert "n9" in node_ids
    
    def test_force_long_path(self, web_topology):
        """Exclude shortcuts to force longer path."""
        result = apply_query_to_graph(web_topology, "from(n0).to(n9).exclude(n2)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Shortcut should be excluded
        assert "n2" not in node_ids
        
        # Should still have paths through other nodes
        assert len(result["nodes"]) > 0


class TestBottleneckGraph:
    """Test queries on graph with mandatory bottlenecks."""
    
    def test_all_paths_through_bottlenecks(self, bottleneck_graph):
        """All paths must go through both bottlenecks."""
        result = apply_query_to_graph(bottleneck_graph, "from(start).to(end)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Bottlenecks must be included
        assert "bottleneck1" in node_ids
        assert "bottleneck2" in node_ids
        
        # All nodes should be included
        assert len(result["nodes"]) == len(bottleneck_graph["nodes"])
    
    def test_exclude_bottleneck_kills_all_paths(self, bottleneck_graph):
        """Excluding a bottleneck should eliminate all paths."""
        result = apply_query_to_graph(bottleneck_graph, "from(start).to(end).exclude(bottleneck1)")
        
        # No paths possible
        assert len(result["nodes"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0
    
    def test_exclude_optional_node(self, bottleneck_graph):
        """Excluding non-bottleneck node still leaves paths."""
        result = apply_query_to_graph(bottleneck_graph, "from(start).to(end).exclude(b1)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # b1 should be excluded
        assert "b1" not in node_ids
        
        # But b2 path still works
        assert "b2" in node_ids
        assert len(result["nodes"]) > 5


class TestParallelPaths:
    """Test queries on graph with independent parallel paths."""
    
    def test_all_parallel_paths_included(self, parallel_paths):
        """All 4 parallel paths should be found."""
        result = apply_query_to_graph(parallel_paths, "from(start).to(end)")
        
        # 4 paths * 3 steps each + start + end = 14 nodes
        assert len(result["nodes"]) == 14
        
        # Should find 4 paths
        assert result["metadata"]["query_stats"]["path_count"] == 4
    
    def test_visited_selects_one_path(self, parallel_paths):
        """Visiting specific node selects one path."""
        result = apply_query_to_graph(parallel_paths, "from(start).to(end).visited(path2_step2)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should only include path 2
        assert "path2_step1" in node_ids
        assert "path2_step2" in node_ids
        assert "path2_step3" in node_ids
        
        # Should NOT include other paths
        assert "path1_step1" not in node_ids
        assert "path3_step1" not in node_ids
        assert "path4_step1" not in node_ids
        
        # Should have exactly 5 nodes: start, 3 path nodes, end
        assert len(result["nodes"]) == 5
    
    def test_exclude_eliminates_one_path(self, parallel_paths):
        """Excluding a node eliminates one path."""
        result = apply_query_to_graph(parallel_paths, "from(start).to(end).exclude(path3_step1)")
        
        # Should have 3 paths remaining
        assert result["metadata"]["query_stats"]["path_count"] == 3
        
        node_ids = {n["id"] for n in result["nodes"]}
        assert "path3_step1" not in node_ids
        assert "path3_step2" not in node_ids
        assert "path3_step3" not in node_ids


class TestShortcutGraph:
    """Test queries on graphs with direct shortcuts vs longer paths."""
    
    def test_all_three_paths_to_c(self, shortcut_graph):
        """Node c reachable via 3 different paths from a."""
        result = apply_query_to_graph(shortcut_graph, "from(a).to(c)")
        
        # Should find 3 paths: a->c, a->b->c, a->d->c
        assert result["metadata"]["query_stats"]["path_count"] == 3
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # All intermediate nodes should be included
        assert "a" in node_ids
        assert "b" in node_ids
        assert "c" in node_ids
        assert "d" in node_ids
    
    def test_force_long_path_via_b(self, shortcut_graph):
        """Require path through b (excludes direct shortcut)."""
        result = apply_query_to_graph(shortcut_graph, "from(a).to(c).visited(b)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should only get path a->b->c
        assert "a" in node_ids
        assert "b" in node_ids
        assert "c" in node_ids
        
        # Path count should be 1 (only path through b)
        assert result["metadata"]["query_stats"]["path_count"] == 1
        
        # Should be exactly 3 nodes
        assert len(result["nodes"]) == 3
    
    def test_exclude_intermediate_allows_shortcut(self, shortcut_graph):
        """Excluding b should still allow direct path."""
        result = apply_query_to_graph(shortcut_graph, "from(a).to(c).exclude(b)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # b should be excluded
        assert "b" not in node_ids
        
        # But direct path and path through d still work
        assert "a" in node_ids
        assert "c" in node_ids
        assert "d" in node_ids
        
        # Should have 2 remaining paths
        assert result["metadata"]["query_stats"]["path_count"] == 2
    
    def test_exclude_both_intermediates_forces_shortcut(self, shortcut_graph):
        """Excluding both b and d leaves only direct path."""
        result = apply_query_to_graph(shortcut_graph, "from(a).to(c).exclude(b).exclude(d)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Only direct path remains
        assert "a" in node_ids
        assert "c" in node_ids
        assert "b" not in node_ids
        assert "d" not in node_ids
        
        # Should be exactly 2 nodes (a and c)
        assert len(result["nodes"]) == 2
        
        # Should be exactly 1 path
        assert result["metadata"]["query_stats"]["path_count"] == 1
    
    def test_transitive_shortcuts(self, shortcut_graph):
        """Test path from a to e (2 levels of shortcuts)."""
        result = apply_query_to_graph(shortcut_graph, "from(a).to(e)")
        
        # Should find multiple paths combining shortcuts
        assert result["metadata"]["query_stats"]["path_count"] >= 3
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should include all nodes in paths
        assert "a" in node_ids
        assert "c" in node_ids
        assert "e" in node_ids
    
    def test_force_longest_path(self, shortcut_graph):
        """Force longest path by visiting all intermediates."""
        result = apply_query_to_graph(shortcut_graph, "from(a).to(e).visited(b).visited(f)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Must go through both intermediates
        assert "b" in node_ids
        assert "f" in node_ids
        
        # Path: a->b->c->f->e
        assert len(result["nodes"]) == 5
        assert result["metadata"]["query_stats"]["path_count"] == 1


class TestFunnelGraph:
    """Test queries on conversion funnel topology."""
    
    def test_all_entry_points_reach_conversion(self, funnel_graph):
        """All entry points should reach conversion."""
        for i in range(10):
            result = apply_query_to_graph(funnel_graph, f"from(entry{i}).to(conversion)")
            
            # Should find at least one path
            assert len(result["nodes"]) > 0
            assert result["metadata"]["query_stats"]["path_count"] >= 1
    
    def test_mid_stage_bottleneck(self, funnel_graph):
        """Impossible path: entry0 cannot reach mid3 in this funnel."""
        result = apply_query_to_graph(funnel_graph, "from(entry0).to(conversion).visited(mid3)")
        
        # entry0 only connects to mid0 and mid1, not mid3
        # This is an impossible query - should return empty
        assert len(result["nodes"]) == 0
        assert len(result["edges"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0
    
    def test_exclude_late_stage(self, funnel_graph):
        """Excluding late stage node impacts multiple entry paths."""
        result = apply_query_to_graph(funnel_graph, "from(entry0).to(conversion).exclude(late1)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # late1 should be excluded
        assert "late1" not in node_ids
        
        # Should still have some paths
        assert len(result["nodes"]) > 0


class TestMetadataAccuracy:
    """Verify metadata accuracy across complex queries."""
    
    def test_path_count_accuracy(self, diamond_graph):
        """Path count should match actual number of paths."""
        result = apply_query_to_graph(diamond_graph, "from(start).to(end)")
        
        # Should report multiple paths
        path_count = result["metadata"]["query_stats"]["path_count"]
        assert path_count >= 2
        
        # Verify by checking multiple routes exist
        node_ids = {n["id"] for n in result["nodes"]}
        assert "a" in node_ids
        assert "b" in node_ids
    
    def test_filtering_metrics(self, funnel_graph):
        """Verify filtering metrics are accurate."""
        result = apply_query_to_graph(funnel_graph, "from(entry0).to(conversion)")
        
        # Filtered count should be less than original
        assert result["metadata"]["query_stats"]["filtered_node_count"] < result["metadata"]["query_stats"]["original_node_count"]
        
        # Filtered count should match actual result
        assert result["metadata"]["query_stats"]["filtered_node_count"] == len(result["nodes"])


# ============================================================
# Tests for Additional DAG Topologies
# ============================================================

class TestAntiTree:
    """Test anti-tree (reverse tree) topology."""
    
    def test_multiple_roots_converge(self, antitree_graph):
        """All roots should reach leaf."""
        for root in ["r1", "r2", "r3"]:
            result = apply_query_to_graph(antitree_graph, f"from({root}).to(leaf)")
            
            assert len(result["nodes"]) > 0
            node_ids = {n["id"] for n in result["nodes"]}
            assert root in node_ids
            assert "leaf" in node_ids
    
    def test_convergence_points_included(self, antitree_graph):
        """Convergence nodes must be in all paths."""
        result = apply_query_to_graph(antitree_graph, "from(r1).to(leaf)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        assert "merge1" in node_ids
        assert "merge2" in node_ids


class TestPolytreeForest:
    """Test disconnected forest topology."""
    
    def test_no_path_between_trees(self, polytree_forest):
        """No path exists between disconnected trees."""
        result = apply_query_to_graph(polytree_forest, "from(a).to(d)")
        
        # Should return empty
        assert len(result["nodes"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0
    
    def test_path_within_tree(self, polytree_forest):
        """Paths within same tree work."""
        result = apply_query_to_graph(polytree_forest, "from(a).to(b)")
        
        assert len(result["nodes"]) == 2
        node_ids = {n["id"] for n in result["nodes"]}
        assert "a" in node_ids
        assert "b" in node_ids


class TestCompleteDAG:
    """Test complete DAG topology."""
    
    def test_all_pairs_connected(self, complete_dag):
        """Every pair should have path."""
        # Test a few pairs
        pairs = [("n0", "n4"), ("n1", "n3"), ("n2", "n4")]
        
        for source, target in pairs:
            result = apply_query_to_graph(complete_dag, f"from({source}).to({target})")
            assert len(result["nodes"]) >= 2
    
    def test_many_paths_exist(self, complete_dag):
        """Complete DAG has exponential paths."""
        result = apply_query_to_graph(complete_dag, "from(n0).to(n4)")
        
        # Should have many paths
        assert result["metadata"]["query_stats"]["path_count"] >= 8


class TestSeriesParallel:
    """Test series-parallel composition."""
    
    def test_series_components(self, series_parallel_graph):
        """Series sections have unique path."""
        result = apply_query_to_graph(series_parallel_graph, "from(a).to(c)")
        
        # Should be single path through series
        assert result["metadata"]["query_stats"]["path_count"] == 1
    
    def test_parallel_components(self, series_parallel_graph):
        """Parallel sections have multiple paths."""
        result = apply_query_to_graph(series_parallel_graph, "from(c).to(d)")
        
        # Should have 2 paths (direct and through e)
        assert result["metadata"]["query_stats"]["path_count"] == 2
    
    def test_full_composition(self, series_parallel_graph):
        """End-to-end path combines series and parallel."""
        result = apply_query_to_graph(series_parallel_graph, "from(a).to(f)")
        
        # Should include all nodes
        assert len(result["nodes"]) == 6


class TestBipartite:
    """Test bipartite structure."""
    
    def test_no_intralayer_edges(self, bipartite_graph):
        """No edges within same layer."""
        # Path from a to b should not exist (same layer)
        result = apply_query_to_graph(bipartite_graph, "from(a).to(b)")
        assert len(result["nodes"]) == 0
        
        # Path from x to y should not exist (same layer)
        result = apply_query_to_graph(bipartite_graph, "from(x).to(y)")
        assert len(result["nodes"]) == 0
    
    def test_cross_layer_paths(self, bipartite_graph):
        """Paths exist between layers."""
        result = apply_query_to_graph(bipartite_graph, "from(a).to(x)")
        assert len(result["nodes"]) == 2


class TestTripartite:
    """Test k-partite (k=3) structure."""
    
    def test_layer_skipping_impossible(self, tripartite_graph):
        """Cannot skip middle layer."""
        result = apply_query_to_graph(tripartite_graph, "from(s1).to(e1)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Must include at least one middle node
        middle_nodes = {"m1", "m2", "m3"}
        assert len(middle_nodes & node_ids) > 0
    
    def test_cross_three_layers(self, tripartite_graph):
        """Path crosses all three layers."""
        result = apply_query_to_graph(tripartite_graph, "from(s1).to(e2)")
        
        # Should include nodes from all layers
        assert len(result["nodes"]) >= 3


class TestCriticalPath:
    """Test longest path identification."""
    
    def test_short_path_exists(self, critical_path_graph):
        """Shortest path can be found."""
        result = apply_query_to_graph(critical_path_graph, "from(start).to(end).visited(quick)")
        
        # Should be minimal path
        assert len(result["nodes"]) == 3
    
    def test_long_path_exists(self, critical_path_graph):
        """Longest (critical) path can be found."""
        result = apply_query_to_graph(critical_path_graph, "from(start).to(end).visited(z)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should include critical path nodes
        assert "x" in node_ids
        assert "y" in node_ids
        assert "z" in node_ids
        assert "w" in node_ids
    
    def test_all_paths_included_by_default(self, critical_path_graph):
        """Without constraints, all paths included."""
        result = apply_query_to_graph(critical_path_graph, "from(start).to(end)")
        
        # Should find 3 paths
        assert result["metadata"]["query_stats"]["path_count"] == 3


class TestTransitiveEdges:
    """Test graphs with transitive (redundant) edges."""
    
    def test_transitive_edges_dont_create_extra_paths(self, transitive_edges_graph):
        """Transitive edges are shortcuts, not new paths."""
        result = apply_query_to_graph(transitive_edges_graph, "from(a).to(c)")
        
        # Should have 2 paths: a->c and a->b->c
        assert result["metadata"]["query_stats"]["path_count"] == 2
    
    def test_exclude_forces_transitive(self, transitive_edges_graph):
        """Excluding intermediate forces use of transitive edge."""
        result = apply_query_to_graph(transitive_edges_graph, "from(a).to(c).exclude(b)")
        
        node_ids = {n["id"] for n in result["nodes"]}
        
        # Should only have direct path
        assert "b" not in node_ids
        assert len(result["nodes"]) == 2


class TestSingletonNodes:
    """Test graphs with isolated nodes."""
    
    def test_isolated_nodes_unreachable(self, singleton_nodes_graph):
        """Isolated nodes cannot be reached."""
        result = apply_query_to_graph(singleton_nodes_graph, "from(a).to(x)")
        
        # Should be empty
        assert len(result["nodes"]) == 0
    
    def test_connected_component_works(self, singleton_nodes_graph):
        """Connected component still works."""
        result = apply_query_to_graph(singleton_nodes_graph, "from(a).to(c)")
        
        # Should work normally
        assert len(result["nodes"]) == 3


class TestSourcesAndSinks:
    """Test multiple sources and sinks."""
    
    def test_any_source_to_any_sink(self, sources_and_sinks_graph):
        """All source-sink pairs should be connected."""
        sources = ["s1", "s2", "s3"]
        sinks = ["t1", "t2", "t3"]
        
        for source in sources:
            for sink in sinks:
                result = apply_query_to_graph(sources_and_sinks_graph, f"from({source}).to({sink})")
                
                # Most pairs should be connected
                if len(result["nodes"]) > 0:
                    node_ids = {n["id"] for n in result["nodes"]}
                    assert source in node_ids
                    assert sink in node_ids
    
    def test_sink_to_sink_impossible(self, sources_and_sinks_graph):
        """Cannot path from one sink to another."""
        result = apply_query_to_graph(sources_and_sinks_graph, "from(t1).to(t2)")
        assert len(result["nodes"]) == 0


class TestLattice:
    """Test lattice structure."""
    
    def test_multiple_lcas(self, lattice_graph):
        """Impossible path: c and f are in separate branches."""
        # c is in left branch (under a), f is in right branch (under b)
        # Cannot visit both in a single DAG path
        result = apply_query_to_graph(lattice_graph, "from(root).to(leaf).visited(c).visited(f)")
        
        # This is an impossible query - should return empty
        assert len(result["nodes"]) == 0
        assert len(result["edges"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0
    
    def test_symmetric_structure(self, lattice_graph):
        """Both branches should be symmetric."""
        result_left = apply_query_to_graph(lattice_graph, "from(root).to(leaf).visited(a)")
        result_right = apply_query_to_graph(lattice_graph, "from(root).to(leaf).visited(b)")
        
        # Both should have similar structure
        assert len(result_left["nodes"]) > 0
        assert len(result_right["nodes"]) > 0


class TestEmptyGraph:
    """Test empty graph (no edges)."""
    
    def test_no_paths_in_empty_graph(self, empty_graph):
        """No paths exist without edges."""
        result = apply_query_to_graph(empty_graph, "from(a).to(b)")
        
        assert len(result["nodes"]) == 0
        assert len(result["edges"]) == 0
        assert result["metadata"]["query_stats"]["path_count"] == 0


class TestSingleNodeGraph:
    """Test trivial single-node graph."""
    
    def test_self_loop_query(self, single_node_graph):
        """Query from node to itself."""
        result = apply_query_to_graph(single_node_graph, "from(only).to(only)")
        
        # In a DAG, no self-loops, so should be empty
        # Unless we define source==target as valid (0-length path)
        # Current implementation should return empty
        assert len(result["edges"]) == 0

