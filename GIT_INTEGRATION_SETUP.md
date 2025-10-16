# Git Integration Setup Guide

## Overview

The graph editor now supports Git integration for pulling and pushing graphs to GitHub repositories. This allows you to:

- **Pull graphs** from GitHub repositories
- **Push graphs** to GitHub repositories  
- **Manage branches** for different graph versions
- **Version control** your conversion funnels

## Configuration

### 1. Environment Variables

Create a `.env.local` file in the `graph-editor` directory with the following configuration:

```bash
# Git Repository Configuration
VITE_GIT_REPO_OWNER=gjbm2
VITE_GIT_REPO_NAME=dagnet
VITE_GIT_REPO_BRANCH=main
VITE_GIT_GRAPHS_PATH=graphs
VITE_GIT_PARAMS_PATH=param-registry

# GitHub API Configuration
VITE_GITHUB_API_BASE=https://api.github.com
VITE_GITHUB_TOKEN=your_github_token_here

# Development Configuration
VITE_DEV_MODE=true
VITE_DEBUG_GIT_OPERATIONS=false
```

### 2. GitHub Token Setup

1. **Create a GitHub Personal Access Token:**
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Click "Generate new token (classic)"
   - Give it a name like "Dagnet Graph Editor"
   - Select scopes: `repo` (full control of private repositories)
   - Click "Generate token"
   - Copy the token (you won't see it again!)

2. **Add the token to your `.env.local` file:**
   ```bash
   VITE_GITHUB_TOKEN=ghp_your_token_here
   ```

### 3. Repository Structure

The system expects the following repository structure:

```
your-repo/
├── graphs/           # Graph files (.json)
│   ├── funnel-1.json
│   ├── funnel-2.json
│   └── ...
└── param-registry/   # Parameter registry files
    ├── registry.yaml
    ├── parameters/
    │   ├── probability/
    │   ├── cost/
    │   └── time/
    └── schemas/
```

## Usage

### Git Operations Panel

The Git Operations panel appears in the right sidebar and provides:

1. **Branch Selection**: Choose which branch to work with
2. **Show Graphs**: View available graphs in the selected branch
3. **Load Graph**: Load a graph from the repository
4. **Save Graph**: Save the current graph to the repository
5. **Delete Graph**: Remove a graph from the repository

### Pulling Graphs

1. **Select Branch**: Choose the branch you want to pull from
2. **Click "Show Graphs"**: View available graphs
3. **Click "Load"**: Load a specific graph into the editor

### Pushing Graphs

1. **Create/Edit Graph**: Build your conversion funnel
2. **Click "Save Graph"**: Opens the save dialog
3. **Enter Details**:
   - Graph name (e.g., "ecommerce-funnel")
   - Commit message (e.g., "Add new conversion funnel")
4. **Click "Save Graph"**: Saves to the selected branch

### Branch Management

- **Default Branch**: `main` (configurable)
- **Switch Branches**: Use the branch dropdown
- **Create Branches**: Not yet implemented (coming soon)

## Features

### ✅ Implemented

- **Pull Graphs**: Load graphs from GitHub
- **Push Graphs**: Save graphs to GitHub
- **Branch Selection**: Switch between branches
- **Graph Management**: List, load, save, delete graphs
- **Error Handling**: Comprehensive error messages
- **Loading States**: Visual feedback during operations

### 🚧 Coming Soon

- **Branch Creation**: Create new branches for graph versions
- **Merge Operations**: Merge graph changes between branches
- **Conflict Resolution**: Handle merge conflicts
- **Graph History**: View commit history for graphs
- **Parameter Integration**: Pull/push parameter registry

## API Rate Limits

### GitHub API Limits (Free Tier)

- **5,000 requests/hour** for authenticated requests
- **Small file sizes** - graphs typically 10-50KB
- **Low concurrency** - 1-2 users
- **No risk of hitting limits** with current usage patterns

### Cost Analysis

- **Free GitHub API** - no additional hosting costs
- **Small file sizes** - minimal bandwidth usage
- **Serverless architecture** - no server maintenance
- **Git-based persistence** - leverages existing Git infrastructure

## Troubleshooting

### Common Issues

1. **"Failed to fetch branches"**
   - Check your GitHub token has `repo` scope
   - Verify the repository exists and is accessible
   - Check network connectivity

2. **"Failed to load graphs"**
   - Ensure the `graphs` directory exists in your repository
   - Check the branch exists and has content
   - Verify file permissions

3. **"Failed to save graph"**
   - Check your GitHub token has write permissions
   - Verify the repository is not read-only
   - Ensure you have push access to the branch

### Debug Mode

Enable debug mode to see detailed API requests:

```bash
VITE_DEBUG_GIT_OPERATIONS=true
```

This will log all GitHub API requests to the browser console.

## Security Notes

### Token Security

- **Never commit tokens** to version control
- **Use `.env.local`** for local development
- **Rotate tokens** regularly
- **Use minimal scopes** (only `repo` for this use case)

### Repository Access

- **Private repositories** require authentication
- **Public repositories** work without authentication (limited functionality)
- **Organization repositories** may require additional permissions

## Next Steps

1. **Set up your repository** with the required structure
2. **Create a GitHub token** with appropriate permissions
3. **Configure environment variables** in `.env.local`
4. **Test the integration** by pulling and pushing graphs
5. **Set up parameter registry** integration (coming soon)

## Support

If you encounter issues:

1. **Check the browser console** for error messages
2. **Verify your configuration** matches the setup guide
3. **Test with a simple repository** first
4. **Enable debug mode** for detailed logging

The Git integration provides a robust foundation for version-controlling your conversion funnels while maintaining the simplicity of the graph editor interface.
