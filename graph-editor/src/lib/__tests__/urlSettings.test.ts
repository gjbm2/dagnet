/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { getURLBooleanParam } from '../urlSettings';

describe('getURLBooleanParam', () => {
  it('returns false when absent', () => {
    const p = new URLSearchParams('');
    expect(getURLBooleanParam(p, 'flag')).toBe(false);
  });

  it('treats present-without-value as true', () => {
    const p = new URLSearchParams('flag');
    expect(getURLBooleanParam(p, 'flag')).toBe(true);
  });

  it('accepts common truthy values', () => {
    expect(getURLBooleanParam(new URLSearchParams('flag=1'), 'flag')).toBe(true);
    expect(getURLBooleanParam(new URLSearchParams('flag=true'), 'flag')).toBe(true);
    expect(getURLBooleanParam(new URLSearchParams('flag=TRUE'), 'flag')).toBe(true);
    expect(getURLBooleanParam(new URLSearchParams('flag=yes'), 'flag')).toBe(true);
    expect(getURLBooleanParam(new URLSearchParams('flag=on'), 'flag')).toBe(true);
    expect(getURLBooleanParam(new URLSearchParams('flag='), 'flag')).toBe(true);
  });

  it('accepts common falsy values', () => {
    expect(getURLBooleanParam(new URLSearchParams('flag=0'), 'flag')).toBe(false);
    expect(getURLBooleanParam(new URLSearchParams('flag=false'), 'flag')).toBe(false);
    expect(getURLBooleanParam(new URLSearchParams('flag=FALSE'), 'flag')).toBe(false);
    expect(getURLBooleanParam(new URLSearchParams('flag=no'), 'flag')).toBe(false);
    expect(getURLBooleanParam(new URLSearchParams('flag=off'), 'flag')).toBe(false);
  });

  it('treats unrecognised values as true when present', () => {
    const p = new URLSearchParams('flag=maybe');
    expect(getURLBooleanParam(p, 'flag')).toBe(true);
  });
});

