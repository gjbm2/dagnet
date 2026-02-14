#!/usr/bin/env bash
set -euo pipefail

# Only actual source code extensions (no json, html, css, md)
EXTS=(js jsx ts tsx)

# Directories (by name) to exclude everywhere
EXCL_DIRS=(node_modules dist build .git coverage .next out .turbo .cache)

# Exclude private repo dirs — unless we're running from inside one of them
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/.private-repos.conf"
if [ -f "$CONF" ]; then
  _data_dir=$(grep '^DATA_REPO_DIR=' "$CONF" | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  _mono_dir=$(grep '^MONOREPO_DIR=' "$CONF" | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  _cwd=$(pwd)
  _inside_private=false
  [ -n "$_data_dir" ] && [[ "$_cwd" == "$SCRIPT_DIR/$_data_dir"* ]] && _inside_private=true
  [ -n "$_mono_dir" ] && [[ "$_cwd" == "$SCRIPT_DIR/$_mono_dir"* ]] && _inside_private=true

  if [ "$_inside_private" = false ]; then
    [ -n "$_data_dir" ] && EXCL_DIRS+=("$_data_dir")
    [ -n "$_mono_dir" ] && EXCL_DIRS+=("$_mono_dir")
  fi
fi

echo "Counting source lines of code (excluding blanks/comments) in $(pwd)..."
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

# Use associative array to track seen files (prevent duplicates)
declare -A seen_files

# Process each file, count non-blank, non-comment lines
find . \( "${exclude_dirs_expr[@]}" \) -o \( "${name_expr[@]}" \) | while IFS= read -r -d '' file; do
  # Normalize path to prevent duplicates
  normalized=$(readlink -f "$file" 2>/dev/null || echo "$file")
  
  # Skip if we've already seen this file
  if [[ -n "${seen_files[$normalized]:-}" ]]; then
    continue
  fi
  seen_files[$normalized]=1
  
  # Count lines that are not blank and not comment-only
  # This excludes: empty lines, lines with only whitespace, lines that are only // or /* */ comments
  count=$(grep -vE '^\s*$|^\s*(//|/\*|\*|//)' "$file" | wc -l)
  
  # Output: count and file path
  echo "$count $file"
done | awk '
  {
    lines = $1
    $1 = ""; sub(/^ +/, "", $0)
    file = $0

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
    printf "Total source lines: %d\n", total
  }
' | sort -nr

