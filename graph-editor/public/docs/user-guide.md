# DagNet User Guide

## Getting Started

### What is DagNet?

DagNet is a visual graph editor for designing and analyzing conversion funnels, decision trees, and probabilistic workflows. It combines the power of visual graph editing with advanced analytics capabilities.

### First Steps

1. **Open the Navigator** - Click the Navigator button or use `Ctrl/Cmd + B`
2. **Load Credentials** - Go to `File > Credentials` to configure your Git repositories
3. **Browse Files** - Use the Navigator to explore graphs, parameters, contexts, and cases
4. **Open a Graph** - Double-click any graph file to start editing

## Core Concepts

### Graphs
- **Nodes**: Represent conversion steps or decision points
- **Edges**: Show the flow between nodes with probability weights
- **Layout**: Visual arrangement of nodes and connections

### Parameters
- **Baseline Values**: Default conversion rates and costs
- **Treatment Values**: Experimental or alternative values
- **Contexts**: Different scenarios or user segments

### What-If Analysis
- **Override Values**: Temporarily change parameters to see impact
- **Path Analysis**: Analyze conversion paths and identify bottlenecks
- **Conditional Probabilities**: Model complex decision trees

## Working with Graphs

### Creating Graphs
1. **New Graph**: `File > New Graph` or `Ctrl/Cmd + Shift + N`
2. **Add Nodes**: Drag from the node palette or double-click empty space
3. **Connect Nodes**: Drag from one node to another to create edges
4. **Set Probabilities**: Use the Properties panel to adjust edge weights

### Editing Nodes
- **Select**: Click on a node to select it
- **Move**: Drag nodes to reposition them
- **Resize**: Use the resize handles on selected nodes
- **Delete**: Press `Delete` key or right-click menu

### Editing Edges
- **Select**: Click on an edge to select it
- **Adjust Weight**: Use the Properties panel or drag the probability slider
- **Delete**: Press `Delete` key or right-click menu

## What-If Analysis

### Setting Overrides
1. **Open What-If Panel**: `Ctrl/Cmd + Shift + W` or click the What-If button
2. **Select Parameters**: Choose which parameters to override
3. **Set Values**: Enter new values for selected parameters
4. **View Impact**: See how changes affect the overall conversion funnel

### Path Analysis
1. **Select Nodes**: Click on start and end nodes
2. **Open Path Analysis**: `Ctrl/Cmd + Shift + P` or click the Path Analysis button
3. **View Results**: See conversion rates, bottlenecks, and optimization opportunities

### Conditional Probabilities
- **Enable Conditionals**: Turn on conditional probability features
- **Set Conditions**: Define when different probabilities apply
- **Test Scenarios**: Use What-If to test different conditional states

## File Management

### Opening Files
- **From Navigator**: Double-click any file in the Navigator
- **From Menu**: `File > Open` or `Ctrl/Cmd + O`
- **Recent Files**: `File > Open Recent` or `Ctrl/Cmd + Shift + O`

### Saving Changes
- **Auto-Save**: Changes are automatically saved to IndexedDB
- **Commit Changes**: Use the commit system to save to Git repositories
- **Export**: Save graphs as JSON or YAML files

### Working with Git
- **Configure Credentials**: Set up repository access in `File > Credentials`
- **Pull Latest**: Get the latest changes from remote repositories
- **Commit Changes**: Save your changes to the repository
- **Branch Management**: Create and switch between branches

## Tips and Best Practices

### Graph Design
- **Keep It Simple**: Start with basic flows and add complexity gradually
- **Use Descriptive Names**: Give nodes and edges meaningful names
- **Organize Layout**: Arrange nodes logically from left to right
- **Test Scenarios**: Use What-If analysis to validate your assumptions

### Performance
- **Large Graphs**: Break complex funnels into smaller, focused graphs
- **Regular Saves**: Commit changes frequently to avoid data loss
- **Clean Up**: Remove unused nodes and edges to keep graphs readable

### Collaboration
- **Version Control**: Use Git branches for different experiments
- **Documentation**: Add comments and descriptions to explain complex logic
- **Share Results**: Export graphs and analysis results for team review

## Troubleshooting

### Common Issues
- **Graph Not Loading**: Check your credentials and repository access
- **Changes Not Saving**: Verify you have write permissions to the repository
- **Performance Issues**: Try breaking large graphs into smaller pieces
- **Sync Problems**: Use the pull/commit system to resolve conflicts

### Getting Help
- **Keyboard Shortcuts**: `Help > Keyboard Shortcuts`
- **About**: `Help > About DagNet`
- **Support**: Contact greg@nous.co for technical support
- **Issues**: Report bugs on the GitHub repository

## Advanced Features

### Custom Schemas
- **Parameter Schemas**: Define custom parameter structures
- **Context Schemas**: Create reusable context definitions
- **Case Schemas**: Design experiment case structures

### Integration
- **Google Sheets**: Export data to spreadsheets for analysis
- **Statsig**: Integrate with Statsig for experiment management
- **API Access**: Use the API for programmatic access

### Automation
- **Batch Operations**: Process multiple files at once
- **Scripting**: Use the API to automate common tasks
- **Templates**: Create reusable graph templates
