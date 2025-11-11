# About DagNet

## What is DagNet?

DagNet is a visual graph editor for designing and analyzing conversion funnels, decision trees, and probabilistic workflows. It combines the power of visual graph editing with advanced analytics capabilities.

## Key Features

### 🎨 Visual Graph Editor
- **Interactive Node-Based Interface**: Drag and drop to create conversion funnels
- **Real-Time Visualization**: See your graphs come to life with dynamic rendering
- **Multiple View Modes**: Switch between graph view, raw JSON/YAML, and form editors
- **Enhanced Cost Modeling**: Model monetary and time costs with distributions (normal, lognormal, gamma, uniform) and standard deviations
- **Multi-Currency Support**: Work with GBP, USD, EUR, and custom currencies

### 📊 Advanced Analytics
- **What-If Analysis**: Test different scenarios and see their impact
- **Path Analysis**: Analyze conversion paths and identify bottlenecks
- **Conditional Probabilities**: Model complex decision trees with conditional logic
- **Probabilistic Calculations**: Built-in probability mass calculations and normalization
- **Bayesian Analysis**: Support for Bayesian parameter estimation with n, k, and window_to parameters
- **Data-Driven Parameters**: Connect parameters to Google Sheets and Amplitude for live data

### 🔧 Developer-Friendly
- **Monaco Editor Integration**: Full-featured code editor with syntax highlighting
- **Schema Validation**: Automatic validation using JSON schemas
- **Git Integration**: Direct integration with Git repositories for version control
- **Export Capabilities**: Export graphs in multiple formats (JSON, YAML, PNG)
- **Parameter Registry**: Centralized parameter management system with versioning
- **Multiple Object Types**: Work with graphs, parameters, contexts, cases, nodes, and credentials
- **Data Connections**: Bidirectional sync between graphs and external data sources

### 🌐 Modern Web Architecture
- **React + TypeScript**: Built with modern web technologies
- **IndexedDB Storage**: Client-side persistence with offline capabilities
- **Responsive Design**: Works on desktop and tablet devices
- **Multiple Repositories**: Connect to and manage multiple Git repositories simultaneously
- **Credential Management**: Secure credential storage with encryption support
- **URL Configuration**: Pre-configure app settings and credentials via URL parameters

## Use Cases

### Marketing & Growth
- **Conversion Funnel Design**: Model and optimize user journeys
- **A/B Testing**: Design experiments and analyze results
- **Attribution Modeling**: Understand customer touchpoints

### Product Management
- **User Flow Analysis**: Map user interactions and decision points
- **Feature Impact Analysis**: Predict the impact of new features
- **Process Optimization**: Identify bottlenecks and improvement opportunities

### Data Science
- **Decision Tree Modeling**: Create and analyze decision trees
- **Probabilistic Workflows**: Model uncertain processes with cost and time distributions
- **Scenario Planning**: Test different business scenarios with parameterized cases
- **Bayesian Inference**: Use real-world data to update probability estimates
- **Data Integration**: Connect to Google Sheets and Amplitude for data-driven modeling

## Technical Architecture

### Frontend
- **React 18**: Modern React with hooks and concurrent features
- **TypeScript**: Type-safe development
- **ReactFlow**: Professional graph visualization
- **Monaco Editor**: VS Code's editor in the browser
- **Zustand**: Lightweight state management
- **Radix UI**: Accessible component primitives

### Backend Integration
- **GitHub API**: Direct integration with multiple Git repositories
- **Google Sheets API**: Read and write parameters from spreadsheets
- **Amplitude Analytics**: Query conversion and event data
- **RESTful APIs**: Clean API design for external integrations
- **Webhook Support**: Real-time updates and notifications
- **System Credentials**: Environment-based credentials for serverless deployments

### Data Formats
- **JSON**: Primary data format for graphs and configurations
- **YAML**: Human-readable configuration files for parameters, contexts, and cases
- **Schema Validation**: JSON Schema for data integrity
- **Conversion Graph Schema**: Version 1.0.0 schema for graph definitions
- **Parameter Schema**: Extended schema with data source connections and Bayesian parameters

## Version Information

- **Version**: 0.9.0-alpha
- **Release Date**: November 2025
- **License**: MIT
- **Repository**: [github.com/gjbm2/dagnet](https://github.com/gjbm2/dagnet)

### What's New in 0.9 Alpha

- **Data Connections & Adapters**: Full DAS (Data Adapter Service) implementation with support for Amplitude, Google Sheets, PostgreSQL, and custom adapters
- **Time-Series Data**: Daily data breakdowns with incremental fetching and window aggregation
- **Batch Operations**: Bulk data fetching and updates across multiple parameters
- **Window Selector**: Date range selection with automatic data coverage checking
- **Query Signature Validation**: Automatic detection of query parameter changes
- **Enhanced Update Manager**: Improved sync between graph, file, and external sources
- **Statistical Enhancement**: Inverse-variance weighting and pluggable statistical methods

## Getting Started

1. **Configure Credentials**: Open Settings to connect your Git repositories and data sources
2. **Open a Graph**: Use the navigator to browse and open existing graphs
3. **Create New Objects**: Create graphs, parameters, contexts, cases, or nodes
4. **Edit Visually**: Drag nodes, connect edges, set probabilities and costs
5. **Link Parameters**: Connect graph elements to parameter files for data-driven modeling
6. **Connect Data Sources**: Link parameters to Google Sheets or Amplitude for live data
7. **Analyze**: Use What-If analysis and Path Analysis tools
8. **Export**: Save your work or export for external use

## Support

- **Documentation**: [GitHub Docs](https://github.com/gjbm2/dagnet/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/gjbm2/dagnet/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gjbm2/dagnet/discussions)

## Contributing

DagNet is open source and welcomes contributions! See our [Contributing Guide](https://github.com/gjbm2/dagnet/blob/main/CONTRIBUTING.md) for details.

## Credits

You can't do stuff like this without some serious open source goodness. *I* couldn't have done it without Anthropic & OpenAI; credit where it's due. 

Support / bugs / love &c. @gregmarsh / [greg@nous.co](mailto:greg@nous.co)