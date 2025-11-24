# Version Management Guide

## Overview

DagNet uses semantic versioning with a single source of truth in `package.json`. The version is automatically injected into the app at build time and displayed on the welcome screen.

## Current Version

**v0.91.0-beta** (displays as "0.91b")

## Version Location

### Single Source of Truth
```
graph-editor/package.json
  └─ "version": "0.91.0-beta"
```

### Displayed Locations
1. **Welcome Screen** - `AppShell.tsx` - Shows short version (0.91b)
2. **Build Metadata** - Injected via `vite.config.ts`
3. **Version Module** - `src/version.ts` - Exports version constants

## Version Format

### Semantic Versioning
```
MAJOR.MINOR.PATCH-PRERELEASE

Examples:
  0.91.0-beta  → Pre-release beta
  1.0.0        → Stable release
  1.2.3-alpha  → Pre-release alpha
```

### Display Format (Short)
```
MAJOR.MINOR[PRERELEASE]

0.91.0-beta  →  0.91b
1.0.0        →  1.0
2.3.5-alpha  →  2.3a
```

## Updating the Version

### Method 1: Using npm version (Recommended)

```bash
# Bump patch version (0.91.0 → 0.91.1)
npm version patch

# Bump minor version (0.91.0 → 0.92.0)
npm version minor

# Bump major version (0.91.0 → 1.0.0)
npm version major

# Set specific prerelease
npm version 0.91.0-beta

# Bump prerelease (0.91.0-beta → 0.91.0-beta.1)
npm version prerelease
```

**Benefits:**
- ✅ Automatically updates `package.json`
- ✅ Creates a git commit with message "v0.91.0-beta"
- ✅ Creates a git tag "v0.91.0-beta"
- ✅ Single command, no manual steps

### Method 2: Manual Edit

1. Edit `graph-editor/package.json`:
   ```json
   {
     "version": "0.92.0-beta"
   }
   ```

2. Commit and tag:
   ```bash
   git add graph-editor/package.json
   git commit -m "Release v0.92.0-beta"
   git tag v0.92.0-beta
   git push origin main --tags
   ```

## Build-Time Injection

The version is injected at build time via `vite.config.ts`:

```typescript
// Reads from package.json
const version = packageJson.version;
const versionShort = "0.91b"; // Formatted

// Injected as environment variables
define: {
  'import.meta.env.VITE_APP_VERSION': '"0.91b"',
  'import.meta.env.VITE_APP_VERSION_FULL': '"0.91.0-beta"',
  'import.meta.env.VITE_BUILD_TIMESTAMP': '"2025-01-15T10:30:00Z"',
  'import.meta.env.VITE_GIT_COMMIT': '"abc1234"',
}
```

## Git Workflow

### Release Process

```bash
# 1. Update version
cd graph-editor
npm version 0.91.0-beta

# 2. Push commit and tag
git push origin main --tags

# 3. Build and deploy
npm run build

# Optional: Create GitHub release
gh release create v0.91.0-beta \
  --title "v0.91.0-beta" \
  --notes "Beta release with new features..." \
  --prerelease
```

### Version Tags in Git

```bash
# List all version tags
git tag -l "v*"

# View tag details
git show v0.91.0-beta

# Checkout specific version
git checkout v0.91.0-beta

# Delete tag (if mistake)
git tag -d v0.91.0-beta
git push origin :refs/tags/v0.91.0-beta
```

## Accessing Version in Code

### In TypeScript/React

```typescript
// Import from version module
import { APP_VERSION, APP_VERSION_SHORT, VERSION_INFO } from './version';

console.log(APP_VERSION);       // "0.91.0-beta"
console.log(APP_VERSION_SHORT);  // "0.91b"

// Or use environment variables directly
const version = import.meta.env.VITE_APP_VERSION;  // "0.91b"
```

### In JSX

```tsx
<p>Version: {import.meta.env.VITE_APP_VERSION}</p>
```

### In Templates/HTML

```html
<!-- Vite will replace this at build time -->
<meta name="version" content="%VITE_APP_VERSION%" />
```

## Version History Tracking

### In Git

