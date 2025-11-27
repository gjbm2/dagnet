/**
 * Mock webidl-conversions to prevent errors in tests
 * This is a dependency of whatwg-url that has compatibility issues with Node.js
 */

// Return a minimal mock that satisfies what whatwg-url needs
export default {};

// Export common functions that might be used
export function any(v: any) { return v; }
export function boolean(v: any) { return Boolean(v); }
export function DOMString(v: any) { return String(v); }
export function USVString(v: any) { return String(v); }
export function ByteString(v: any) { return String(v); }
export function object(v: any) { return v; }
export function ArrayBuffer(v: any) { return v; }

