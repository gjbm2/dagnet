/**
 * Mock whatwg-url to prevent webidl-conversions errors in tests
 * Uses Node.js built-in URL instead
 */

export const URL = globalThis.URL || (require('url').URL as typeof globalThis.URL);
export const URLSearchParams = globalThis.URLSearchParams || (require('url').URLSearchParams as typeof globalThis.URLSearchParams);

export default { URL, URLSearchParams };




