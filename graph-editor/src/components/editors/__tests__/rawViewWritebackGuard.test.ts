import { describe, expect, it } from 'vitest';
import { canRawViewWriteBack } from '../rawViewWritebackGuard';

describe('canRawViewWriteBack', () => {
  it('denies when readonly', () => {
    expect(canRawViewWriteBack({ readonly: true, tabId: 'tab-a', activeTabId: 'tab-a' })).toBe(false);
  });

  it('denies when no tabId', () => {
    expect(canRawViewWriteBack({ readonly: false, tabId: undefined, activeTabId: 'tab-a' })).toBe(false);
  });

  it('denies when tab not active', () => {
    expect(canRawViewWriteBack({ readonly: false, tabId: 'tab-a', activeTabId: 'tab-b' })).toBe(false);
  });

  it('allows only when tab is active', () => {
    expect(canRawViewWriteBack({ readonly: false, tabId: 'tab-a', activeTabId: 'tab-a' })).toBe(true);
  });
});


