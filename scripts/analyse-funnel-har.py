#!/usr/bin/env python3
"""
Analyse a Playwright HAR file to extract Amplitude front-end API calls
related to funnel chart construction.

Extracts:
  - All requests to app.amplitude.com (GraphQL, REST, etc.)
  - Request method, URL, headers, body
  - Response status, body (truncated)
  - Grouped by likely purpose (chart, funnel, save, etc.)

Usage:
    python3 scripts/analyse-funnel-har.py /tmp/amp-funnel-spike.har [--full]

Options:
    --full   Show full request/response bodies (default: truncated to 2000 chars)
"""

import json
import sys
from collections import defaultdict
from urllib.parse import urlparse, parse_qs


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/analyse-funnel-har.py <har-file> [--full]")
        sys.exit(1)

    har_path = sys.argv[1]
    full_output = "--full" in sys.argv

    with open(har_path, "r") as f:
        har = json.load(f)

    entries = har.get("log", {}).get("entries", [])
    print(f"\nTotal HAR entries: {len(entries)}")

    # Filter to amplitude.com requests (excluding static assets)
    SKIP_EXTENSIONS = {
        ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
        ".woff", ".woff2", ".ttf", ".eot", ".map", ".webp",
    }
    amp_entries = []
    for entry in entries:
        url = entry.get("request", {}).get("url", "")
        if "amplitude.com" not in url:
            continue
        parsed = urlparse(url)
        path = parsed.path.lower()
        if any(path.endswith(ext) for ext in SKIP_EXTENSIONS):
            continue
        amp_entries.append(entry)

    print(f"Amplitude API entries (excluding assets): {len(amp_entries)}\n")

    # Categorise entries
    categories = defaultdict(list)
    for entry in amp_entries:
        req = entry["request"]
        url = req["url"]
        method = req["method"]
        parsed = urlparse(url)
        path = parsed.path

        # Extract GraphQL operation name
        op_name = None
        if "graphql" in path:
            qs = parse_qs(parsed.query)
            op_name = qs.get("q", [None])[0]
            if not op_name:
                # Try to get from request body
                body = get_request_body(req)
                if body:
                    try:
                        body_json = json.loads(body)
                        op_name = body_json.get("operationName")
                    except (json.JSONDecodeError, AttributeError):
                        pass

        # Categorise
        url_lower = url.lower()
        if op_name:
            cat = f"GraphQL: {op_name}"
        elif "/api/" in path:
            cat = f"REST API: {method} {path}"
        elif any(kw in url_lower for kw in ["chart", "funnel", "save", "analysis", "event"]):
            cat = f"Keyword match: {method} {path}"
        else:
            cat = f"Other: {method} {path}"

        categories[cat].append(entry)

    # Print summary
    print("=" * 70)
    print("  CATEGORISED API CALLS")
    print("=" * 70)

    for cat in sorted(categories.keys()):
        entries_in_cat = categories[cat]
        print(f"\n{'─' * 70}")
        print(f"  {cat}  ({len(entries_in_cat)} call{'s' if len(entries_in_cat) > 1 else ''})")
        print(f"{'─' * 70}")

        for i, entry in enumerate(entries_in_cat):
            req = entry["request"]
            resp = entry["response"]
            url = req["url"]
            method = req["method"]
            status = resp.get("status", "?")

            print(f"\n  [{i+1}] {method} {url[:120]}{'...' if len(url) > 120 else ''}")
            print(f"      Status: {status}")

            # Request headers of interest
            interesting_headers = {"x-org", "x-project", "x-csrf-token",
                                   "content-type", "cookie", "authorization"}
            for h in req.get("headers", []):
                name_lower = h["name"].lower()
                if name_lower in interesting_headers:
                    value = h["value"]
                    if name_lower == "cookie":
                        value = f"[{len(value)} chars]"
                    elif name_lower == "authorization" and len(value) > 40:
                        value = value[:40] + "..."
                    print(f"      Header: {h['name']}: {value}")

            # Request body
            body = get_request_body(req)
            if body:
                print(f"      Request body ({len(body)} chars):")
                print_indented(body, full_output)

            # Response body
            resp_body = get_response_body(resp)
            if resp_body:
                print(f"      Response body ({len(resp_body)} chars):")
                print_indented(resp_body, full_output)

    # Highlight chart/funnel/save operations specifically
    print(f"\n\n{'=' * 70}")
    print("  CHART / FUNNEL / SAVE OPERATIONS (filtered)")
    print(f"{'=' * 70}")

    chart_keywords = {"chart", "funnel", "save", "create", "update", "analysis"}
    found = False
    for cat, entries_in_cat in sorted(categories.items()):
        cat_lower = cat.lower()
        if any(kw in cat_lower for kw in chart_keywords):
            found = True
            print(f"\n  >>> {cat} ({len(entries_in_cat)} calls)")
            for entry in entries_in_cat:
                req = entry["request"]
                resp = entry["response"]
                body = get_request_body(req)
                print(f"      {req['method']} {req['url'][:100]}")
                if body:
                    print(f"      Body: {body[:500]}{'...' if len(body) > 500 else ''}")
                resp_body = get_response_body(resp)
                if resp_body:
                    print(f"      Response: {resp_body[:500]}{'...' if len(resp_body) > 500 else ''}")

    if not found:
        print("\n  No chart/funnel/save operations found.")
        print("  This might mean:")
        print("    - The operations use unexpected endpoint names")
        print("    - You didn't create/save a chart during the session")
        print("    - Review the full categorised output above for clues")

    # Extract and save session cookies
    print(f"\n\n{'=' * 70}")
    print("  SESSION COOKIES")
    print(f"{'=' * 70}")

    # Find cookies from a POST-LOGIN request (must contain auth tokens).
    # Pre-login requests only have analytics cookies and will 401.
    # Key auth cookies: org_login_production, access_token_production, onenav_jwt_prod
    cookie_str = None
    for entry in amp_entries:
        for h in entry["request"].get("headers", []):
            if h["name"].lower() == "cookie" and "access_token_production" in h["value"]:
                cookie_str = h["value"]
                break
        if cookie_str:
            break
    # Fallback: longest cookie header (likely post-login)
    if not cookie_str:
        for entry in amp_entries:
            for h in entry["request"].get("headers", []):
                if h["name"].lower() == "cookie" and len(h["value"]) > (len(cookie_str or "")):
                    cookie_str = h["value"]

    if cookie_str:
        cookies = []
        for pair in cookie_str.split("; "):
            if "=" in pair:
                name, _, value = pair.partition("=")
                cookies.append({"name": name.strip(), "value": value.strip(),
                                "domain": ".amplitude.com", "path": "/"})

        session_path = "/tmp/amp-session-state.json"
        with open(session_path, "w") as f:
            json.dump({"cookies": cookies, "origins": []}, f, indent=2)
        print(f"\n  Saved {len(cookies)} cookies to {session_path}")
    else:
        print("\n  No session cookies found.")


def get_request_body(req):
    """Extract request body from HAR request object."""
    post_data = req.get("postData", {})
    if isinstance(post_data, dict):
        return post_data.get("text", "")
    return ""


def get_response_body(resp):
    """Extract response body from HAR response object."""
    content = resp.get("content", {})
    text = content.get("text", "")
    return text


def print_indented(text, full=False):
    """Print text indented, optionally truncated."""
    max_len = 2000
    if not full and len(text) > max_len:
        text = text[:max_len] + f"\n        ... [truncated, {len(text)} total chars. Use --full to see all]"
    # Try to pretty-print JSON
    try:
        parsed = json.loads(text)
        formatted = json.dumps(parsed, indent=2)
        for line in formatted.split("\n")[:50]:
            print(f"        {line}")
        if len(formatted.split("\n")) > 50:
            print(f"        ... [{len(formatted.split(chr(10)))} total lines]")
    except (json.JSONDecodeError, TypeError):
        for line in text.split("\n")[:20]:
            print(f"        {line[:200]}")


if __name__ == "__main__":
    main()
