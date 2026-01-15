/// <reference path="./node-shims.d.ts" />
import type { Page, TestInfo, ConsoleMessage, Request, Response } from '@playwright/test';
import YAML from 'yaml';

type Json = any;

function safeJsonParse(s: string | null): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export type ShareForensics = {
  recordMeta: (k: string, v: any) => void;
  recordUrl: (label: string, url: string) => void;
  recordYaml: (fileName: string, data: any) => Promise<void>;
  recordJson: (fileName: string, data: any) => Promise<void>;
  recordText: (fileName: string, text: string) => Promise<void>;
  snapshotDb: (label: string) => Promise<void>;
  flush: () => Promise<void>;
};

/**
 * Install a forensic recorder for a Playwright Page.
 *
 * Captures:
 * - console logs (all levels)
 * - page errors
 * - network requests/responses (with special handling for /api/runner/analyze request body)
 * - optional DB snapshots + YAML/JSON/text attachments
 *
 * Writes artefacts into `test-results/...` via `testInfo.outputPath(...)`.
 */
export function installShareForensics(args: {
  page: Page;
  testInfo: TestInfo;
  phase: string;
}): ShareForensics {
  const { page, testInfo, phase } = args;

  const meta: Record<string, any> = {
    phase,
    testTitle: testInfo.title,
    startAt: nowIso(),
  };

  const urls: Array<{ at: string; label: string; url: string }> = [];
  const consoleEvents: Array<{ at: string; type: string; text: string; location?: any }> = [];
  const pageErrors: Array<{ at: string; message: string; stack?: string }> = [];
  const network: Array<{
    at: string;
    kind: 'request' | 'response' | 'requestfailed';
    method?: string;
    url: string;
    status?: number;
    resourceType?: string;
    requestBodyText?: string | null;
    requestBodyJson?: any;
    responseBodyText?: string | null;
    responseBodyJson?: any;
    failureText?: string;
  }> = [];

  // Track request bodies for later pairing with response.
  const requestBodyByUrl = new Map<string, { text: string | null; json: any }>();

  const onConsole = (msg: ConsoleMessage) => {
    const location = (() => {
      try {
        return msg.location?.();
      } catch {
        return undefined;
      }
    })();
    consoleEvents.push({
      at: nowIso(),
      type: msg.type?.() || 'log',
      text: msg.text?.() || '',
      location,
    });
  };

  const onPageError = (err: any) => {
    pageErrors.push({
      at: nowIso(),
      message: String(err?.message || err),
      stack: typeof err?.stack === 'string' ? err.stack : undefined,
    });
  };

  const onRequest = (req: Request) => {
    const url = req.url();
    const bodyText = req.postData() ?? null;
    const bodyJson = safeJsonParse(bodyText);

    // Only store bodies for key endpoints to keep logs readable.
    if (url.includes('/api/runner/analyze')) {
      requestBodyByUrl.set(url, { text: bodyText, json: bodyJson });
    }

    network.push({
      at: nowIso(),
      kind: 'request',
      method: req.method(),
      url,
      resourceType: req.resourceType(),
      ...(url.includes('/api/runner/analyze')
        ? { requestBodyText: bodyText, requestBodyJson: bodyJson }
        : {}),
    });
  };

  const onRequestFailed = (req: Request) => {
    network.push({
      at: nowIso(),
      kind: 'requestfailed',
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      failureText: req.failure()?.errorText,
    });
  };

  const onResponse = async (res: Response) => {
    const url = res.url();
    const status = res.status();

    // Only buffer bodies for key endpoints to keep output bounded.
    let responseBodyText: string | null = null;
    let responseBodyJson: any = null;
    if (url.includes('/api/runner/analyze')) {
      try {
        responseBodyText = await res.text();
        responseBodyJson = safeJsonParse(responseBodyText);
      } catch {
        responseBodyText = null;
        responseBodyJson = null;
      }
    }

    const maybeReqBody = requestBodyByUrl.get(url);
    network.push({
      at: nowIso(),
      kind: 'response',
      url,
      status,
      ...(maybeReqBody ? { requestBodyText: maybeReqBody.text, requestBodyJson: maybeReqBody.json } : {}),
      ...(url.includes('/api/runner/analyze') ? { responseBodyText, responseBodyJson } : {}),
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  const writeText = async (fileName: string, text: string) => {
    // Write to the per-test output directory so each test cycle has a stable forensic bundle on disk.
    const outPath = testInfo.outputPath(`${phase}.${fileName}`);
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, text, 'utf8');

    await testInfo.attach(`${phase}:${fileName}`, { path: outPath, contentType: 'text/plain' }).catch(() => undefined);
  };

  const writeJson = async (fileName: string, data: any) => {
    await writeText(fileName, JSON.stringify(data, null, 2));
  };

  const writeYaml = async (fileName: string, data: any) => {
    const text = YAML.stringify(data ?? null);
    await writeText(fileName, text);
  };

  const snapshotDb = async (label: string) => {
    try {
      const snap = await page.evaluate(async () => {
        const db: any = (window as any).db;
        if (!db) return { ok: false, reason: 'no-db' };
        const files = await db.files.toArray();
        const tabs = await db.tabs.toArray();
        const scenarios = await db.scenarios.toArray();
        return {
          ok: true,
          dbName: db.name,
          files: files.map((f: any) => ({ fileId: f.fileId, type: f.type, title: f?.data?.title })),
          tabs: tabs.map((t: any) => ({ id: t.id, fileId: t.fileId, title: t.title, viewMode: t.viewMode })),
          scenarios: scenarios.map((s: any) => ({ id: s.id, fileId: s.fileId, name: s.name, colour: s.colour, dsl: s?.meta?.queryDSL, version: s.version })),
        };
      });
      await writeJson(`${label}.db-snapshot.json`, snap);
    } catch (e: any) {
      await writeJson(`${label}.db-snapshot.json`, { ok: false, error: String(e?.message || e) });
    }
  };

  const flush = async () => {
    meta.endAt = nowIso();
    meta.finalUrl = (() => {
      try {
        return page.url();
      } catch {
        return null;
      }
    })();
    meta.status = testInfo.status;

    await writeJson('meta.json', meta);
    await writeJson('urls.json', urls);
    await writeJson('console.json', consoleEvents);
    await writeJson('pageerrors.json', pageErrors);
    await writeJson('network.json', network);
  };

  return {
    recordMeta: (k: string, v: any) => {
      meta[k] = v;
    },
    recordUrl: (label: string, url: string) => {
      urls.push({ at: nowIso(), label, url });
    },
    recordYaml: writeYaml,
    recordJson: writeJson,
    recordText: writeText,
    snapshotDb,
    flush,
  };
}


