"""
Graph fixtures for testing.

Provides sample graphs matching the conversion-graph-1.1.0.json schema.
"""

from lib.graph_types import (
    Graph, Node, Edge, ProbabilityParam, Policies, Metadata,
    ConditionalProbability, Layout
)
from datetime import datetime


def minimal_graph() -> Graph:
    """
    Minimal valid graph: 2 nodes, 1 edge.
    Useful for basic validation tests.
    """
    return Graph(
        nodes=[
            Node(
                uuid="node-a-uuid",
                id="a",
                label="Node A",
                layout=Layout(x=0, y=0)
            ),
            Node(
                uuid="node-b-uuid",
                id="b",
                label="Node B",
                layout=Layout(x=200, y=0),
                absorbing=True,
                outcome_type="success"
            )
        ],
        edges=[
            Edge(
                uuid="edge-ab-uuid",
                id="a-to-b",
                **{'from': "a"},  # Using dict unpacking for 'from' keyword
                to="b",
                p=ProbabilityParam(mean=1.0)
            )
        ],
        policies=Policies(
            default_outcome="b",
            overflow_policy="error",
            free_edge_policy="complement"
        ),
        metadata=Metadata(
            version="1.0.0",
            created_at=datetime.now()
        )
    )


def simple_funnel() -> Graph:
    """
    Simple 3-node funnel: homepage -> product -> checkout
    """
    return Graph(
        nodes=[
            Node(
                uuid="homepage-uuid",
                id="homepage",
                label="Homepage",
                layout=Layout(x=0, y=0)
            ),
            Node(
                uuid="product-uuid",
                id="product",
                label="Product Page",
                layout=Layout(x=200, y=0)
            ),
            Node(
                uuid="checkout-uuid",
                id="checkout",
                label="Checkout",
                layout=Layout(x=400, y=0),
                absorbing=True,
                outcome_type="success"
            )
        ],
        edges=[
            Edge(
                uuid="homepage-product-uuid",
                id="homepage-to-product",
                **{'from': "homepage"},
                to="product",
                p=ProbabilityParam(mean=0.3),
                query="from(homepage).to(product)"
            ),
            Edge(
                uuid="product-checkout-uuid",
                id="product-to-checkout",
                **{'from': "product"},
                to="checkout",
                p=ProbabilityParam(mean=0.15),
                query="from(product).to(checkout)"
            )
        ],
        policies=Policies(
            default_outcome="checkout",
            overflow_policy="normalize",
            free_edge_policy="complement"
        ),
        metadata=Metadata(
            version="1.0.0",
            created_at=datetime.now(),
            description="Simple 3-node conversion funnel"
        )
    )


def graph_with_conditionals() -> Graph:
    """
    Graph with conditional probabilities for MSMDC testing.
    
    Structure:
    - homepage -> product (base p=0.2)
    - product -> checkout (base p=0.1, conditional p=0.3 if visited(promo))
    """
    return Graph(
        nodes=[
            Node(uuid="homepage-uuid", id="homepage", label="Homepage", layout=Layout(x=0, y=0)),
            Node(uuid="promo-uuid", id="promo", label="Promo Page", layout=Layout(x=100, y=-100)),
            Node(uuid="product-uuid", id="product", label="Product", layout=Layout(x=200, y=0)),
            Node(uuid="checkout-uuid", id="checkout", label="Checkout", layout=Layout(x=400, y=0), absorbing=True)
        ],
        edges=[
            Edge(
                uuid="homepage-promo-uuid",
                **{'from': "homepage"},
                to="promo",
                p=ProbabilityParam(mean=0.4)
            ),
            Edge(
                uuid="homepage-product-uuid",
                **{'from': "homepage"},
                to="product",
                p=ProbabilityParam(mean=0.2)
            ),
            Edge(
                uuid="promo-product-uuid",
                **{'from': "promo"},
                to="product",
                p=ProbabilityParam(mean=0.6)
            ),
            Edge(
                uuid="product-checkout-uuid",
                **{'from': "product"},
                to="checkout",
                p=ProbabilityParam(mean=0.1),
                conditional_p=[
                    ConditionalProbability(
                        condition="visited(promo)",
                        query="from(product).to(checkout).visited(promo)",
                        p=ProbabilityParam(mean=0.3)
                    )
                ]
            )
        ],
        policies=Policies(
            default_outcome="checkout",
            overflow_policy="normalize"
        ),
        metadata=Metadata(
            version="1.0.0",
            created_at=datetime.now(),
            description="Graph with conditional probabilities"
        )
    )

