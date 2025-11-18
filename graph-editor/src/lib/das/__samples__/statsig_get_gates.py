#!/usr/bin/env python3
import os
import sys
import json
import urllib.request

BASE_URL = "https://statsigapi.net/console/v1"

def fetch(path: str, api_key: str) -> dict:
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("STATSIG-API-KEY", api_key)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    return json.loads(data.decode("utf-8"))

def main():
    api_key = os.environ.get("STATSIG_CONSOLE_API_KEY")
    if not api_key:
        print("ERROR: Set STATSIG_CONSOLE_API_KEY first", file=sys.stderr)
        sys.exit(1)

    environment = sys.argv[1] if len(sys.argv) > 1 else "production"

    # 1) List gates
    print(f"Fetching gates from {BASE_URL}/gates for env={environment}...", file=sys.stderr)
    gates_resp = fetch("/gates", api_key)

    # Handle either { data: [...] } or [...] directly
    if isinstance(gates_resp, dict) and "data" in gates_resp and isinstance(gates_resp["data"], list):
        gates_list = gates_resp["data"]
    elif isinstance(gates_resp, list):
        gates_list = gates_resp
    else:
        print("Unexpected /gates response shape:", file=sys.stderr)
        print(json.dumps(gates_resp, indent=2), file=sys.stderr)
        sys.exit(1)

    gate_ids = [g["id"] for g in gates_list if g.get("isEnabled")]

    if not gate_ids:
        print("No enabled gates found.", file=sys.stderr)
        print("[]")
        return

    results = []

    for gate_id in gate_ids:
        gate = fetch(f"/gates/{gate_id}", api_key)
        data = gate.get("data") or {}
        rules = data.get("rules") or []

        # Filter rules by environment
        env_rules = []
        for r in rules:
            envs = r.get("environments")
            if envs is None or environment in envs:
                env_rules.append(r)

        if not env_rules:
            results.append({
                "id": data.get("id"),
                "name": data.get("name"),
                "isEnabled": data.get("isEnabled"),
                "note": "no rules for this environment",
                "passPercentage": 0,
                "p_true": 0.0,
            })
            continue

        # Prefer a rule with a public condition
        base_rule = None
        for r in env_rules:
            for cond in r.get("conditions") or []:
                if cond.get("type") == "public":
                    base_rule = r
                    break
            if base_rule is not None:
                break

        if base_rule is None:
            # Fallback: first env rule
            base_rule = env_rules[0]

        pp = base_rule.get("passPercentage") or 0
        p_true = pp / 100.0

        results.append({
            "id": data.get("id"),
            "name": data.get("name"),
            "isEnabled": data.get("isEnabled"),
            "baseRuleName": base_rule.get("name"),
            "baseRuleEnvironments": base_rule.get("environments"),
            "passPercentage": pp,
            "p_true": p_true,
        })

    print(json.dumps(results, indent=2))

if __name__ == "__main__":
    main()