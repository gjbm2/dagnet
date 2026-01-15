// Minimal Node module typings for Playwright E2E TypeScript.
// This repo's E2E TS config does not include @types/node by default.
// We only declare what we need for writing forensic artefacts.

declare module 'node:fs/promises' {
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare const process: any;


