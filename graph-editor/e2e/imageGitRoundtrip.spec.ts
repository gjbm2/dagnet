/**
 * E2E: Image Git Roundtrip — REAL UI, REAL git, zero mocking
 *
 * Uses a dedicated tiny test repo (gjbm2/dagnet-e2e-test).
 *
 * Flow:
 *   1. Clone test repo (real workspaceService)
 *   2. Open graph from navigator (real UI click)
 *   3. Select node (programmatic — not what we're testing)
 *   4. Upload image via PropertiesPanel "+" button → file input (real UI)
 *   5. Confirm upload in ImageUploadModal (real UI)
 *   6. Commit via Repository menu → Commit & Push (real UI)
 *   7. Close browser context
 *   8. Fresh context → clone → verify image in IDB + node reference + imageService
 *   9. Cleanup: delete test image from git
 *
 * Run:
 *   cd graph-editor
 *   DAGNET_RUN_REAL_GIT_E2E=1 CI= PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright" \
 *     npm run -s e2e -- e2e/imageGitRoundtrip.spec.ts \
 *     --workers=1 --retries=0 --reporter=line --timeout=60000 --global-timeout=90000
 */

import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ENABLED = process.env.DAGNET_RUN_REAL_GIT_E2E === '1';

interface GitEnv {
  token: string; owner: string; repo: string; branch: string; basePath: string;
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'graph-editor'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), '..');
}

function loadGitEnv(): GitEnv | null {
  const root = findRepoRoot();
  const envPath = path.join(root, '.env.git.local');
  if (!fs.existsSync(envPath)) return null;
  const raw = fs.readFileSync(envPath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  const token = vars.DAGNET_GIT_TOKEN || '';
  const owner = vars.DAGNET_GIT_OWNER || '';
  const repo = vars.DAGNET_GIT_REPO || '';
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, branch: vars.DAGNET_GIT_BRANCH || 'main', basePath: vars.DAGNET_GIT_BASE_PATH || '' };
}

function buildAppUrl(baseURL: string, env: GitEnv): string {
  const creds = JSON.stringify({
    version: '1.0.0',
    defaultGitRepo: env.repo,
    git: [{
      name: env.repo, owner: env.owner, repo: env.repo,
      token: env.token, branch: env.branch, basePath: env.basePath,
    }],
  });
  return `${baseURL}/?creds=${encodeURIComponent(creds)}`;
}

/** Clone test repo via real workspaceService (tiny repo — fast) */
async function cloneTestRepo(page: Page, env: GitEnv) {
  return page.evaluate(async (env) => {
    const { workspaceService } = await import('/src/services/workspaceService');
    const gitCreds = {
      name: env.repo, owner: env.owner, repo: env.repo,
      token: env.token, branch: env.branch, basePath: env.basePath,
    };
    await workspaceService.cloneWorkspace(env.repo, env.branch, gitCreds);
    const { db } = await import('/src/db/appDatabase');
    const files = await db.files.toArray();
    return { graphs: files.filter((f: any) => f.type === 'graph').length };
  }, env);
}

/** Select a node programmatically (not what we're testing) */
async function selectFirstNode(page: Page) {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/appDatabase');
    const files = await db.files.toArray();
    const graphFile = files.find((f: any) => f.type === 'graph' && f.data?.nodes?.length > 0);
    if (!graphFile) return { success: false, error: 'no graph' };
    const node = graphFile.data.nodes[0];
    // Dispatch the selection event that GraphCanvas uses
    window.dispatchEvent(new CustomEvent('dagnet:selectNode', {
      detail: { nodeId: node.uuid || node.id }
    }));
    return { success: true, nodeUuid: node.uuid, nodeId: node.id };
  });
}

// Create a tiny real PNG file for the upload (1x1 red pixel, valid PNG)
function createTestPngPath(): string {
  const tmpDir = path.join(findRepoRoot(), 'graph-editor', 'test-results');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, 'e2e-test-image.png');

  // Minimal valid 1x1 red PNG (68 bytes)
  const png = Buffer.from([
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A, // PNG signature
    0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52, // IHDR chunk
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,
    0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,
    0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41, // IDAT chunk
    0x54,0x08,0xD7,0x63,0xF8,0xCF,0xC0,0x00,
    0x00,0x00,0x02,0x00,0x01,0xE2,0x21,0xBC,
    0x33,0x00,0x00,0x00,0x00,0x49,0x45,0x4E, // IEND chunk
    0x44,0xAE,0x42,0x60,0x82,
  ]);
  fs.writeFileSync(filePath, png);
  return filePath;
}

