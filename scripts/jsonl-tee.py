#!/usr/bin/env python3
"""jsonl-tee.py — Read lines from stdin, write each as JSONL to a file,
and pass through to stdout unchanged.

Usage:  some-command 2>&1 | python scripts/jsonl-tee.py debug/tmp.python-server.jsonl

Each non-empty line becomes:
  {"kind":"py","ts_ms":<epoch_ms>,"level":"stdout","message":"<line>"}
"""
import json
import sys
import os
import time

def main():
    if len(sys.argv) < 2:
        print("Usage: jsonl-tee.py <output-file>", file=sys.stderr)
        sys.exit(1)

    out_path = sys.argv[1]
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)

    with open(out_path, 'a', encoding='utf-8') as f:
        for line in sys.stdin:
            # Pass through to terminal immediately
            sys.stdout.write(line)
            sys.stdout.flush()

            stripped = line.strip()
            if not stripped:
                continue

            entry = json.dumps({
                'kind': 'py',
                'ts_ms': int(time.time() * 1000),
                'level': 'stdout',
                'message': stripped,
            })
            f.write(entry + '\n')
            f.flush()


if __name__ == '__main__':
    main()
