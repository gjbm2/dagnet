#!/bin/bash
# CI Check Script
# Run the same checks locally that CI runs before pushing

set -e  # Exit on error

echo "🔍 Running CI checks locally..."
echo ""

cd "$(dirname "$0")/.."

echo "📦 Step 1: Running npm ci..."
npm ci

echo ""
echo "🔍 Step 2: Running TypeScript type check..."
npx tsc --noEmit

echo ""
echo "✅ All CI checks passed!"
echo ""

