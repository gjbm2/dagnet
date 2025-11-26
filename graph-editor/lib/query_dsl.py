"""
Query DSL Parser and Validator

Schema Authority: /graph-editor/public/schemas/query-dsl-1.0.0.json
Valid Functions: ["from", "to", "visited", "visitedAny", "exclude", "context", "contextAny", "window", "case", "minus", "plus"]

Grammar:
    query          ::= [from-clause] [to-clause] constraint*
    from-clause    ::= "from(" node-id ")"
    to-clause      ::= "to(" node-id ")"
    constraint     ::= exclude-clause | visited-clause | visitedAny-clause | context-clause | contextAny-clause | window-clause | case-clause | minus-clause | plus-clause
    
    exclude-clause    ::= ".exclude(" node-list ")"
    visited-clause    ::= ".visited(" node-list ")"
    visitedAny-clause ::= ".visitedAny(" node-list ")"
    context-clause    ::= ".context(" key ":" value ")"
    contextAny-clause ::= ".contextAny(" key ":" value ("," key ":" value)* ")"
    window-clause     ::= ".window(" date-or-offset ":" date-or-offset ")"
    case-clause       ::= ".case(" key ":" value ")"
    minus-clause      ::= ".minus(" node-list ")"
    plus-clause       ::= ".plus(" node-list ")"
    
    node-list      ::= node-id ("," node-id)*
    node-id        ::= [a-z0-9_-]+
    key            ::= [a-z0-9_-]+
    value          ::= [a-z0-9_-]+
    date-or-offset ::= [0-9]+-[A-Za-z]{3}-[0-9]{2} | -?[0-9]+[dwmy]

NOTE: from() and to() are OPTIONAL for analytics queries. They are required
for data retrieval queries but optional for path constraint queries.

Examples:
    "from(homepage).to(checkout)"                                    # Full path query
    "from(homepage).to(checkout).exclude(back-button)"               # Path with exclusion
    "from(product-view).to(checkout).visited(add-to-cart)"           # Path with waypoint
    "visited(promo).visited(cart)"                                   # Constraints only (analytics)
    "visitedAny(branch-a,branch-b)"                                  # OR constraint (analytics)
    "from(start).visitedAny(a,b)"                                    # Start with OR branches
    "from(homepage).to(checkout).context(device:mobile)"
    "from(homepage).to(checkout).contextAny(channel:google,channel:meta)"
    "from(homepage).to(checkout).window(1-Jan-25:31-Mar-25)"
    "from(homepage).to(checkout).window(-30d:)"
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
class ContextAnyGroup:
    """Group of key-value pairs for contextAny (OR within key, AND across keys)."""
    pairs: List[KeyValuePair]


@dataclass
class WindowConstraint:
    """Time window constraint for data retrieval."""
    start: Optional[str] = None  # Date (d-MMM-yy) or relative offset (-30d)
    end: Optional[str] = None    # Date (d-MMM-yy) or relative offset (-30d)


@dataclass
class ParsedQuery:
    """
    Parsed query DSL expression per query-dsl-1.0.0.json schema.
    
    Properties:
    - Order-independent: .exclude(A,B) ≡ .exclude(B,A)
    - Idempotent: .exclude(A).exclude(A) ≡ .exclude(A)
    - Composable: Constraints are logically ANDed
    - from_node/to_node are OPTIONAL for analytics queries
    
    Schema authority: /graph-editor/public/schemas/query-dsl-1.0.0.json
    Valid functions: ["from", "to", "visited", "visitedAny", "exclude", "context", "case", "minus", "plus"]
    """
    from_node: Optional[str]          # Source node ID (optional for analytics)
    to_node: Optional[str]            # Target node ID (optional for analytics)
    exclude: List[str]                # Nodes to exclude from path (AND)
    visited: List[str]                # Nodes that must be visited (AND)
    visited_any: List[List[str]]      # Groups where at least one must be visited (OR per group)
    context: List[KeyValuePair]       # Context filters (e.g., device:mobile)
    context_any: List[ContextAnyGroup]# ContextAny groups (OR within key, AND across keys)
    window: Optional[WindowConstraint]# Time window constraint (e.g., window(1-Jan-25:31-Mar-25))
    cases: List[KeyValuePair]         # Case/variant filters (e.g., test-id:variant)
    minus: List[List[str]]            # Subtractive node sets (coefficient -1, inherits base from/to)
    plus: List[List[str]]             # Add-back node sets (coefficient +1, inherits base from/to)
    
    @property
    def raw(self) -> str:
        """Reconstruct query string from parsed components."""
        parts = []
        
        if self.from_node:
            parts.append(f"from({self.from_node})")
        
        if self.to_node:
            parts.append(f"to({self.to_node})")
        
        if self.exclude:
            parts.append(f"exclude({','.join(self.exclude)})")
        
        if self.visited:
            parts.append(f"visited({','.join(self.visited)})")
        
        for group in self.visited_any:
            if group:
                parts.append(f"visitedAny({','.join(group)})")
        
        for ctx in self.context:
            parts.append(f"context({ctx.key}:{ctx.value})")
        
        for ctx_any in self.context_any:
            pairs_str = ','.join(f"{p.key}:{p.value}" for p in ctx_any.pairs)
            parts.append(f"contextAny({pairs_str})")
        
        if self.window:
            start = self.window.start or ''
            end = self.window.end or ''
            parts.append(f"window({start}:{end})")
        
        for case in self.cases:
            parts.append(f"case({case.key}:{case.value})")
        
        for minus_nodes in self.minus:
            parts.append(f"minus({','.join(minus_nodes)})")
        
        for plus_nodes in self.plus:
            parts.append(f"plus({','.join(plus_nodes)})")
        
        return ".".join(parts)
    
    @property
    def has_path_endpoints(self) -> bool:
        """Check if query has explicit from/to endpoints."""
        return self.from_node is not None and self.to_node is not None
    
    @property
    def all_constraint_nodes(self) -> List[str]:
        """Get all nodes referenced in constraints (visited, exclude, visitedAny)."""
        nodes = []
        nodes.extend(self.visited)
        nodes.extend(self.exclude)
        for group in self.visited_any:
            nodes.extend(group)
        return nodes


class QueryParseError(Exception):
    """Raised when query string is invalid."""
    pass


def parse_query(query: str, require_endpoints: bool = False) -> ParsedQuery:
    """
    Parse query DSL string into structured components.
    
    Args:
        query: Query string (e.g., "from(a).to(b).exclude(c)" or "visited(x).visited(y)")
        require_endpoints: If True, raise error if from/to are missing (for data retrieval).
                          If False, from/to are optional (for analytics queries).
    
    Returns:
        ParsedQuery with extracted components
    
    Raises:
        QueryParseError: If query is malformed or missing required endpoints
    
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
        
        >>> q = parse_query("visited(x).visited(y)")  # Analytics query, no from/to
        >>> q.from_node
        None
        >>> q.visited
        ['x', 'y']
    """
    
    # Validate basic structure
    if not query or not isinstance(query, str):
        raise QueryParseError("Query must be a non-empty string")
    
    # Extract from() and to() - now optional
    # Note: Node IDs can contain uppercase letters (e.g., recommendation-with-BDOs)
    from_match = re.search(r'from\(([a-zA-Z0-9_-]+)\)', query)
    to_match = re.search(r'to\(([a-zA-Z0-9_-]+)\)', query)
    
    from_node = from_match.group(1) if from_match else None
    to_node = to_match.group(1) if to_match else None
    
    # Enforce endpoints if required (for data retrieval queries)
    if require_endpoints:
        if not from_node:
            raise QueryParseError("Query must contain 'from(node-id)'")
        if not to_node:
            raise QueryParseError("Query must contain 'to(node-id)'")
    
    # Extract constraints
    exclude = _extract_node_list(query, 'exclude')
    visited = _extract_node_list(query, 'visited')
    visited_any = _extract_node_groups(query, 'visitedAny')
    context = _extract_key_value_pairs(query, 'context')
    context_any = _extract_context_any(query)
    window = _extract_window(query)
    cases = _extract_key_value_pairs(query, 'case')
    
    # Extract minus/plus clauses (now just node lists, not nested queries)
    minus_node_sets = _extract_node_groups(query, 'minus')
    plus_node_sets = _extract_node_groups(query, 'plus')
    
    return ParsedQuery(
        from_node=from_node,
        to_node=to_node,
        exclude=exclude,
        visited=visited,
        visited_any=visited_any,
        context=context,
        context_any=context_any,
        window=window,
        cases=cases,
        minus=minus_node_sets,
        plus=plus_node_sets
    )


def parse_query_strict(query: str) -> ParsedQuery:
    """
    Parse query DSL string, requiring from() and to() endpoints.
    
    Use this for data retrieval queries where endpoints are mandatory.
    
    Args:
        query: Query string (e.g., "from(a).to(b).exclude(c)")
    
    Returns:
        ParsedQuery with extracted components
    
    Raises:
        QueryParseError: If query is malformed or missing from/to
    """
    return parse_query(query, require_endpoints=True)


def _extract_node_list(query: str, constraint_type: str) -> List[str]:
    """
    Extract node list from constraint clause.
    
    Examples:
        _extract_node_list("...exclude(a,b,c)...", "exclude") → ["a", "b", "c"]
        _extract_node_list("...visited(x)...", "visited") → ["x"]
    """
    # Note: Node IDs can contain uppercase letters (e.g., recommendation-with-BDOs)
    pattern = rf'{constraint_type}\(([a-zA-Z0-9_,-]+)\)'
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
    # Note: Keys and values can contain uppercase letters
    pattern = rf'{function_type}\(([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)\)'
    matches = re.findall(pattern, query)
    
    return [KeyValuePair(key=m[0], value=m[1]) for m in matches]


def _extract_node_groups(query: str, function_type: str) -> List[List[str]]:
    """
    Extract OR-groups from DSL functions like visitedAny(a,b).
    Returns list of groups; each group is a list of node ids.
    """
    # Note: Node IDs can contain uppercase letters (e.g., recommendation-with-BDOs)
    pattern = rf'{function_type}\(([a-zA-Z0-9_,-]+)\)'
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


def _extract_nested_queries(query: str, function_name: str) -> List['ParsedQuery']:
    """
    Extract and recursively parse nested queries from minus/plus clauses.
    
    Args:
        query: Full query string
        function_name: "minus" or "plus"
        
    Returns:
        List of parsed nested queries
    """
    nested_queries = []
    
    # Match .minus(from(...).to(...)) or .plus(from(...).to(...))
    # Need to handle nested parentheses carefully
    pattern = rf'\.{function_name}\(([^)]+(?:\([^)]*\))*)\)'
    matches = re.findall(pattern, query)
    
    for match in matches:
        # Recursively parse the inner query
        try:
            inner = parse_query(match)
            nested_queries.append(inner)
        except QueryParseError:
            # Skip malformed nested queries
            continue
    
    return nested_queries


def _extract_context_any(query: str) -> List[ContextAnyGroup]:
    """
    Extract contextAny groups from query.
    
    Examples:
        _extract_context_any("...contextAny(channel:google,channel:meta)...")
            → [ContextAnyGroup(pairs=[KeyValuePair("channel", "google"), KeyValuePair("channel", "meta")])]
    """
    # Note: Keys and values can contain uppercase letters
    pattern = r'contextAny\(([a-zA-Z0-9_:,-]+)\)'
    matches = re.findall(pattern, query)
    
    groups = []
    for match in matches:
        pairs = []
        # Split by comma and parse each key:value pair
        for pair_str in match.split(','):
            if ':' in pair_str:
                key, value = pair_str.strip().split(':', 1)
                pairs.append(KeyValuePair(key=key, value=value))
        
        if pairs:
            groups.append(ContextAnyGroup(pairs=pairs))
    
    return groups


def _extract_window(query: str) -> Optional[WindowConstraint]:
    """
    Extract window constraint from query.
    
    Examples:
        _extract_window("...window(1-Jan-25:31-Mar-25)...") 
            → WindowConstraint(start="1-Jan-25", end="31-Mar-25")
        _extract_window("...window(-30d:)...")
            → WindowConstraint(start="-30d", end=None)
    """
    # Pattern matches: window(start:end) where start/end can be:
    # - Date: 1-Jan-25
    # - Relative offset: -30d, -7w, -3m, -1y
    # - Empty (for open-ended)
    pattern = r'window\(([^:]*):([^)]*)\)'
    match = re.search(pattern, query)
    
    if not match:
        return None
    
    start = match.group(1).strip() or None
    end = match.group(2).strip() or None
    
    return WindowConstraint(start=start, end=end)


def validate_query(
    query: str,
    available_nodes: Optional[List[str]] = None,
    require_endpoints: bool = False
) -> Tuple[bool, Optional[str]]:
    """
    Validate query string.
    
    Args:
        query: Query string to validate
        available_nodes: List of valid node IDs (optional)
        require_endpoints: If True, require from/to endpoints
    
    Returns:
        (is_valid, error_message)
    
    Examples:
        >>> validate_query("from(a).to(b)")
        (True, None)
        
        >>> validate_query("visited(x).visited(y)")  # Analytics query
        (True, None)
        
        >>> validate_query("visited(x)", require_endpoints=True)
        (False, "Query must contain 'from(node-id)'")
    """
    
    try:
        parsed = parse_query(query, require_endpoints=require_endpoints)
    except QueryParseError as e:
        return False, str(e)
    
    # Validate node references
    if available_nodes is not None:
        node_set = set(available_nodes)
        
        # Collect all referenced nodes
        all_refs = parsed.exclude + parsed.visited + parsed.all_constraint_nodes
        if parsed.from_node:
            all_refs.append(parsed.from_node)
        if parsed.to_node:
            all_refs.append(parsed.to_node)
        
        for node_id in all_refs:
            if node_id and node_id not in node_set:
                return False, f"Node not found: {node_id}"
        
        # Check logical constraints (only if endpoints are set)
        if parsed.from_node and parsed.from_node in parsed.exclude:
            return False, f"Cannot exclude source node: {parsed.from_node}"
        
        if parsed.to_node and parsed.to_node in parsed.exclude:
            return False, f"Cannot exclude target node: {parsed.to_node}"
    
    return True, None

