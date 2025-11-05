#!/usr/bin/env ts-node
/**
 * Migration Script: ID/Slug Standardization
 * 
 * Renames fields in graph JSON files:
 * - node.id → node.uuid (system UUID)
 * - node.slug → node.id (human-readable)
 * - edge.id → edge.uuid (system UUID)
 * - edge.slug → edge.id (human-readable)
 * 
 * Foreign keys (parameter_id, case_id, event_id) remain unchanged.
 * 
 * Usage:
 *   ts-node scripts/migrate-id-slug.ts <input.json> [output.json]
 *   
 *   If output.json is not specified, creates input.migrated.json
 */

import * as fs from 'fs';
import * as path from 'path';

interface OldNode {
  id: string;
  slug: string;
  label?: string;
  description?: string;
  tags?: string[];
  type?: 'normal' | 'case';
  absorbing?: boolean;
  outcome_type?: string;
  entry?: any;
  costs?: any;
  residual_behavior?: any;
  layout?: any;
  case?: any;
}

interface NewNode {
  uuid: string;
  id: string;
  label?: string;
  description?: string;
  tags?: string[];
  type?: 'normal' | 'case';
  absorbing?: boolean;
  outcome_type?: string;
  entry?: any;
  costs?: any;
  residual_behavior?: any;
  layout?: any;
  case?: any;
}

interface OldEdge {
  id: string;
  slug?: string;
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
  description?: string;
  p?: any;
  conditional_p?: any;
  weight_default?: number;
  costs?: any;
  case_variant?: string;
  case_id?: string;
  display?: any;
}

interface NewEdge {
  uuid: string;
  id?: string;
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
  description?: string;
  p?: any;
  conditional_p?: any;
  weight_default?: number;
  costs?: any;
  case_variant?: string;
  case_id?: string;
  display?: any;
}

interface OldGraph {
  nodes: OldNode[];
  edges: OldEdge[];
  policies?: any;
  metadata?: any;
}

interface NewGraph {
  nodes: NewNode[];
  edges: NewEdge[];
  policies?: any;
  metadata?: any;
}

function migrateNode(oldNode: OldNode): NewNode {
  return {
    uuid: oldNode.id,           // Old id becomes uuid
    id: oldNode.slug,           // Old slug becomes id
    label: oldNode.label,
    description: oldNode.description,
    tags: oldNode.tags,
    type: oldNode.type,
    absorbing: oldNode.absorbing,
    outcome_type: oldNode.outcome_type,
    entry: oldNode.entry,
    costs: oldNode.costs,
    residual_behavior: oldNode.residual_behavior,
    layout: oldNode.layout,
    case: oldNode.case
  };
}

function migrateEdge(oldEdge: OldEdge, oldNodeIdToUuid: Map<string, string>): NewEdge {
  // Note: edge.from and edge.to reference node IDs
  // In old schema: they reference old node.id (which becomes node.uuid in new schema)
  // So they should remain unchanged (they're already UUIDs)
  
  return {
    uuid: oldEdge.id,           // Old id becomes uuid
    id: oldEdge.slug,           // Old slug becomes id (can be undefined)
    from: oldEdge.from,         // Already references node UUID
    to: oldEdge.to,             // Already references node UUID
    fromHandle: oldEdge.fromHandle,
    toHandle: oldEdge.toHandle,
    description: oldEdge.description,
    p: oldEdge.p,
    conditional_p: oldEdge.conditional_p,
    weight_default: oldEdge.weight_default,
    costs: oldEdge.costs,
    case_variant: oldEdge.case_variant,
    case_id: oldEdge.case_id,   // Foreign key - unchanged
    display: oldEdge.display
  };
}

function migrateGraph(oldGraph: OldGraph): NewGraph {
  // Create mapping of old node IDs for reference
  const oldNodeIdToUuid = new Map<string, string>();
  for (const node of oldGraph.nodes) {
    oldNodeIdToUuid.set(node.id, node.id); // In old schema, node.id IS the UUID
  }

  return {
    nodes: oldGraph.nodes.map(migrateNode),
    edges: oldGraph.edges.map(e => migrateEdge(e, oldNodeIdToUuid)),
    policies: oldGraph.policies,
    metadata: {
      ...oldGraph.metadata,
      updated_at: new Date().toISOString(),
      migration: {
        migrated_at: new Date().toISOString(),
        migration_script: 'migrate-id-slug.ts',
        migration_version: '1.0.0',
        changes: 'Renamed id→uuid and slug→id for nodes and edges'
      }
    }
  };
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: ts-node scripts/migrate-id-slug.ts <input.json> [output.json]');
    process.exit(1);
  }

  const inputPath = args[0];
  const outputPath = args[1] || inputPath.replace('.json', '.migrated.json');

  // Read input file
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Reading graph from: ${inputPath}`);
  const inputData = fs.readFileSync(inputPath, 'utf-8');
  const oldGraph: OldGraph = JSON.parse(inputData);

  // Validate input
  if (!oldGraph.nodes || !oldGraph.edges) {
    console.error('Error: Invalid graph format (missing nodes or edges)');
    process.exit(1);
  }

  console.log(`  Nodes: ${oldGraph.nodes.length}`);
  console.log(`  Edges: ${oldGraph.edges.length}`);

  // Perform migration
  console.log('Migrating...');
  const newGraph = migrateGraph(oldGraph);

  // Write output file
  console.log(`Writing migrated graph to: ${outputPath}`);
  fs.writeFileSync(outputPath, JSON.stringify(newGraph, null, 2));

  console.log('✅ Migration complete!');
  console.log('');
  console.log('Summary:');
  console.log(`  - Renamed node.id → node.uuid for ${newGraph.nodes.length} nodes`);
  console.log(`  - Renamed node.slug → node.id for ${newGraph.nodes.length} nodes`);
  console.log(`  - Renamed edge.id → edge.uuid for ${newGraph.edges.length} edges`);
  console.log(`  - Renamed edge.slug → edge.id for ${newGraph.edges.length} edges`);
  console.log(`  - Foreign keys (parameter_id, case_id, event_id) unchanged`);
}

main();

