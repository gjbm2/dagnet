/**
 * Sample Data Integrity Test
 * 
 * Runs validation over the sample data in param-registry/test/
 * to ensure all files are correctly structured and synchronized.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// Sample data location
const SAMPLE_DATA_PATH = path.resolve(__dirname, '../../../../param-registry/test');

interface IndexEntry {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  file_path: string;
}

interface FileData {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
}

describe('Sample Data Integrity', () => {
  
  describe('Index-File Synchronisation', () => {
    
    it('events-index.yaml entries match their corresponding files', async () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'events-index.yaml');
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      const index = yaml.parse(indexContent);
      
      const mismatches: string[] = [];
      
      for (const entry of index.events as IndexEntry[]) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        
        if (!fs.existsSync(filePath)) {
          mismatches.push(`${entry.id}: File not found at ${entry.file_path}`);
          continue;
        }
        
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const fileData = yaml.parse(fileContent) as FileData;
        
        // Events index has name - check it matches
        if (entry.name && fileData.name && entry.name !== fileData.name) {
          mismatches.push(`${entry.id}: name mismatch - index: "${entry.name}" vs file: "${fileData.name}"`);
        }
        
        // Events index has description - check it matches (only if both exist)
        if (entry.description && fileData.description && entry.description !== fileData.description) {
          mismatches.push(`${entry.id}: description mismatch - index: "${entry.description}" vs file: "${fileData.description}"`);
        }
        
        // Category should match if both exist
        if (entry.category && fileData.category && entry.category !== fileData.category) {
          mismatches.push(`${entry.id}: category mismatch - index: "${entry.category}" vs file: "${fileData.category}"`);
        }
      }
      
      expect(mismatches, `Event sync issues:\n${mismatches.join('\n')}`).toHaveLength(0);
    });
    
    it('parameters-index.yaml entries reference existing files', async () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'parameters-index.yaml');
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      const index = yaml.parse(indexContent);
      
      const missingFiles: string[] = [];
      
      for (const entry of index.parameters as IndexEntry[]) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        
        if (!fs.existsSync(filePath)) {
          missingFiles.push(`${entry.id}: File not found at ${entry.file_path}`);
        }
      }
      
      expect(missingFiles, `Missing parameter files:\n${missingFiles.join('\n')}`).toHaveLength(0);
    });
    
    it('nodes-index.yaml entries reference existing files', async () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'nodes-index.yaml');
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      const index = yaml.parse(indexContent);
      
      const missingFiles: string[] = [];
      
      for (const entry of index.nodes as IndexEntry[]) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        
        if (!fs.existsSync(filePath)) {
          missingFiles.push(`${entry.id}: File not found at ${entry.file_path}`);
        }
      }
      
      expect(missingFiles, `Missing node files:\n${missingFiles.join('\n')}`).toHaveLength(0);
    });
    
    it('contexts-index.yaml entries reference existing files with valid type', async () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'contexts-index.yaml');
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      const index = yaml.parse(indexContent);
      
      const issues: string[] = [];
      
      for (const entry of index.contexts as IndexEntry[]) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        
        if (!fs.existsSync(filePath)) {
          issues.push(`${entry.id}: File not found at ${entry.file_path}`);
          continue;
        }
        
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const fileData = yaml.parse(fileContent) as FileData;
        
        // Context files should have 'type' field
        if (!fileData.type) {
          issues.push(`${entry.id}: missing 'type' field in file`);
        }
      }
      
      expect(issues, `Context issues:\n${issues.join('\n')}`).toHaveLength(0);
    });
    
    it('cases-index.yaml entries reference existing files', async () => {
      const indexPath = path.join(SAMPLE_DATA_PATH, 'cases-index.yaml');
      const indexContent = fs.readFileSync(indexPath, 'utf-8');
      const index = yaml.parse(indexContent);
      
      const missingFiles: string[] = [];
      
      for (const entry of index.cases as IndexEntry[]) {
        const filePath = path.join(SAMPLE_DATA_PATH, entry.file_path);
        
        if (!fs.existsSync(filePath)) {
          missingFiles.push(`${entry.id}: File not found at ${entry.file_path}`);
        }
      }
      
      expect(missingFiles, `Missing case files:\n${missingFiles.join('\n')}`).toHaveLength(0);
    });
  });
  
  describe('Graph Referential Integrity', () => {
    
    it('ecommerce-checkout-flow.json references only existing files', async () => {
      const graphPath = path.join(SAMPLE_DATA_PATH, 'graphs/ecommerce-checkout-flow.json');
      const graphContent = fs.readFileSync(graphPath, 'utf-8');
      const graph = JSON.parse(graphContent);
      
      // Load all available IDs
      const parameterIds = new Set<string>();
      const eventIds = new Set<string>();
      const caseIds = new Set<string>();
      
      // Load parameter IDs
      const paramsIndex = yaml.parse(fs.readFileSync(path.join(SAMPLE_DATA_PATH, 'parameters-index.yaml'), 'utf-8'));
      for (const p of paramsIndex.parameters) {
        parameterIds.add(p.id);
      }
      
      // Load event IDs
      const eventsIndex = yaml.parse(fs.readFileSync(path.join(SAMPLE_DATA_PATH, 'events-index.yaml'), 'utf-8'));
      for (const e of eventsIndex.events) {
        eventIds.add(e.id);
      }
      
      // Load case IDs
      const casesIndex = yaml.parse(fs.readFileSync(path.join(SAMPLE_DATA_PATH, 'cases-index.yaml'), 'utf-8'));
      for (const c of casesIndex.cases) {
        caseIds.add(c.id);
      }
      
      const missingRefs: string[] = [];
      
      // Check node references
      for (const node of graph.nodes) {
        // Event references
        if (node.event_id && !eventIds.has(node.event_id)) {
          missingRefs.push(`Node ${node.id}: references non-existent event "${node.event_id}"`);
        }
        
        // Case references (only if node.type !== 'case' - inline definitions are OK)
        if (node.case?.id && node.type !== 'case' && !caseIds.has(node.case.id)) {
          missingRefs.push(`Node ${node.id}: references non-existent case "${node.case.id}"`);
        }
      }
      
      // Check edge references
      for (const edge of graph.edges) {
        // Parameter references in p.id
        if (edge.p?.id && !parameterIds.has(edge.p.id)) {
          missingRefs.push(`Edge ${edge.id}: references non-existent parameter "${edge.p.id}"`);
        }
        
        // Parameter references in cost_gbp.id
        if (edge.cost_gbp?.id && !parameterIds.has(edge.cost_gbp.id)) {
          missingRefs.push(`Edge ${edge.id}: references non-existent cost parameter "${edge.cost_gbp.id}"`);
        }
        
        // Parameter references in cost_time.id
        if (edge.cost_time?.id && !parameterIds.has(edge.cost_time.id)) {
          missingRefs.push(`Edge ${edge.id}: references non-existent time parameter "${edge.cost_time.id}"`);
        }
        
        // Parameter references in conditional_p
        if (edge.conditional_p) {
          for (const cp of edge.conditional_p) {
            if (cp.p?.id && !parameterIds.has(cp.p.id)) {
              missingRefs.push(`Edge ${edge.id}: conditional_p references non-existent parameter "${cp.p.id}"`);
            }
          }
        }
      }
      
      expect(missingRefs, `Missing references:\n${missingRefs.join('\n')}`).toHaveLength(0);
    });
  });
  
  describe('File Structure Validation', () => {
    
    it('all index files exist', async () => {
      const indexFiles = [
        'events-index.yaml',
        'parameters-index.yaml',
        'nodes-index.yaml',
        'contexts-index.yaml',
        'cases-index.yaml',
      ];
      
      const missing: string[] = [];
      for (const indexFile of indexFiles) {
        const indexPath = path.join(SAMPLE_DATA_PATH, indexFile);
        if (!fs.existsSync(indexPath)) {
          missing.push(indexFile);
        }
      }
      
      expect(missing, `Missing index files: ${missing.join(', ')}`).toHaveLength(0);
    });
    
    it('all graph files exist and are valid JSON', async () => {
      const graphFiles = [
        'graphs/ecommerce-checkout-flow.json',
        'graphs/sample.json',
      ];
      
      const issues: string[] = [];
      for (const graphFile of graphFiles) {
        const graphPath = path.join(SAMPLE_DATA_PATH, graphFile);
        if (!fs.existsSync(graphPath)) {
          issues.push(`${graphFile}: file not found`);
          continue;
        }
        
        try {
          const content = fs.readFileSync(graphPath, 'utf-8');
          JSON.parse(content);
        } catch (e) {
          issues.push(`${graphFile}: invalid JSON - ${e}`);
        }
      }
      
      expect(issues, `Graph file issues:\n${issues.join('\n')}`).toHaveLength(0);
    });
    
    it('all referenced files are valid YAML', async () => {
      const dirs = ['parameters', 'events', 'nodes', 'contexts', 'cases'];
      const issues: string[] = [];
      
      for (const dir of dirs) {
        const dirPath = path.join(SAMPLE_DATA_PATH, dir);
        if (!fs.existsSync(dirPath)) continue;
        
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml'));
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            yaml.parse(content);
          } catch (e) {
            issues.push(`${dir}/${file}: invalid YAML - ${e}`);
          }
        }
      }
      
      expect(issues, `YAML validation issues:\n${issues.join('\n')}`).toHaveLength(0);
    });
  });
});