```bash
# View all releases
git log --oneline --decorate --tags

# View changes between versions
git log v0.90.0..v0.91.0-beta

# Generate changelog
git log --pretty=format:"- %s" v0.90.0..v0.91.0-beta > CHANGELOG.md
```

### In package.json Scripts

Add these to `scripts` in `package.json`:

```json
{
  "scripts": {
    "version": "git add -A",
    "postversion": "git push && git push --tags",
    "changelog": "git log --pretty=format:'- %s' $(git describe --tags --abbrev=0)..HEAD"
  }
}
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Get version
        id: version
        run: echo "VERSION=$(node -p "require('./graph-editor/package.json').version")" >> $GITHUB_OUTPUT
      - name: Build
        run: cd graph-editor && npm run build
      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          name: Release ${{ steps.version.outputs.VERSION }}
          draft: false
          prerelease: ${{ contains(steps.version.outputs.VERSION, '-') }}
```

### Vercel Deployment

Vercel automatically reads the version from `package.json` and includes it in build metadata.

## Best Practices

### 1. **Version Naming Convention**
- Use semantic versioning (MAJOR.MINOR.PATCH)
- Add prerelease tags for non-stable releases: `-alpha`, `-beta`, `-rc.1`
- Always prefix git tags with `v`: `v0.91.0-beta`

### 2. **When to Bump**
- **Patch (0.91.0 → 0.91.1)**: Bug fixes, minor tweaks
- **Minor (0.91.0 → 0.92.0)**: New features, backwards compatible
- **Major (0.91.0 → 1.0.0)**: Breaking changes, major milestones

### 3. **Prerelease Workflow**
```bash
# Start alpha
npm version 0.92.0-alpha

# Release beta
npm version 0.92.0-beta

# Release candidate
npm version 0.92.0-rc.1

# Final release
npm version 0.92.0
```

### 4. **Documentation**
- Update `CHANGELOG.md` with each release
- Tag GitHub releases with release notes
- Keep `README.md` version badge updated

## Troubleshooting

### Version not updating in app?

1. **Clear build cache:**
   ```bash
   rm -rf graph-editor/dist graph-editor/node_modules/.vite
   npm run build
   ```

2. **Hard refresh browser:** Ctrl+Shift+R (or Cmd+Shift+R on Mac)

3. **Check environment variables:**
   ```bash
   grep VITE_APP_VERSION graph-editor/dist/assets/*.js
   ```

### Git tag conflicts?

```bash
# Delete local tag
git tag -d v0.91.0-beta

# Delete remote tag
git push origin :refs/tags/v0.91.0-beta

# Recreate tag
npm version 0.91.0-beta --force
git push --tags
```

### npm version fails?

Ensure you have no uncommitted changes:
```bash
git status
git add -A
git commit -m "Prepare for release"
npm version patch
```

## Examples

### Complete Release Workflow

```bash
# 1. Finish development work
git add -A
git commit -m "Add new graph rendering features"

# 2. Update version and create tag
cd graph-editor
npm version 0.92.0-beta

# 3. Push to remote (with tags)
git push origin main --tags

# 4. Build production bundle
npm run build

# 5. Deploy to Vercel (automatic on push)
# Vercel sees the new tag and deploys

# 6. Verify deployment
curl https://dagnet.vercel.app | grep "0.92b"

# 7. Create GitHub release
gh release create v0.92.0-beta \
  --title "v0.92.0-beta - Enhanced Rendering" \
  --notes "- New graph rendering engine
  - Improved performance
  - Bug fixes"
```

### Hotfix Workflow

```bash
# 1. Create hotfix branch from tag
git checkout -b hotfix/0.91.1 v0.91.0-beta

# 2. Fix the bug
git commit -m "Fix critical rendering bug"

# 3. Bump patch version
cd graph-editor
npm version patch  # 0.91.0-beta → 0.91.1-beta

# 4. Merge back to main
git checkout main
git merge hotfix/0.91.1
git push --tags
```

## Related Files

- `graph-editor/package.json` - Version source
- `graph-editor/vite.config.ts` - Build-time injection
- `graph-editor/src/version.ts` - Version utilities
- `graph-editor/src/AppShell.tsx` - Welcome screen display
- `docs/VERSION_MANAGEMENT.md` - This file

