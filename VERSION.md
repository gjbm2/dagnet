# DagNet Version

**Current Version:** `0.91.0-beta` (displays as `v0.91b`)

## Quick Commands

```bash
# Update version (from graph-editor directory)
npm version 0.92.0-beta       # Set specific version
npm version patch              # Bump patch (0.91.0 → 0.91.1)
npm version minor              # Bump minor (0.91.0 → 0.92.0)
npm version major              # Bump major (0.91.0 → 1.0.0)

# Push to git with tags
git push origin main --tags

# View current version
node -p "require('./graph-editor/package.json').version"
```

## Where is the version stored?

**Single source:** `graph-editor/package.json` → `"version": "0.91.0-beta"`

**Displayed:**
- Welcome screen (AppShell.tsx)
- Build metadata (automatically injected)
- Git tags (v0.91.0-beta)

## Full Documentation

See [docs/VERSION_MANAGEMENT.md](docs/VERSION_MANAGEMENT.md) for complete guide.