// ---------------------------------------------------------------------------
test.describe.configure({ timeout: 90_000 });
const gitEnv = ENABLED ? loadGitEnv() : null;

test.describe(ENABLED && gitEnv ? 'Image Git Roundtrip (real UI)' : 'Image Git Roundtrip (SKIPPED)', () => {
  test.skip(!ENABLED || !gitEnv, 'Requires DAGNET_RUN_REAL_GIT_E2E=1 and .env.git.local');

  test('upload via UI → commit via UI → fresh clone → image intact', async ({ browser, baseURL }) => {
    const env = gitEnv!;
    const appUrl = buildAppUrl(baseURL!, env);
    const testPngPath = createTestPngPath();

    // ==== PHASE 1: Clone, open graph, upload image through UI, commit through UI ====

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(2000);

    // Clone tiny test repo
    const clone1 = await cloneTestRepo(pageA, env);
    console.log(`[E2E] Cloned (${clone1.graphs} graphs)`);
    expect(clone1.graphs).toBeGreaterThan(0);

    // Reload so the navigator picks up the cloned files
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(3000);

    // Double-click the graph in the navigator to open it (real UI)
    const graphItem = pageA.locator('text=e2e-test-graph').first();
    await graphItem.dblclick({ timeout: 5000 });
    console.log('[E2E] Double-clicked graph in navigator');
    await pageA.waitForTimeout(3000);

    // Click the node in the canvas to select it (real UI)
    // The node renders with its label text "E2E Test Node"
    const nodeLabel = pageA.locator('text=E2E Test Node').first();
    await nodeLabel.click({ timeout: 10000 }).catch(async () => {
      console.log('[E2E] Node label click failed, trying programmatic selection');
      await selectFirstNode(pageA);
      await pageA.waitForTimeout(1000);
    });
    console.log('[E2E] Node selected');

    // ---- Upload image via real UI ----
    // Click the "+" button (title="Upload new image") in PropertiesPanel
    const uploadBtn = pageA.locator('[title="Upload new image"]');
    await uploadBtn.waitFor({ timeout: 10000 });
    await uploadBtn.click();
    console.log('[E2E] Clicked upload button');

    // ImageUploadModal should appear — set the file on the file input
    const fileInput = pageA.locator('input[type="file"][accept*="image"]');
    await fileInput.waitFor({ timeout: 5000 });
    await fileInput.setInputFiles(testPngPath);
    console.log('[E2E] Set file on input');

    // Wait for preview to appear, then click "Ok" to confirm the upload
    await pageA.waitForTimeout(1000);
    const confirmBtn = pageA.locator('button:has-text("Ok")').first();
    await confirmBtn.waitFor({ timeout: 5000 });
    await confirmBtn.click();
    console.log('[E2E] Clicked Ok to confirm image upload');
    await pageA.waitForTimeout(1000);

    // Verify image appeared on the node (check IDB)
    const uploadCheck = await pageA.evaluate(async () => {
      const { db } = await import('/src/db/appDatabase');
      const files = await db.files.toArray();
      const images = files.filter((f: any) => f.type === 'image');
      const graphs = files.filter((f: any) => f.type === 'graph');
      // Find the graph's node images
      let nodeImages: any[] = [];
      for (const g of graphs) {
        for (const n of (g.data?.nodes || [])) {
          if (n.images?.length > 0) nodeImages.push(...n.images);
        }
      }
      return {
        imageFilesInIdb: images.length,
        nodeImageRefs: nodeImages.length,
        imageIds: images.map((f: any) => f.data?.image_id),
        nodeImageIds: nodeImages.map((img: any) => img.image_id),
      };
    });
    console.log('[E2E] After upload:', JSON.stringify(uploadCheck));
    expect(uploadCheck.imageFilesInIdb).toBeGreaterThan(0);
    expect(uploadCheck.nodeImageRefs).toBeGreaterThan(0);

    const imageId = uploadCheck.imageIds[0];

    // ---- Commit via real UI ----
    // Dismiss any toast notifications that might be blocking
    await pageA.evaluate(() => {
      document.querySelectorAll('[role="status"]').forEach(el => (el as HTMLElement).style.display = 'none');
    });
    await pageA.waitForTimeout(500);

    // Click Repository in the menubar
    await pageA.getByRole('menuitem', { name: 'Repository' }).click();
    await pageA.waitForTimeout(500);

    // Click "Commit Changes..." in the dropdown
    const commitMenuItem = pageA.locator('menuitem:has-text("Commit Changes"), [role="menuitem"]:has-text("Commit")').first();
    await commitMenuItem.click({ timeout: 5000 });
    console.log('[E2E] Opened commit dialog');

    // Wait for CommitModal to load committable files
    await pageA.waitForTimeout(3000);

    // Enter commit message in the textarea
    const commitMsgInput = pageA.locator('textarea[placeholder*="commit"], textarea.commit-modal-textarea').first();
    await commitMsgInput.waitFor({ timeout: 5000 });
    await commitMsgInput.fill('[e2e] image roundtrip test');
    console.log('[E2E] Entered commit message');

    // Click "Commit & Push"
    const commitBtn = pageA.locator('button:has-text("Commit & Push")');
    await commitBtn.waitFor({ timeout: 5000 });
    await commitBtn.click();
    console.log('[E2E] Clicked Commit & Push');

    // Wait for commit to complete — look for success indicator
    await pageA.locator('text=Successfully committed').waitFor({ timeout: 30000 }).catch(() => {
      console.log('[E2E] No success message seen (commit may still have succeeded)');
    });
    await pageA.waitForTimeout(2000);
    console.log('[E2E] Commit completed');

    await ctxA.close();

    // ==== PHASE 2: Fresh context → clone → verify ====

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await pageB.waitForTimeout(2000);

    const clone2 = await cloneTestRepo(pageB, env);
    console.log(`[E2E] Fresh clone (${clone2.graphs} graphs)`);

    const verify = await pageB.evaluate(async ({ imageId }) => {
      const { db } = await import('/src/db/appDatabase');
      const { imageService } = await import('/src/services/imageService');
      const files = await db.files.toArray();

      // Check image in IDB
      const imgFile = files.find((f: any) => f.type === 'image' && f.data?.image_id === imageId);
      if (!imgFile) {
        const allImgs = files.filter((f: any) => f.type === 'image').map((f: any) => f.data?.image_id);
        return { success: false, error: `Image ${imageId} not in IDB`, imagesFound: allImgs };
      }

      // Check binary data exists
      const binary = imgFile.data?.binaryData;
      if (!binary || binary.length === 0) {
        return { success: false, error: 'Image has no binary data' };
      }

      // Check imageService can serve it
      let blobUrl: string | null = null;
      const ext = imgFile.data?.file_extension || 'jpg';
      try {
        blobUrl = await imageService.getImageUrl(imageId, ext);
      } catch (e: any) {
        return { success: false, error: `imageService failed: ${e.message}` };
      }

      // Check graph node references image
      const graphs = files.filter((f: any) => f.type === 'graph');
      let nodeRef = false;
      for (const g of graphs) {
        for (const n of (g.data?.nodes || [])) {
          if (n.images?.some((img: any) => img.image_id === imageId)) { nodeRef = true; break; }
        }
        if (nodeRef) break;
      }

      return {
        success: true,
        binarySize: binary.length,
        hasBlobUrl: !!blobUrl?.startsWith('blob:'),
        nodeReferencesImage: nodeRef,
        isDirty: imgFile.isDirty,
      };
    }, { imageId });

    console.log('[E2E] Verify:', JSON.stringify(verify));
    expect(verify.success).toBe(true);
    expect((verify as any).binarySize).toBeGreaterThan(0);
    expect((verify as any).hasBlobUrl).toBe(true);
    expect((verify as any).nodeReferencesImage).toBe(true);
    expect((verify as any).isDirty).toBe(false);

    await ctxB.close();

    // ==== PHASE 3: Cleanup ====
    const ctxC = await browser.newContext();
    const pageC = await ctxC.newPage();
    await pageC.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await pageC.waitForTimeout(2000);

    await pageC.evaluate(async ({ imageId, env }) => {
      const { gitService } = await import('/src/services/gitService');
      gitService.setCredentials({
        version: '1.0.0', defaultGitRepo: env.repo,
        git: [{ name: env.repo, owner: env.owner, repo: env.repo, token: env.token, branch: env.branch, basePath: env.basePath }],
      });
      const bp = env.basePath || '';
      const imgPath = `nodes/images/${imageId}.jpg`; // compressed to jpg by ImageUploadModal
      const full = bp ? `${bp}/${imgPath}` : imgPath;
      await gitService.commitAndPushFiles([{ path: full, delete: true }], '[e2e cleanup]', env.branch);
    }, { imageId, env });

    await pageC.close();
    // Clean up temp file
    fs.unlinkSync(testPngPath);
  });
});
