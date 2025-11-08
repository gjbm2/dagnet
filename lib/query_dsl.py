"""
Query DSL Parser and Validator

Schema Authority: /graph-editor/public/schemas/query-dsl-1.0.0.json
Valid Functions: ["from", "to", "visited", "visitedAny", "exclude", "context", "case"]

Grammar:
    query          ::= from-clause to-clause constraint*
    from-clause    ::= "from(" node-id ")"
    to-clause      ::= "to(" node-id ")"
    constraint     ::= exclude-clause | visited-clause | context-clause | case-clause
    
    exclude-clause    ::= ".exclude(" node-list ")"
    visited-clause    ::= ".visited(" node-list ")"
    visitedAny-clause ::= ".visitedAny(" node-list ")"
    context-clause ::= ".context(" key ":" value ")"
    case-clause    ::= ".case(" key ":" value ")"
    
    node-list      ::= node-id ("," node-id)*
    node-id        ::= [a-z0-9_-]+
    key            ::= [a-z0-9_-]+
    value          ::= [a-z0-9_-]+

Examples:
    "from(homepage).to(checkout)"
    "from(homepage).to(checkout).exclude(back-button)"
    "from(product-view).to(checkout).visited(add-to-cart)"
    "from(homepage).to(checkout).context(device:mobile)"
    "from(homepage).to(checkout).case(onboarding-test:treatment)"
    "from(a).to(b).visitedAny(x,y)"
    "from(start).to(end).visited(checkpoint).exclude(detour-a,detour-b)"
"""

import re
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass


@dataclass
class KeyValuePair:
    """Key-value pair for context or case filters."""
    key: str
    value: str


@dataclass
class ParsedQuery:
    """
    Parsed query DSL expression per query-dsl-1.0.0.json schema.
    
    Properties:
    - Order-independent: .exclude(A,B) ≡ .exclude(B,A)
    - Idempotent: .exclude(A).exclude(A) ≡ .exclude(A)
    - Composable: Constraints are logically ANDed
    
    Schema authority: /graph-editor/public/schemas/query-dsl-1.0.0.json
    Valid functions: ["from", "to", "visited", "visitedAny", "exclude", "context", "case"]
    """
    from_node: str              # Source node ID
    to_node: str                # Target node ID
    exclude: List[str]          # Nodes to exclude from path (AND)
    visited: List[str]          # Nodes that must be visited (AND)
    visited_any: List[List[str]]# Groups where at least one must be visited (OR per group)
    context: List[KeyValuePair] # Context filters (e.g., device:mobile)
    cases: List[KeyValuePair]   # Case/variant filters (e.g., test-id:variant)
    
    @property
    def raw(self) -> str:
        """Reconstruct query string from parsed components."""
        parts = [f"from({self.from_node})", f"to({self.to_node})"]
        
        if self.exclude:
            parts.append(f"exclude({','.join(self.exclude)})")
        
        if self.visited:
            parts.append(f"visited({','.join(self.visited)})")
        
        for group in self.visited_any:
            if group:
                parts.append(f"visitedAny({','.join(group)})")
        
        for ctx in self.context:
            parts.append(f"context({ctx.key}:{ctx.value})")
        
        for case in self.cases:
            parts.append(f"case({case.key}:{case.value})")
        
        return ".".join(parts)


class QueryParseError(Exception):
    """Raised when query string is invalid."""
    pass


