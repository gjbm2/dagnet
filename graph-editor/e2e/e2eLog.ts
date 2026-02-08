export function isE2eVerbose(): boolean {
  // Default: quiet (release.sh / CI friendly).
  // Enable with: E2E_VERBOSE=1
  return String(process.env.E2E_VERBOSE || '').trim() === '1';
}

export function e2eLog(...args: any[]): void {
  if (!isE2eVerbose()) return;
  // eslint-disable-next-line no-console
  console.log(...args);
}

