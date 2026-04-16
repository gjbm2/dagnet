#!/usr/bin/env python3
"""
Config-driven regression plan runner.

Wraps run_regression.py with JSON plan files that define named test
plans — graph selections, sampling overrides, threshold overrides,
and feature flags. Designed for overnight CI and interactive subset
runs without needing to remember CLI flags.

Usage:
    . graph-editor/venv/bin/activate

    # List available plans
    python bayes/regression_plans.py --list

    # Run a named plan
    python bayes/regression_plans.py --plan overnight-full
    python bayes/regression_plans.py --plan smoke
    python bayes/regression_plans.py --plan context-focus

    # Run a plan file from disk
    python bayes/regression_plans.py --plan-file path/to/custom-plan.json

    # Override sampling within a plan
    python bayes/regression_plans.py --plan smoke --chains 2 --draws 500

    # Dry run (show what would run, no MCMC)
    python bayes/regression_plans.py --plan overnight-full --dry-run

Plan file format (JSON):
    {
        "name": "overnight-full",
        "description": "All synth graphs, full sampling",
        "graphs": {
            "include": ["*"],           # glob patterns
            "exclude": ["*-forecast-*"] # glob patterns
        },
        "sampling": {
            "chains": 3,
            "draws": 1000,
            "tune": 500,
            "max_parallel": null        # auto from core count
        },
        "features": [],                 # ["latency_dispersion=true"]
        "settings": {},                 # arbitrary JSON merged into worker settings
        "threshold_overrides": {},      # per-graph or global
        "tags": ["context", "sparse"],  # for filtering/reporting

        // Optional: iterate over model variants. Each variant runs the
        // full graph set with its own features/settings, producing a
        // separate results block. Useful for A/B comparisons.
        "variants": [
            {
                "name": "baseline",
                "features": [],
                "settings": {}
            },
            {
                "name": "latency-dispersion",
                "features": ["latency_dispersion=true"],
                "settings": {"target_accept": 0.95}
            }
        ]
    }

Plan discovery:
    Plans are loaded from bayes/plans/*.json (built-in) and any
    additional directory passed via --plan-dir.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLANS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plans")
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, "bayes"))


# ---------------------------------------------------------------------------
# Plan loading
# ---------------------------------------------------------------------------

def load_plan(path: str) -> dict:
    """Load and validate a plan JSON file.

    JSON with // comments is supported (stripped before parsing).
    """
    with open(path) as f:
        raw = f.read()

    # Strip // comments (not inside strings — good enough for plan files)
    import re
    cleaned = re.sub(r'(?m)^\s*//.*$', '', raw)
    cleaned = re.sub(r',(\s*[}\]])', r'\1', cleaned)  # trailing commas
    plan = json.loads(cleaned)

    required = {"name", "graphs", "sampling"}
    missing = required - set(plan.keys())
    if missing:
        raise ValueError(f"Plan {path} missing required keys: {missing}")

    # Defaults
    plan.setdefault("description", "")
    plan.setdefault("features", [])
    plan.setdefault("settings", {})
    plan.setdefault("threshold_overrides", {})
    plan.setdefault("tags", [])
    plan.setdefault("variants", [])
    plan["graphs"].setdefault("include", ["*"])
    plan["graphs"].setdefault("exclude", [])
    plan["sampling"].setdefault("chains", 3)
    plan["sampling"].setdefault("draws", 1000)
    plan["sampling"].setdefault("tune", 500)
    plan["sampling"].setdefault("max_parallel", None)
    plan["sampling"].setdefault("no_timeout", False)

    # Validate variants
    for v in plan["variants"]:
        if "name" not in v:
            raise ValueError(f"Variant missing 'name' in plan {path}")
        v.setdefault("features", [])
        v.setdefault("settings", {})

    return plan


def discover_plans(*plan_dirs: str) -> dict[str, dict]:
    """Discover all .json plan files from plan directories."""
    plans: dict[str, dict] = {}
    dirs = [PLANS_DIR] + list(plan_dirs)
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for fname in sorted(os.listdir(d)):
            if not fname.endswith(".json"):
                continue
            path = os.path.join(d, fname)
            try:
                plan = load_plan(path)
                plans[plan["name"]] = plan
                plan["_path"] = path
            except (json.JSONDecodeError, ValueError) as e:
                print(f"  WARNING: skipping {path}: {e}")
    return plans


# ---------------------------------------------------------------------------
# Graph filtering
# ---------------------------------------------------------------------------

def filter_graphs(
    all_graph_names: list[str],
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> list[str]:
    """Apply include/exclude glob patterns to graph names."""
    included = set()
    for pattern in include_patterns:
        for name in all_graph_names:
            if fnmatch.fnmatch(name, pattern):
                included.add(name)

    excluded = set()
    for pattern in exclude_patterns:
        for name in included:
            if fnmatch.fnmatch(name, pattern):
                excluded.add(name)

    return sorted(included - excluded)


# ---------------------------------------------------------------------------
# Plan execution
# ---------------------------------------------------------------------------

def _write_settings_json(settings: dict) -> str | None:
    """Write a settings dict to a temp file, return path. None if empty."""
    if not settings:
        return None
    import tempfile
    path = tempfile.mktemp(suffix=".json", prefix="bayes_plan_settings_")
    with open(path, "w") as f:
        json.dump(settings, f)
    return path


def _build_args(
    selected: list[str],
    plan: dict,
    cli_overrides: dict,
    variant_features: list[str] | None = None,
    variant_settings: dict | None = None,
) -> argparse.Namespace:
    """Build an args namespace for run_regression from plan + overrides."""
    sampling = plan["sampling"]

    # Merge features: plan-level + variant-level
    features = list(plan.get("features", []))
    if variant_features:
        features.extend(variant_features)

    # Merge settings: plan-level + variant-level
    settings = {**plan.get("settings", {})}
    if variant_settings:
        settings.update(variant_settings)

    settings_path = _write_settings_json(settings)

    return argparse.Namespace(
        graph=selected,
        include=None,
        exclude=None,
        preflight_only=False,
        chains=cli_overrides.get("chains", sampling["chains"]),
        draws=cli_overrides.get("draws", sampling["draws"]),
        tune=cli_overrides.get("tune", sampling["tune"]),
        max_parallel=cli_overrides.get("max_parallel", sampling["max_parallel"]),
        feature=features,
        no_timeout=sampling.get("no_timeout", False),
        clean=cli_overrides.get("clean", False),
        rebuild=cli_overrides.get("rebuild", False),
        dsl_override=None,
        # Settings JSON path — run_regression doesn't natively support this,
        # so we forward it via the feature flag mechanism as a workaround.
        # The param_recovery.py --settings-json flag is the proper channel.
        _settings_json_path=settings_path,
    )


def run_plan(plan: dict, cli_overrides: dict | None = None) -> dict[str, list[dict]]:
    """Execute a regression plan via run_regression.run_regression().

    If the plan has variants, each variant is run sequentially with its
    own features/settings. Returns a dict mapping variant name (or
    "default" for no-variant plans) to the list of per-graph results.

    cli_overrides: optional dict with keys matching sampling params
    (chains, draws, tune, max_parallel) that take precedence over plan.
    """
    from synth_gen import discover_synth_graphs, _resolve_data_repo
    from run_regression import run_regression

    data_repo = _resolve_data_repo()
    all_graphs = discover_synth_graphs(data_repo)
    all_names = [g["graph_name"] for g in all_graphs]
    overrides = cli_overrides or {}

    selected = filter_graphs(
        all_names,
        plan["graphs"]["include"],
        plan["graphs"]["exclude"],
    )

    if not selected:
        print("No graphs matched the plan filters.")
        return {}

    print(f"{'=' * 70}")
    print(f"  REGRESSION PLAN: {plan['name']}")
    if plan.get("description"):
        print(f"  {plan['description']}")
    print(f"  Graphs: {len(selected)} of {len(all_names)} discovered")
    if plan.get("tags"):
        print(f"  Tags: {', '.join(plan['tags'])}")
    print(f"{'=' * 70}")
    print()
    for name in selected:
        print(f"  - {name}")
    print()

    variants = plan.get("variants", [])
    if not variants:
        # Single run, no variants
        variants = [{"name": "default", "features": [], "settings": {}}]

    all_results: dict[str, list[dict]] = {}

    for i, variant in enumerate(variants):
        v_name = variant["name"]
        v_features = variant.get("features", [])
        v_settings = variant.get("settings", {})

        if len(variants) > 1:
            print(f"\n{'=' * 70}")
            print(f"  VARIANT {i + 1}/{len(variants)}: {v_name}")
            if v_features:
                print(f"  Features: {', '.join(v_features)}")
            if v_settings:
                print(f"  Settings: {json.dumps(v_settings, indent=None)}")
            print(f"{'=' * 70}\n")

        args = _build_args(selected, plan, overrides, v_features, v_settings)
        results = run_regression(args)
        all_results[v_name] = results

    # Print cross-variant comparison if >1 variant
    if len(all_results) > 1:
        _print_variant_comparison(all_results)

    # Write structured JSON results
    results_path = write_results_json(plan, all_results)
    print(f"\n  Structured results: {results_path}")

    return all_results


def _print_variant_comparison(all_results: dict[str, list[dict]]) -> None:
    """Print a side-by-side comparison of variant results."""
    print(f"\n{'=' * 70}")
    print(f"  VARIANT COMPARISON")
    print(f"{'=' * 70}\n")

    # Collect all graph names across variants
    graph_names: set[str] = set()
    for results in all_results.values():
        for r in results:
            graph_names.add(r["graph_name"])

    # Build lookup: variant -> graph -> result
    lookup: dict[str, dict[str, dict]] = {}
    for v_name, results in all_results.items():
        lookup[v_name] = {r["graph_name"]: r for r in results}

    variant_names = list(all_results.keys())

    # Header
    header = f"  {'Graph':<40s}"
    for v in variant_names:
        header += f"  {v:<20s}"
    print(header)
    print(f"  {'─' * 40}" + f"  {'─' * 20}" * len(variant_names))

    for graph in sorted(graph_names):
        row = f"  {graph:<40s}"
        for v in variant_names:
            r = lookup.get(v, {}).get(graph)
            if r is None:
                row += f"  {'—':<20s}"
            elif r["passed"]:
                q = r.get("quality", {})
                rhat = q.get("rhat", 0)
                row += f"  {'PASS':>5s} rhat={rhat:.3f}  "
            elif r.get("xfail"):
                row += f"  {'XFAIL':<20s}"
            else:
                n_fail = len(r.get("failures", []))
                row += f"  {'FAIL':>5s} ({n_fail} issues) "
        print(row)

    print()


def serialise_result(r: dict) -> dict:
    """Extract the JSON-safe subset of a single graph result.

    Drops non-serialisable or overly verbose fields (raw audit log text)
    while preserving everything needed for programmatic analysis.
    """
    return {
        "graph_name": r.get("graph_name", ""),
        "passed": r.get("passed", False),
        "xfail": r.get("xfail", False),
        "xfail_reason": r.get("xfail_reason", ""),
        "failures": r.get("failures", []),
        "warnings": r.get("warnings", []),
        "quality": r.get("quality", {}),
        "thresholds": r.get("thresholds", {}),
        "edges": {
            edge_name: {
                param: {
                    "truth": pdata.get("truth"),
                    "posterior_mean": pdata.get("posterior_mean"),
                    "posterior_sd": pdata.get("posterior_sd"),
                    "z_score": pdata.get("z_score"),
                    "abs_error": pdata.get("abs_error"),
                    "status": pdata.get("status"),
                }
                for param, pdata in edge_params.items()
            }
            for edge_name, edge_params in r.get("parsed_edges", r.get("edges", {})).items()
        },
        "slices": {
            label: {
                param: {
                    "truth": pdata.get("truth"),
                    "posterior_mean": pdata.get("posterior_mean"),
                    "posterior_sd": pdata.get("posterior_sd"),
                    "z_score": pdata.get("z_score"),
                    "abs_error": pdata.get("abs_error"),
                    "status": pdata.get("status"),
                }
                for param, pdata in slice_params.items()
                if isinstance(pdata, dict)
            }
            for label, slice_params in r.get("parsed_slices", r.get("slices", {})).items()
        },
    }


def write_results_json(
    plan: dict,
    all_results: dict[str, list[dict]],
    output_dir: str = "/tmp",
) -> str:
    """Write structured JSON results file. Returns the file path.

    Output schema:
        {
            "plan": "plan-name",
            "timestamp": "16-Apr-26 14:30",
            "variants": {
                "variant-name": {
                    "total": 10,
                    "passed": 8,
                    "failed": 1,
                    "xfailed": 1,
                    "graphs": [ {serialised result per graph} ]
                }
            }
        }
    """
    envelope = {
        "plan": plan.get("name", "unknown"),
        "description": plan.get("description", ""),
        "timestamp": time.strftime("%d-%b-%y %H:%M"),
        "sampling": plan.get("sampling", {}),
        "features": plan.get("features", []),
        "variants": {},
    }

    for v_name, results in all_results.items():
        passed = [r for r in results if r.get("passed") and not r.get("xfail")]
        failed = [r for r in results if not r.get("passed") and not r.get("xfail")]
        xfailed = [r for r in results if not r.get("passed") and r.get("xfail")]

        envelope["variants"][v_name] = {
            "total": len(results),
            "passed": len(passed),
            "failed": len(failed),
            "xfailed": len(xfailed),
            "graphs": [serialise_result(r) for r in results],
        }

    run_id = f"plan-{plan.get('name', 'unknown')}-{int(time.time())}"
    path = os.path.join(output_dir, f"bayes_results-{run_id}.json")
    with open(path, "w") as f:
        json.dump(envelope, f, indent=2)

    return path


def dry_run_plan(plan: dict) -> None:
    """Show what a plan would run without executing MCMC."""
    from synth_gen import discover_synth_graphs, _resolve_data_repo

    data_repo = _resolve_data_repo()
    all_graphs = discover_synth_graphs(data_repo)
    all_names = [g["graph_name"] for g in all_graphs]

    selected = filter_graphs(
        all_names,
        plan["graphs"]["include"],
        plan["graphs"]["exclude"],
    )

    print(f"Plan: {plan['name']}")
    if plan.get("description"):
        print(f"  {plan['description']}")
    print(f"Sampling: {plan['sampling']['chains']} chains × "
          f"{plan['sampling']['draws']} draws, {plan['sampling']['tune']} tune")
    if plan.get("features"):
        print(f"Features: {', '.join(plan['features'])}")
    print(f"\nWould run {len(selected)} of {len(all_names)} graphs:")

    # Group by tag-relevant properties for readability
    name_to_truth = {}
    for g in all_graphs:
        name_to_truth[g["graph_name"]] = g["truth"]

    for name in selected:
        truth = name_to_truth.get(name, {})
        sim = truth.get("simulation", {})
        testing = truth.get("testing", {})
        dims = len(truth.get("context_dimensions", []))
        epochs = len(truth.get("epochs", []))
        sparse = "sparse" if sim.get("frame_drop_rate", 0) > 0 else ""
        edges = len(truth.get("edges", {}))
        timeout = testing.get("timeout", sim.get("expected_sample_seconds", "?"))
        xfail = " [xfail]" if testing.get("xfail_reason") else ""

        tags = []
        if dims == 0:
            tags.append("bare")
        elif dims == 1:
            tags.append("1-dim")
        elif dims >= 2:
            tags.append(f"{dims}-dim")
        if epochs > 0:
            tags.append("mixed-epoch")
        if sparse:
            tags.append("sparse")

        tag_str = ", ".join(tags) if tags else "bare"
        print(f"  {name:<45s} {edges} edges  [{tag_str}]  ~{timeout}s{xfail}")

    excluded = set(all_names) - set(selected)
    if excluded:
        print(f"\nExcluded ({len(excluded)}):")
        for name in sorted(excluded):
            print(f"  {name}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Config-driven regression plan runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bayes/regression_plans.py --list
  python bayes/regression_plans.py --plan smoke
  python bayes/regression_plans.py --plan overnight-full --dry-run
  python bayes/regression_plans.py --plan-file my-plan.json --chains 2
""",
    )
    parser.add_argument("--list", action="store_true",
                        help="List available plans")
    parser.add_argument("--plan", type=str, default=None,
                        help="Named plan to run (from bayes/plans/)")
    parser.add_argument("--plan-file", type=str, default=None,
                        help="Path to a custom plan JSON file")
    parser.add_argument("--plan-dir", type=str, default=None,
                        help="Additional directory to search for plans")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would run without executing")
    parser.add_argument("--chains", type=int, default=None)
    parser.add_argument("--draws", type=int, default=None)
    parser.add_argument("--tune", type=int, default=None)
    parser.add_argument("--max-parallel", type=int, default=None)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    extra_dirs = [args.plan_dir] if args.plan_dir else []
    plans = discover_plans(*extra_dirs)

    if args.list:
        if not plans:
            print("No plans found. Create .json files in bayes/plans/")
            return
        print(f"Available plans ({len(plans)}):\n")
        for name, plan in sorted(plans.items()):
            tags = f"  [{', '.join(plan['tags'])}]" if plan.get("tags") else ""
            print(f"  {name:<25s} {plan.get('description', '')}{tags}")
        return

    if args.plan_file:
        plan = load_plan(args.plan_file)
    elif args.plan:
        if args.plan not in plans:
            print(f"Unknown plan '{args.plan}'. Available: {', '.join(sorted(plans))}")
            sys.exit(1)
        plan = plans[args.plan]
    else:
        parser.print_help()
        sys.exit(1)

    if args.dry_run:
        dry_run_plan(plan)
        return

    # Build CLI overrides (only non-None values)
    overrides = {}
    for key in ("chains", "draws", "tune", "max_parallel", "clean", "rebuild"):
        val = getattr(args, key, None)
        if val is not None:
            overrides[key] = val

    all_results = run_plan(plan, overrides)

    # Flatten all variant results for exit code
    unexpected_failures = []
    for results in all_results.values():
        unexpected_failures.extend(
            r for r in results if not r["passed"] and not r.get("xfail")
        )
    sys.exit(1 if unexpected_failures else 0)


if __name__ == "__main__":
    main()