def parse_query(query: str) -> ParsedQuery:
    """
    Parse query DSL string into structured components.
    
    Args:
        query: Query string (e.g., "from(a).to(b).exclude(c)")
    
    Returns:
        ParsedQuery with extracted components
    
    Raises:
        QueryParseError: If query is malformed
    
    Examples:
        >>> q = parse_query("from(homepage).to(checkout)")
        >>> q.from_node
        'homepage'
        >>> q.to_node
        'checkout'
        
        >>> q = parse_query("from(a).to(b).exclude(c,d).visited(e)")
        >>> q.exclude
        ['c', 'd']
        >>> q.visited
        ['e']
    """
    
    # Validate basic structure
    if not query or not isinstance(query, str):
        raise QueryParseError("Query must be a non-empty string")
    
    # Extract from() and to()
    from_match = re.search(r'from\(([a-z0-9_-]+)\)', query)
    to_match = re.search(r'to\(([a-z0-9_-]+)\)', query)
    
    if not from_match:
        raise QueryParseError("Query must contain 'from(node-id)'")
    if not to_match:
        raise QueryParseError("Query must contain 'to(node-id)'")
    
    from_node = from_match.group(1)
    to_node = to_match.group(1)
    
    # Extract constraints
    exclude = _extract_node_list(query, 'exclude')
    visited = _extract_node_list(query, 'visited')
    visited_any = _extract_node_groups(query, 'visitedAny')
    context = _extract_key_value_pairs(query, 'context')
    cases = _extract_key_value_pairs(query, 'case')
    
    return ParsedQuery(
        from_node=from_node,
        to_node=to_node,
        exclude=exclude,
        visited=visited,
        visited_any=visited_any,
        context=context,
        cases=cases
    )


def _extract_node_list(query: str, constraint_type: str) -> List[str]:
    """
    Extract node list from constraint clause.
    
    Examples:
        _extract_node_list("...exclude(a,b,c)...", "exclude") → ["a", "b", "c"]
        _extract_node_list("...visited(x)...", "visited") → ["x"]
    """
    pattern = rf'{constraint_type}\(([a-z0-9_,-]+)\)'
    matches = re.findall(pattern, query)
    
    nodes = []
    for match in matches:
        nodes.extend([n.strip() for n in match.split(',')])
    
    # Remove duplicates while preserving order
    seen = set()
    result = []
    for node in nodes:
        if node not in seen:
            seen.add(node)
            result.append(node)
    
    return result


def _extract_key_value_pairs(query: str, function_type: str) -> List[KeyValuePair]:
    """
    Extract key:value pairs from case() or context() functions.
    
    Examples:
        _extract_key_value_pairs("...case(test-1:treatment)...", "case") 
            → [KeyValuePair("test-1", "treatment")]
        _extract_key_value_pairs("...context(device:mobile)...", "context")
            → [KeyValuePair("device", "mobile")]
    """
    pattern = rf'{function_type}\(([a-z0-9_-]+):([a-z0-9_-]+)\)'
    matches = re.findall(pattern, query)
    
    return [KeyValuePair(key=m[0], value=m[1]) for m in matches]


def _extract_node_groups(query: str, function_type: str) -> List[List[str]]:
    """
    Extract OR-groups from DSL functions like visitedAny(a,b).
    Returns list of groups; each group is a list of node ids.
    """
    pattern = rf'{function_type}\(([a-z0-9_,-]+)\)'
    matches = re.findall(pattern, query)
    groups: List[List[str]] = []
    for m in matches:
        nodes = []
        seen = set()
        for n in [x.strip() for x in m.split(',') if x.strip()]:
            if n not in seen:
                seen.add(n)
                nodes.append(n)
        groups.append(nodes)
    return groups


def validate_query(
    query: str,
    available_nodes: Optional[List[str]] = None
) -> Tuple[bool, Optional[str]]:
    """
    Validate query string.
    
    Args:
        query: Query string to validate
        available_nodes: List of valid node IDs (optional)
    
    Returns:
        (is_valid, error_message)
    
    Examples:
        >>> validate_query("from(a).to(b)")
        (True, None)
        
        >>> validate_query("invalid")
        (False, "Query must contain 'from(node-id)'")
    """
    
    try:
        parsed = parse_query(query)
    except QueryParseError as e:
        return False, str(e)
    
    # Validate node references
    if available_nodes is not None:
        node_set = set(available_nodes)
        all_refs = [parsed.from_node, parsed.to_node] + parsed.exclude + parsed.visited
        
        for node_id in all_refs:
            if node_id not in node_set:
                return False, f"Node not found: {node_id}"
        
        # Check logical constraints
        if parsed.from_node in parsed.exclude:
            return False, f"Cannot exclude source node: {parsed.from_node}"
        
        if parsed.to_node in parsed.exclude:
            return False, f"Cannot exclude target node: {parsed.to_node}"
    
    return True, None

