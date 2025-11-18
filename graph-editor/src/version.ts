/**
 * Application version information
 * 
 * Single source of truth: package.json
 * This file imports the version at build time via Vite's import.meta.env
 */

import packageJson from '../package.json';

/**
 * Current application version from package.json
 * Format: "0.91.0-beta" → "0.91b"
 */
export const APP_VERSION = packageJson.version;

/**
 * Short version for display (e.g., "0.91b")
 */
export const APP_VERSION_SHORT = formatVersionShort(packageJson.version);

/**
 * Format full semantic version to short display version
 * Examples:
 *   "0.91.0-beta" → "0.91b"
 *   "1.0.0" → "1.0"
 *   "2.3.5-alpha.1" → "2.3a"
 */
function formatVersionShort(version: string): string {
  // Remove leading 'v' if present
  const cleaned = version.replace(/^v/, '');
  
  // Parse semantic version
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\w+))?/);
  if (!match) return cleaned;
  
  const [, major, minor, patch, prerelease] = match;
  
  // Build short version
  let short = `${major}.${minor}`;
  
  // Add prerelease indicator (first letter)
  if (prerelease) {
    const indicator = prerelease.charAt(0).toLowerCase();
    short += indicator;
  } else if (patch !== '0') {
    // Include patch version for stable releases if non-zero
    short = `${major}.${minor}.${patch}`;
  }
  
  return short;
}

/**
 * Build timestamp (injected at build time)
 */
export const BUILD_TIMESTAMP = import.meta.env.VITE_BUILD_TIMESTAMP || new Date().toISOString();

/**
 * Git commit hash (injected at build time, if available)
 */
export const GIT_COMMIT = import.meta.env.VITE_GIT_COMMIT || 'unknown';

/**
 * Full version info for debugging
 */
export const VERSION_INFO = {
  version: APP_VERSION,
  versionShort: APP_VERSION_SHORT,
  buildTimestamp: BUILD_TIMESTAMP,
  gitCommit: GIT_COMMIT,
};

