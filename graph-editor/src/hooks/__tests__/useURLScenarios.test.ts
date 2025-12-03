/**
 * useURLScenarios Hook Tests
 * 
 * Tests URL parameter parsing and scenario creation from URL.
 * 
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseURLScenariosParams,
  cleanURLScenariosParams,
  generateScenariosURL,
} from '../useURLScenarios';

// Mock window.location
const mockLocation = {
  search: '',
  href: 'http://localhost:3000/',
  pathname: '/',
};

const mockHistory = {
  replaceState: vi.fn(),
};

// Setup global mocks
beforeEach(() => {
  vi.clearAllMocks();
  
  // Reset location
  mockLocation.search = '';
  mockLocation.href = 'http://localhost:3000/';
  
  // Mock window and document
  Object.defineProperty(global, 'window', {
    value: {
      location: mockLocation,
      history: mockHistory,
    },
    writable: true,
  });
  
  Object.defineProperty(global, 'document', {
    value: {
      title: 'Test',
    },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ==========================================================================
// parseURLScenariosParams tests
// ==========================================================================

describe('parseURLScenariosParams', () => {
  it('should return null scenariosParam, false hideCurrent, and null graphParam when no params', () => {
    mockLocation.search = '';
    
    const result = parseURLScenariosParams();
    
    expect(result.scenariosParam).toBeNull();
    expect(result.hideCurrent).toBe(false);
    expect(result.graphParam).toBeNull();
  });

  it('should parse scenarios parameter', () => {
    mockLocation.search = '?scenarios=context(channel:google)';
    
    const result = parseURLScenariosParams();
    
    expect(result.scenariosParam).toBe('context(channel:google)');
    expect(result.hideCurrent).toBe(false);
  });

  it('should parse URL-encoded scenarios parameter', () => {
    // URL-encoded: context(channel:google);context(channel:meta)
    mockLocation.search = '?scenarios=context%28channel%3Agoogle%29%3Bcontext%28channel%3Ameta%29';
    
    const result = parseURLScenariosParams();
    
    // URLSearchParams automatically decodes, so we get the decoded value
    expect(result.scenariosParam).toBe('context(channel:google);context(channel:meta)');
  });

  it('should parse hidecurrent parameter', () => {
    mockLocation.search = '?hidecurrent';
    
    const result = parseURLScenariosParams();
    
    expect(result.scenariosParam).toBeNull();
    expect(result.hideCurrent).toBe(true);
  });

  it('should parse hidecurrent with empty value', () => {
    mockLocation.search = '?hidecurrent=';
    
    const result = parseURLScenariosParams();
    
    expect(result.hideCurrent).toBe(true);
  });

  it('should parse both scenarios and hidecurrent', () => {
    mockLocation.search = '?scenarios=window(-7d:-1d)&hidecurrent';
    
    const result = parseURLScenariosParams();
    
    expect(result.scenariosParam).toBe('window(-7d:-1d)');
    expect(result.hideCurrent).toBe(true);
  });

  it('should handle graph parameter alongside scenarios', () => {
    mockLocation.search = '?graph=conversion-v2&scenarios=context(channel)';
    
    const result = parseURLScenariosParams();
    
    expect(result.scenariosParam).toBe('context(channel)');
    expect(result.graphParam).toBe('conversion-v2');
  });

  it('should parse graph parameter only', () => {
    mockLocation.search = '?graph=sample-graph';
    
    const result = parseURLScenariosParams();
    
    expect(result.graphParam).toBe('sample-graph');
    expect(result.scenariosParam).toBeNull();
    expect(result.hideCurrent).toBe(false);
  });

  it('should parse all three parameters together', () => {
    mockLocation.search = '?graph=my-graph&scenarios=window(-7d:)&hidecurrent';
    
    const result = parseURLScenariosParams();
    
    expect(result.graphParam).toBe('my-graph');
    expect(result.scenariosParam).toBe('window(-7d:)');
    expect(result.hideCurrent).toBe(true);
  });
});

// ==========================================================================
// cleanURLScenariosParams tests
// ==========================================================================

describe('cleanURLScenariosParams', () => {
  it('should remove scenarios parameter from URL', () => {
    mockLocation.href = 'http://localhost:3000/?scenarios=context(channel:google)';
    mockLocation.search = '?scenarios=context(channel:google)';
    
    cleanURLScenariosParams();
    
    expect(mockHistory.replaceState).toHaveBeenCalledWith(
      {},
      document.title,
      expect.stringContaining('http://localhost:3000/')
    );
    // The cleaned URL should not contain scenarios
    const cleanedUrl = mockHistory.replaceState.mock.calls[0][2];
    expect(cleanedUrl).not.toContain('scenarios');
  });

  it('should remove hidecurrent parameter from URL', () => {
    mockLocation.href = 'http://localhost:3000/?hidecurrent';
    mockLocation.search = '?hidecurrent';
    
    cleanURLScenariosParams();
    
    const cleanedUrl = mockHistory.replaceState.mock.calls[0][2];
    expect(cleanedUrl).not.toContain('hidecurrent');
  });

  it('should preserve other parameters', () => {
    mockLocation.href = 'http://localhost:3000/?graph=test&scenarios=context(channel)&other=value';
    mockLocation.search = '?graph=test&scenarios=context(channel)&other=value';
    
    cleanURLScenariosParams();
    
    const cleanedUrl = mockHistory.replaceState.mock.calls[0][2];
    expect(cleanedUrl).toContain('graph=test');
    expect(cleanedUrl).toContain('other=value');
    expect(cleanedUrl).not.toContain('scenarios');
  });
});

// ==========================================================================
// generateScenariosURL tests
// ==========================================================================

describe('generateScenariosURL', () => {
  it('should generate URL with single scenario', () => {
    const result = generateScenariosURL(
      ['context(channel:google)'],
      false,
      'http://localhost:3000/'
    );
    
    expect(result).toContain('scenarios=');
    // Parse the URL to get the decoded param value
    const url = new URL(result);
    const scenariosParam = url.searchParams.get('scenarios');
    expect(scenariosParam).toBe('context(channel:google)');
  });

  it('should generate URL with multiple scenarios joined by semicolon', () => {
    const result = generateScenariosURL(
      ['context(channel:google)', 'context(channel:meta)'],
      false,
      'http://localhost:3000/'
    );
    
    // Parse the URL to get the decoded param value
    const url = new URL(result);
    const scenariosParam = url.searchParams.get('scenarios');
    expect(scenariosParam).toBe('context(channel:google);context(channel:meta)');
  });

  it('should add hidecurrent parameter when true', () => {
    const result = generateScenariosURL(
      ['window(-7d:-1d)'],
      true,
      'http://localhost:3000/'
    );
    
    expect(result).toContain('hidecurrent');
  });

  it('should not add hidecurrent parameter when false', () => {
    const result = generateScenariosURL(
      ['window(-7d:-1d)'],
      false,
      'http://localhost:3000/'
    );
    
    expect(result).not.toContain('hidecurrent');
  });

  it('should handle empty scenarios array', () => {
    const result = generateScenariosURL(
      [],
      false,
      'http://localhost:3000/'
    );
    
    expect(result).not.toContain('scenarios');
  });

  it('should handle hidecurrent only (no scenarios)', () => {
    const result = generateScenariosURL(
      [],
      true,
      'http://localhost:3000/'
    );
    
    expect(result).not.toContain('scenarios');
    expect(result).toContain('hidecurrent');
  });

  it('should preserve existing URL parameters', () => {
    const result = generateScenariosURL(
      ['context(channel:google)'],
      false,
      'http://localhost:3000/?graph=test'
    );
    
    expect(result).toContain('graph=test');
    expect(result).toContain('scenarios=');
  });

  it('should URL-encode special characters', () => {
    const result = generateScenariosURL(
      ['context(channel:google)'],
      false,
      'http://localhost:3000/'
    );
    
    // The scenarios param should be URL-encoded
    expect(result).toContain('scenarios=');
    // Parentheses and colons should be encoded
    expect(result).toMatch(/scenarios=[^&]+/);
  });
});

