/**
 * IntegrityCheckService – face-alignment checks
 *
 * Validates handle value validity, direction consistency,
 * geometric plausibility, and mixed-direction face detection.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi } from 'vitest';
import { IntegrityCheckService } from '../integrityCheckService';

vi.mock('../../db/appDatabase', () => {
  const files: any[] = [];
  return {
    db: {
      files: {
        toArray: vi.fn(async () => files),
      },
      __setFiles: (next: any[]) => {
        files.length = 0;
        files.push(...next);
      },
    },
  };
});

vi.mock('../logFileService', () => ({
  LogFileService: {
    createLogFile: vi.fn(async () => {}),
  },
}));

vi.mock('../../lib/credentials', () => ({
  credentialsManager: {
    loadCredentials: vi.fn(async () => ({ success: true, credentials: { providers: {} } })),
  },
}));

const { db } = await import('../../db/appDatabase');

/** Helper: build a minimal graph file entry for the mock DB */
function makeGraphFile(nodes: any[], edges: any[], fileId = 'graph-test') {
  return {
    fileId,
    type: 'graph',
    source: { repository: 'repo', branch: 'main', path: `graphs/${fileId}.json` },
    data: {
      schema_version: '1.1.0',
      metadata: { version: '1.0.0', created_at: '2025-12-15T00:00:00.000Z' },
      policies: { default_outcome: 'success' },
      nodes,
      edges,
    },
  };
}

/** Helper: extract face-alignment issues from a result */
function faceIssues(result: any) {
  return result.issues.filter((i: any) => i.category === 'face-alignment');
}

describe('IntegrityCheckService face-alignment', () => {
  it('should flag invalid handle values as errors', async () => {
    (db as any).__setFiles([
      makeGraphFile(
        [
          { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } },
          { id: 'B', uuid: 'B', label: 'B', layout: { x: 200, y: 0 } },
        ],
        [
          {
            id: 'a-to-b',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            fromHandle: 'middle-out',
            toHandle: 'diagonal',
          },
        ]
      ),
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const issues = faceIssues(res);

    expect(issues.length).toBe(2);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('invalid source handle');
    expect(issues[1].severity).toBe('error');
    expect(issues[1].message).toContain('invalid target handle');
  });

  it('should warn when source handle is marked as input', async () => {
    (db as any).__setFiles([
      makeGraphFile(
        [
          { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } },
          { id: 'B', uuid: 'B', label: 'B', layout: { x: 200, y: 0 } },
        ],
        [
          {
            id: 'a-to-b',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            fromHandle: 'right-in',
            toHandle: 'left',
          },
        ]
      ),
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const issues = faceIssues(res);

    expect(issues.some((i: any) => i.severity === 'warning' && i.message.includes('marked as input'))).toBe(true);
  });

  it('should warn when target handle is marked as output', async () => {
    (db as any).__setFiles([
      makeGraphFile(
        [
          { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } },
          { id: 'B', uuid: 'B', label: 'B', layout: { x: 200, y: 0 } },
        ],
        [
          {
            id: 'a-to-b',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            fromHandle: 'right-out',
            toHandle: 'left-out',
          },
        ]
      ),
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const issues = faceIssues(res);

    expect(issues.some((i: any) => i.severity === 'warning' && i.message.includes('marked as output'))).toBe(true);
  });

  it('should flag geometrically implausible face assignments as info', async () => {
    // B is directly below A, but edge uses right→left (horizontal faces for a vertical relationship)
    (db as any).__setFiles([
      makeGraphFile(
        [
          { id: 'A', uuid: 'A', label: 'A', layout: { x: 100, y: 0 } },
          { id: 'B', uuid: 'B', label: 'B', layout: { x: 100, y: 300 } },
        ],
        [
          {
            id: 'a-to-b',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            fromHandle: 'right-out',
            toHandle: 'left',
          },
        ]
      ),
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const issues = faceIssues(res);

    expect(issues.some((i: any) => i.severity === 'info' && i.message.includes('points away from target'))).toBe(true);
    expect(issues.some((i: any) => i.severity === 'info' && i.message.includes('points away from source'))).toBe(true);
  });

  it('should flag mixed-direction faces as info', async () => {
    // Node B receives on 'left' from A and sends on 'left' to C — mixed direction on left face
    (db as any).__setFiles([
      makeGraphFile(
        [
          { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } },
          { id: 'B', uuid: 'B', label: 'B', layout: { x: 200, y: 0 } },
          { id: 'C', uuid: 'C', label: 'C', layout: { x: 0, y: 200 } },
        ],
        [
          {
            id: 'a-to-b',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            fromHandle: 'right-out',
            toHandle: 'left',
          },
          {
            id: 'b-to-c',
            uuid: 'e2',
            from: 'B',
            to: 'C',
            fromHandle: 'left-out',
            toHandle: 'right',
          },
        ]
      ),
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const issues = faceIssues(res);

    expect(issues.some((i: any) =>
      i.severity === 'info' &&
      i.message.includes('Node "B"') &&
      i.message.includes('"left" face')
    )).toBe(true);
  });

  it('should report no face-alignment issues for a clean graph', async () => {
    (db as any).__setFiles([
      makeGraphFile(
        [
          { id: 'A', uuid: 'A', label: 'A', layout: { x: 0, y: 0 } },
          { id: 'B', uuid: 'B', label: 'B', layout: { x: 200, y: 0 } },
          { id: 'C', uuid: 'C', label: 'C', layout: { x: 400, y: 0 } },
        ],
        [
          {
            id: 'a-to-b',
            uuid: 'e1',
            from: 'A',
            to: 'B',
            fromHandle: 'right-out',
            toHandle: 'left',
          },
          {
            id: 'b-to-c',
            uuid: 'e2',
            from: 'B',
            to: 'C',
            fromHandle: 'right-out',
            toHandle: 'left',
          },
        ]
      ),
    ]);

    const res = await IntegrityCheckService.checkIntegrity({} as any, false);
    const issues = faceIssues(res);

    expect(issues.length).toBe(0);
  });
});
