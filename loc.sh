#!/usr/bin/env bash
set -euo pipefail

# Extensions to include (lowercase)
EXTS=(js jsx ts tsx json html css scss md)

# Directories (by name) to exclude everywhere
EXCL_DIRS=(node_modules dist build .git coverage .next out .turbo .cache)

echo "Counting lines of code by directory in $(pwd)..."
echo

# Build the prune part: -type d \( -name dir1 -o -name dir2 ... \) -prune
exclude_dirs_expr=( -type d \( )
for d in "${EXCL_DIRS[@]}"; do
  exclude_dirs_expr+=( -name "$d" -o )
done
unset 'exclude_dirs_expr[${#exclude_dirs_expr[@]}-1]' # drop trailing -o
exclude_dirs_expr+=( \) -prune )

# Build the match part: -type f \( -iname '*.ext1' -o -iname '*.ext2' ... \) -print0
name_expr=( -type f \( )
for ext in "${EXTS[@]}"; do
  name_expr+=( -iname "*.${ext}" -o )
done
unset 'name_expr[${#name_expr[@]}-1]' # drop trailing -o
name_expr+=( \) -print0 )

# Collect files safely (null-separated), run wc -l, then aggregate by dir
found_any=0
find . \( "${exclude_dirs_expr[@]}" \) -o \( "${name_expr[@]}" \) \
| xargs -0 -n 100 wc -l \
| awk '
  NF {
    # wc -l output: <lines> <path...>
    lines = $1
    $1 = ""; sub(/^ +/, "", $0)
    file = $0

    # skip summary lines from wc when xargs batches (they look like: "total")
    if (file == "total") next

    # derive directory
    dir = file
    sub(/\/[^\/]*$/, "", dir)
    if (dir == "" || dir == file) dir = "."

    sum[dir] += lines
    total   += lines
    found   = 1
  }
  END {
    if (!found) {
      print "No matching files found."
      exit 0
    }
    for (d in sum) {
      printf "%10d  %s\n", sum[d], d
    }
    print "----------------------------------"
    printf "Total lines of code: %d\n", total
  }
' | sort -nr

