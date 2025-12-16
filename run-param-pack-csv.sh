#!/usr/bin/env bash
set -euo pipefail

# Runs the CSV-driven TS stats harness (Vitest "tool test") and writes a wide param-pack CSV.
#
# Defaults:
# - Data:    param-registry/test/csv/reach-sweep-input.example.csv
# - Queries: param-registry/test/csv/reach-queries.example.csv
# - Output:  graph-editor/tmp/param-pack-output.example.csv
#
# Usage:
#   ./run-param-pack-csv.sh
#   ./run-param-pack-csv.sh -d path/to/data.csv -q path/to/queries.csv -o path/to/out.csv
#
# Notes:
# - Paths may be absolute or relative to the repo root.
# - You can also override via env vars: DAGNET_CSV_DATA, DAGNET_CSV_QUERIES, DAGNET_CSV_OUT

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

data_default="$repo_root/param-registry/test/csv/reach-sweep-input.example.csv"
queries_default="$repo_root/param-registry/test/csv/reach-queries.example.csv"
out_default="$repo_root/graph-editor/tmp/param-pack-output.example.csv"

data_path="${DAGNET_CSV_DATA:-$data_default}"
queries_path="${DAGNET_CSV_QUERIES:-$queries_default}"
out_path="${DAGNET_CSV_OUT:-$out_default}"

usage() {
  cat <<'EOF'
Usage:
  ./run-param-pack-csv.sh [-d DATA_CSV] [-q QUERIES_CSV] [-o OUT_CSV] [-h]

Defaults:
  DATA_CSV:    param-registry/test/csv/reach-sweep-input.example.csv
  QUERIES_CSV: param-registry/test/csv/reach-queries.example.csv
  OUT_CSV:     graph-editor/tmp/param-pack-output.example.csv

Env overrides (alternative to flags):
  DAGNET_CSV_DATA, DAGNET_CSV_QUERIES, DAGNET_CSV_OUT
EOF
}

while getopts ":d:q:o:h" opt; do
  case "$opt" in
    d) data_path="$OPTARG" ;;
    q) queries_path="$OPTARG" ;;
    o) out_path="$OPTARG" ;;
    h) usage; exit 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; usage; exit 2 ;;
    :) echo "Missing value for -$OPTARG" >&2; usage; exit 2 ;;
  esac
done

mkdir -p "$repo_root/graph-editor/tmp"

cd "$repo_root/graph-editor"

# The harness accepts ISO (YYYY-MM-DD) or UK d-MMM-yy dates.
# If the daily data CSV uses UK slash format (dd/mm/yyyy), auto-convert to ISO into a temp file.
data_for_run="$data_path"
queries_for_run="$queries_path"
tmp_data=""
tmp_queries=""
if [[ -f "$data_path" ]] && grep -Eq '^[[:space:]]*[0-9]{1,2}/[0-9]{1,2}/[0-9]{4},' "$data_path"; then
  tmp_data="$repo_root/graph-editor/tmp/csv-runner-data.$$.csv"
  awk -F',' '
    BEGIN { OFS="," }
    NR==1 { sub(/\r$/, "", $0); print; next }
    {
      sub(/\r$/, "", $0);
      d=$1;
      if (d ~ /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}$/) {
        n=split(d, a, "/");
        if (n==3) {
          dd=sprintf("%02d", a[1]+0);
          mm=sprintf("%02d", a[2]+0);
          yyyy=a[3];
          $1 = yyyy "-" mm "-" dd;
        }
      }
      print
    }
  ' "$data_path" > "$tmp_data"
  data_for_run="$tmp_data"
fi

# Queries CSV has a date in `as_of_date` (column 2). If it's dd/mm/yyyy, auto-convert to ISO.
if [[ -f "$queries_path" ]] && grep -Eq ',[[:space:]]*[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}[[:space:]]*$' "$queries_path"; then
  tmp_queries="$repo_root/graph-editor/tmp/csv-runner-queries.$$.csv"
  awk -F',' '
    BEGIN { OFS="," }
    NR==1 { sub(/\r$/, "", $0); print; next }
    {
      sub(/\r$/, "", $0);
      d=$2;
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", d);
      if (d ~ /^[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}$/) {
        n=split(d, a, "/");
        if (n==3) {
          dd=sprintf("%02d", a[1]+0);
          mm=sprintf("%02d", a[2]+0);
          yyyy=a[3];
          $2 = yyyy "-" mm "-" dd;
        }
      }
      print
    }
  ' "$queries_path" > "$tmp_queries"
  queries_for_run="$tmp_queries"
fi

DAGNET_CSV_RUN=1 \
DAGNET_CSV_DATA="$data_for_run" \
DAGNET_CSV_QUERIES="$queries_for_run" \
DAGNET_CSV_OUT="$out_path" \
npm test -- --run src/services/__tests__/paramPackCsvRunner.csvDriven.tool.test.ts

if [[ -n "$tmp_data" ]]; then
  rm -f "$tmp_data"
fi
if [[ -n "$tmp_queries" ]]; then
  rm -f "$tmp_queries"
fi

echo
echo "Wrote CSV: $out_path"

