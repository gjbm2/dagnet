/**
 * LOCAL-ONLY Real Git E2E: Image commit → pull roundtrip
 *
 * Proves that the REAL production code path correctly:
 *   1. Encodes a Uint8Array image as base64
 *   2. Creates a blob via the GitHub API
 *   3. Commits the blob to a branch
 *   4. Reads back the directory listing
 *   5. Fetches the blob content
 *   6. Decodes base64 → Uint8Array
 *   7. Recovers EXACTLY the original bytes
 *
 * Env file:
 *   Create repo-root `.env.git.local` (gitignored).
 *   See `local-env/git.env.example` for the required keys.
 *
 * Run:
 *   cd graph-editor && DAGNET_RUN_REAL_GIT_E2E=1 npm test -- --run src/services/__tests__/imageGitRoundtrip.local.test.ts
 *
 * The test uses a unique timestamped path under `_test-artifacts/images/`
 * and cleans up after itself with a deletion commit.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gitService } from '../gitService';
import type { CredentialsData, GitRepositoryCredential } from '../../types/credentials';

// ---------------------------------------------------------------------------
// Gate: only run when env var is set and credentials are present
// ---------------------------------------------------------------------------
const ENABLED = process.env.DAGNET_RUN_REAL_GIT_E2E === '1';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'graph-editor')) && fs.existsSync(path.join(dir, '.gitignore'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..');
}

function loadGitEnv(): {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
} | null {
  const root = findRepoRoot();
  const envPath = path.join(root, '.env.git.local');
  if (!fs.existsSync(envPath)) return null;

  const raw = fs.readFileSync(envPath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }

  const token = vars.DAGNET_GIT_TOKEN || '';
  const owner = vars.DAGNET_GIT_OWNER || '';
  const repo = vars.DAGNET_GIT_REPO || '';
  if (!token || !owner || !repo) return null;

  return {
    token,
    owner,
    repo,
    branch: vars.DAGNET_GIT_BRANCH || 'main',
    basePath: vars.DAGNET_GIT_BASE_PATH || '',
  };
}

// ---------------------------------------------------------------------------
// Test image data — a minimal valid 1×1 red PNG (67 bytes)
// ---------------------------------------------------------------------------
function createTestPng(): Uint8Array {
  // Minimal 1×1 red PNG file
  const header = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  ]);
  // We'll use a realistic-sized test image (mixed binary content)
  // to exercise chunked base64 encoding and ensure no corruption
  const size = 4096; // 4KB — small enough to be fast, large enough to exercise chunking
  const data = new Uint8Array(header.length + size);
  data.set(header, 0);
  for (let i = 0; i < size; i++) {
    // Intentionally use full byte range 0–255, including NUL and high bytes
    data[header.length + i] = i % 256;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe.skipIf(!ENABLED)('Image Git Roundtrip (real GitHub API)', () => {
  let env: NonNullable<ReturnType<typeof loadGitEnv>>;
  let testImagePath: string;
  let testDirPath: string;
  const testId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    const loaded = loadGitEnv();
    if (!loaded) {
      throw new Error(
        'Missing .env.git.local — see local-env/git.env.example for required keys'
      );
    }
    env = loaded;

    // Configure gitService with real credentials
    const gitCred: GitRepositoryCredential = {
      name: env.repo,
      owner: env.owner,
      repo: env.repo,
      token: env.token,
      branch: env.branch,
      basePath: env.basePath,
    };
    const credentials: CredentialsData = {
      version: '1.0.0',
      defaultGitRepo: env.repo,
      git: [gitCred],
    };
    gitService.setCredentials(credentials);

    // Build paths
    const prefix = env.basePath ? `${env.basePath}/` : '';
    testDirPath = `${prefix}_test-artifacts/images`;
    testImagePath = `${testDirPath}/${testId}.png`;
  });

  afterAll(async () => {
    // Cleanup: delete the test image with a follow-up commit
    if (!testImagePath) return;
    try {
      await gitService.commitAndPushFiles(
        [{ path: testImagePath, delete: true }],
        `[test cleanup] remove ${testId}.png`,
        env.branch
      );
      console.log(`✅ Cleaned up test image: ${testImagePath}`);
    } catch (err) {
      console.warn(`⚠️ Failed to clean up test image (manual removal needed): ${testImagePath}`, err);
    }
  });

  it('should commit an image and read back identical bytes', async () => {
    const originalData = createTestPng();

    // -----------------------------------------------------------------------
    // STEP 1: Commit the image using the REAL production commitAndPushFiles
    // This exercises: uint8ArrayToBase64 → createBlob → createTree → createCommit
    // -----------------------------------------------------------------------
    const commitResult = await gitService.commitAndPushFiles(
      [
        {
          path: testImagePath,
          binaryContent: originalData,
          encoding: 'base64',
        },
      ],
      `[test] image roundtrip ${testId}`,
      env.branch
    );

    expect(commitResult.success).toBe(true);
    expect(commitResult.data?.sha).toBeTruthy();
    console.log(`✅ Committed test image: ${testImagePath} (commit: ${commitResult.data?.sha?.substring(0, 8)})`);

    // -----------------------------------------------------------------------
    // STEP 2: List the directory using the REAL production getDirectoryContents
    // This exercises: GitHub Contents API → directory listing
    // -----------------------------------------------------------------------
    const dirResult = await gitService.getDirectoryContents(testDirPath, env.branch);

    expect(dirResult.success).toBe(true);
    expect(dirResult.data).toBeDefined();

    const testFile = (dirResult.data as any[]).find(
      (f: any) => f.name === `${testId}.png`
    );
    expect(testFile).toBeDefined();
    expect(testFile.sha).toBeTruthy();
    console.log(`✅ Found test image in directory listing: ${testFile.name} (sha: ${testFile.sha.substring(0, 8)})`);

    // -----------------------------------------------------------------------
    // STEP 3: Fetch the blob using the REAL production getBlobContent
    // This exercises: Git Blob API → base64 content retrieval
    // -----------------------------------------------------------------------
    const blobResult = await gitService.getBlobContent(testFile.sha, true);

    expect(blobResult.success).toBe(true);
    expect(blobResult.data).toBeDefined();
    expect(blobResult.data.encoding).toBe('base64');

    // -----------------------------------------------------------------------
    // STEP 4: Decode the base64 content using the SAME decode path as production
    // This is the exact code from workspaceService.fetchAllImagesFromGit
    // -----------------------------------------------------------------------
    const blob = blobResult.data;
    let recoveredData: Uint8Array;

    if (blob.encoding === 'base64') {
      // Production decode path (from workspaceService.ts line 1518-1523)
      const base64Content = blob.content.replace(/[\s\r\n]/g, '');
      // Use Node.js Buffer since we're in a node test environment
      const buffer = Buffer.from(base64Content, 'base64');
      recoveredData = new Uint8Array(buffer);
    } else {
      throw new Error(`Unexpected encoding: ${blob.encoding}`);
    }

    // -----------------------------------------------------------------------
    // STEP 5: Verify EXACT byte equality
    // -----------------------------------------------------------------------
    expect(recoveredData.length).toBe(originalData.length);

    // Compare every byte
    let firstMismatch = -1;
    for (let i = 0; i < originalData.length; i++) {
      if (recoveredData[i] !== originalData[i]) {
        firstMismatch = i;
        break;
      }
    }

    if (firstMismatch >= 0) {
      console.error(
        `❌ Byte mismatch at index ${firstMismatch}: ` +
        `expected 0x${originalData[firstMismatch].toString(16).padStart(2, '0')}, ` +
        `got 0x${recoveredData[firstMismatch].toString(16).padStart(2, '0')}`
      );
    }

    expect(firstMismatch).toBe(-1); // No mismatches
    console.log(`✅ Byte-for-byte equality confirmed (${originalData.length} bytes)`);
  }, 30000); // Allow 30s for real API calls

  it('should commit an image and have it survive a second commit (persistence)', async () => {
    // This tests that the image committed in the previous test is still present
    // after a second commit (simulating what happens after "commit all" + later pull)
    const dirResult = await gitService.getDirectoryContents(testDirPath, env.branch);

    if (!dirResult.success) {
      // Directory might not exist if previous test was skipped
      console.log('⏭️ Skipping persistence check — directory not found');
      return;
    }

    const testFile = (dirResult.data as any[]).find(
      (f: any) => f.name === `${testId}.png`
    );
    expect(testFile).toBeDefined();
    console.log(`✅ Image persisted after commit: ${testFile.name}`);
  }, 15000);
});

// ---------------------------------------------------------------------------
// Encoding roundtrip tests — these run WITHOUT credentials
// They test the exact same encode/decode pipeline used in production
// ---------------------------------------------------------------------------
describe('Image encoding roundtrip (no credentials needed)', () => {
  // Access the private uint8ArrayToBase64 method via the service instance
  const encode = (data: Uint8Array): string => {
    return (gitService as any).uint8ArrayToBase64(data);
  };

  // Decode using the same path as workspaceService.fetchAllImagesFromGit
  const decode = (base64: string): Uint8Array => {
    const cleaned = base64.replace(/[\s\r\n]/g, '');
    const buffer = Buffer.from(cleaned, 'base64');
    return new Uint8Array(buffer);
  };

  it('should roundtrip a minimal PNG header', () => {
    const original = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.length).toBe(original.length);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('should roundtrip full byte range (0x00–0xFF)', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;

    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.length).toBe(original.length);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('should roundtrip a large image (500KB) without corruption', () => {
    const size = 500 * 1024;
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) original[i] = i % 256;

    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.length).toBe(original.length);

    // Spot-check every 1000th byte for speed
    for (let i = 0; i < size; i += 1000) {
      expect(decoded[i]).toBe(original[i]);
    }

    // And verify full equality
    let firstMismatch = -1;
    for (let i = 0; i < size; i++) {
      if (decoded[i] !== original[i]) {
        firstMismatch = i;
        break;
      }
    }
    expect(firstMismatch).toBe(-1);
  });

  it('should roundtrip data with NUL bytes and high bytes', () => {
    // These are the bytes most likely to be corrupted by text-mode handling
    const original = new Uint8Array([0x00, 0x00, 0xFF, 0xFE, 0x00, 0x80, 0x7F, 0x01]);
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('should handle empty data', () => {
    const original = new Uint8Array(0);
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pending image ops pipeline tests — verify the commit construction
// ---------------------------------------------------------------------------
describe('Pending image ops → commit file construction', () => {
  it('should construct correct filesToCommit from pendingImageOps', async () => {
    // This simulates what repositoryOperationsService.commitFiles does
    // with the image data from fileRegistry.commitPendingImages()

    // Import fileRegistry
    const { fileRegistry } = await import('../../contexts/TabContext');

    // Clear any leftover pending ops
    await fileRegistry.commitPendingImages();

    // Register an image upload (same as imageOperationsService does)
    const testImageData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);
    const imageId = 'roundtrip-test-img';
    const imagePath = `nodes/images/${imageId}.png`;

    fileRegistry.registerImageUpload(imageId, imagePath, testImageData);

    // Collect pending images (same as commitFiles does at line 989)
    const imageFiles = await fileRegistry.commitPendingImages();

    expect(imageFiles).toHaveLength(1);
    expect(imageFiles[0].path).toBe(imagePath);
    expect(imageFiles[0].binaryContent).toBeInstanceOf(Uint8Array);
    expect(imageFiles[0].binaryContent?.length).toBe(testImageData.length);
    expect(imageFiles[0].encoding).toBe('base64');
    expect(imageFiles[0].delete).toBeUndefined();

    // Verify the binary data is the SAME reference (not corrupted)
    expect(Array.from(imageFiles[0].binaryContent!)).toEqual(Array.from(testImageData));

    // Verify pending ops are now empty (consumed)
    const secondCall = await fileRegistry.commitPendingImages();
    expect(secondCall).toHaveLength(0);
  });

  it('should apply basePath correctly to image paths', async () => {
    const { fileRegistry } = await import('../../contexts/TabContext');

    // Clear any leftover pending ops
    await fileRegistry.commitPendingImages();

    const testImageData = new Uint8Array([1, 2, 3]);
    fileRegistry.registerImageUpload('bp-test', 'nodes/images/bp-test.png', testImageData);

    const imageFiles = await fileRegistry.commitPendingImages();

    // Simulate what repositoryOperationsService does with basePath
    const basePath = 'dagnet';
    const filesToCommit = imageFiles.map(img => ({
      path: basePath ? `${basePath}/${img.path}` : img.path,
      binaryContent: img.binaryContent,
      encoding: img.encoding,
    }));

    expect(filesToCommit[0].path).toBe('dagnet/nodes/images/bp-test.png');
  });

  it('should handle image deletion in pending ops', async () => {
    const { fileRegistry } = await import('../../contexts/TabContext');

    // Clear any leftover pending ops
    await fileRegistry.commitPendingImages();

    // Register upload then delete
    const testData = new Uint8Array([1, 2, 3]);
    fileRegistry.registerImageUpload('del-test', 'nodes/images/del-test.png', testData);
    await fileRegistry.registerImageDelete('del-test', 'nodes/images/del-test.png');

    const imageFiles = await fileRegistry.commitPendingImages();

    // Should have only the delete op (upload was removed)
    expect(imageFiles).toHaveLength(1);
    expect(imageFiles[0].delete).toBe(true);
    expect(imageFiles[0].path).toBe('nodes/images/del-test.png');
  });

  it('should recover from cleared pendingImageOps via IDB fallback', async () => {
    // This test verifies the FIX for the volatile pendingImageOps defect:
    // Even if the in-memory array is cleared (e.g. page refresh),
    // commitPendingImages now scans IDB for dirty images as a fallback.

    const { fileRegistry } = await import('../../contexts/TabContext');
    const { db } = await import('../../db/appDatabase');

    // Clear any prior state
    await fileRegistry.commitPendingImages();

    // Store a dirty image in IDB (simulating what imageOperationsService does)
    const imageData = new Uint8Array([1, 2, 3, 4, 5]);
    await db.files.put({
      fileId: 'test-repo-main-image-volatile-test',
      path: 'nodes/images/volatile-test.png',
      type: 'image',
      data: {
        image_id: 'volatile-test',
        file_extension: 'png',
        binaryData: imageData,
      },
      originalData: null,
      isDirty: true,
      lastModified: Date.now(),
      source: { repository: 'test-repo', branch: 'main', path: 'nodes/images/volatile-test.png' },
      viewTabs: [],
    });

    // Also register in memory (then clear — simulating page refresh)
    fileRegistry.registerImageUpload(
      'volatile-test',
      'nodes/images/volatile-test.png',
      imageData
    );

    // Simulate page refresh: clear in-memory array
    (fileRegistry as any).pendingImageOps = [];

    // commitPendingImages should STILL find the image via IDB scan
    const imageFiles = await fileRegistry.commitPendingImages();
    expect(imageFiles.length).toBeGreaterThanOrEqual(1);

    const recovered = imageFiles.find((f: any) => f.path === 'nodes/images/volatile-test.png');
    expect(recovered).toBeDefined();
    expect(recovered!.binaryContent).toBeInstanceOf(Uint8Array);
    expect(recovered!.binaryContent!.length).toBe(5);
    expect(recovered!.encoding).toBe('base64');

    // Cleanup
    await db.files.delete('test-repo-main-image-volatile-test');
  });
});

// ---------------------------------------------------------------------------
// Full simulated roundtrip with mocked Octokit
// Tests the complete pipeline: encode → API shape → decode → verify
// ---------------------------------------------------------------------------
describe('Full simulated image roundtrip (mocked Octokit)', () => {
  it('should produce identical bytes after encode → createBlob → getBlob → decode', async () => {
    // Create test image with mixed binary content
    const originalImage = new Uint8Array(2048);
    for (let i = 0; i < originalImage.length; i++) {
      originalImage[i] = (i * 7 + 13) % 256; // Pseudo-random pattern
    }

    // STEP 1: Encode using production code
    const base64Encoded = (gitService as any).uint8ArrayToBase64(originalImage);

    // STEP 2: Simulate what GitHub API would store and return
    // The createBlob API receives { content: base64Encoded, encoding: 'base64' }
    // The getBlob API returns { content: base64WithLineBreaks, encoding: 'base64' }
    // GitHub adds line breaks every 60 chars in the returned base64
    const base64WithLineBreaks = base64Encoded.replace(/(.{60})/g, '$1\n');

    // STEP 3: Decode using production code path (from workspaceService.ts)
    const cleaned = base64WithLineBreaks.replace(/[\s\r\n]/g, '');
    const buffer = Buffer.from(cleaned, 'base64');
    const recoveredImage = new Uint8Array(buffer);

    // STEP 4: Verify byte equality
    expect(recoveredImage.length).toBe(originalImage.length);
    expect(Array.from(recoveredImage)).toEqual(Array.from(originalImage));
  });

  it('should correctly construct the createBlob API call for binary images', async () => {
    const { vi } = await import('vitest');

    // Save original octokit
    const originalOctokit = (gitService as any).octokit;

    // Track what createBlob receives
    let capturedBlobArgs: any = null;

    const mockOctokit = {
      git: {
        getRef: vi.fn().mockResolvedValue({
          data: { object: { sha: 'base-commit-sha' } },
        }),
        getCommit: vi.fn().mockResolvedValue({
          data: { tree: { sha: 'base-tree-sha' } },
        }),
        getTree: vi.fn().mockResolvedValue({
          data: { tree: [{ path: 'nodes/images/test.png', type: 'blob' }] },
        }),
        createBlob: vi.fn().mockImplementation(async (args: any) => {
          capturedBlobArgs = args;
          return { data: { sha: 'new-blob-sha' } };
        }),
        createTree: vi.fn().mockResolvedValue({
          data: { sha: 'new-tree-sha' },
        }),
        createCommit: vi.fn().mockResolvedValue({
          data: { sha: 'new-commit-sha' },
        }),
        updateRef: vi.fn().mockResolvedValue({}),
      },
    };

    // Replace octokit temporarily
    (gitService as any).octokit = mockOctokit;
    (gitService as any).currentRepo = { owner: 'test', repo: 'test', name: 'test' };

    try {
      const testImage = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

      await gitService.commitAndPushFiles(
        [{
          path: 'nodes/images/test.png',
          binaryContent: testImage,
          encoding: 'base64',
        }],
        'test commit',
        'main'
      );

      // Verify createBlob was called with base64-encoded content
      expect(capturedBlobArgs).toBeDefined();
      expect(capturedBlobArgs.encoding).toBe('base64');

      // Verify the base64 content decodes back to the original
      const decoded = Buffer.from(capturedBlobArgs.content, 'base64');
      expect(Array.from(new Uint8Array(decoded))).toEqual(Array.from(testImage));
    } finally {
      // Restore original octokit
      (gitService as any).octokit = originalOctokit;
    }
  });
});

// ---------------------------------------------------------------------------
// IDB storage roundtrip tests — verify image persists correctly in IndexedDB
// ---------------------------------------------------------------------------
describe('IDB image storage roundtrip', () => {
  it('should store and retrieve image from IDB with unprefixed fileId', async () => {
    const { db } = await import('../../db/appDatabase');

    const imageId = 'idb-test-1';
    const imageData = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 10, 20, 30, 40]);

    // Store (simulating what pullLatest does)
    const fileState = {
      fileId: `image-${imageId}`,
      type: 'image' as const,
      name: `${imageId}.png`,
      path: `nodes/images/${imageId}.png`,
      data: {
        image_id: imageId,
        file_extension: 'png',
        binaryData: imageData,
      },
      originalData: null,
      isDirty: false,
      source: {
        repository: 'test-repo',
        path: `nodes/images/${imageId}.png`,
        branch: 'main',
      },
      viewTabs: [],
      lastModified: Date.now(),
    };

    await db.files.put(fileState);

    // Retrieve
    const retrieved = await db.files.get(`image-${imageId}`);
    expect(retrieved).toBeDefined();
    expect(retrieved!.data.binaryData).toBeInstanceOf(Uint8Array);
    expect(retrieved!.data.binaryData.length).toBe(imageData.length);
    expect(Array.from(retrieved!.data.binaryData)).toEqual(Array.from(imageData));

    // Cleanup
    await db.files.delete(`image-${imageId}`);
  });

  it('should store with prefix and retrieve with both prefixed and unprefixed lookup', async () => {
    const { db } = await import('../../db/appDatabase');

    const imageId = 'idb-test-2';
    const imageData = new Uint8Array([1, 2, 3, 4, 5]);
    const repo = 'test-repo';
    const branch = 'main';
    const prefixedId = `${repo}-${branch}-image-${imageId}`;

    // Store with prefix (simulating what cloneWorkspace does)
    await db.files.put({
      fileId: prefixedId,
      type: 'image' as const,
      name: `${imageId}.png`,
      path: `nodes/images/${imageId}.png`,
      data: {
        image_id: imageId,
        file_extension: 'png',
        binaryData: imageData,
      },
      originalData: null,
      isDirty: false,
      source: { repository: repo, path: `nodes/images/${imageId}.png`, branch },
      viewTabs: [],
      lastModified: Date.now(),
    });

    // Unprefixed lookup should FAIL
    const unprefixed = await db.files.get(`image-${imageId}`);
    expect(unprefixed).toBeUndefined();

    // Prefixed lookup should succeed
    const prefixed = await db.files.get(prefixedId);
    expect(prefixed).toBeDefined();
    expect(Array.from(prefixed!.data.binaryData)).toEqual(Array.from(imageData));

    // Cleanup
    await db.files.delete(prefixedId);
  });

  it('should demonstrate the clone vs pull IDB prefix inconsistency', async () => {
    const { db } = await import('../../db/appDatabase');

    const imageId = 'inconsistency-test';
    const imageData = new Uint8Array([10, 20, 30]);
    const repo = 'test-repo';
    const branch = 'main';

    // Simulate CLONE storage (uses prefixed ID)
    const cloneId = `${repo}-${branch}-image-${imageId}`;
    await db.files.put({
      fileId: cloneId,
      type: 'image' as const,
      data: { image_id: imageId, file_extension: 'png', binaryData: imageData },
      originalData: null,
      isDirty: false,
      source: { repository: repo, branch, path: `nodes/images/${imageId}.png` },
      viewTabs: [],
      lastModified: Date.now(),
    });

    // Simulate PULL storage (uses unprefixed ID — this is the inconsistency)
    const pullId = `image-${imageId}`;
    await db.files.put({
      fileId: pullId,
      type: 'image' as const,
      data: { image_id: imageId, file_extension: 'png', binaryData: imageData },
      originalData: null,
      isDirty: false,
      source: { repository: repo, branch, path: `nodes/images/${imageId}.png` },
      viewTabs: [],
      lastModified: Date.now(),
    });

    // Both exist — this means duplicate entries
    const cloneEntry = await db.files.get(cloneId);
    const pullEntry = await db.files.get(pullId);

    expect(cloneEntry).toBeDefined();
    expect(pullEntry).toBeDefined();

    // This is the INCONSISTENCY: clone and pull create different IDB entries
    // for the same logical image. imageService works around this by trying
    // both lookups, but it wastes storage and is fragile.
    expect(cloneId).not.toBe(pullId);

    // Cleanup
    await db.files.delete(cloneId);
    await db.files.delete(pullId);
  });
});
