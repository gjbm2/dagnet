/**
 * useContextDropdown — shared hook for the context filter dropdown pattern.
 *
 * Used by WindowSelector (graph-level context) and SnapshotCalendarSection (evidence tab).
 * Manages: context section loading, dropdown open/close, outside-click dismissal,
 * apply → context DSL string, current value/key derivation.
 *
 * The caller decides what to do with `contextDSL`:
 * - WindowSelector merges it with window/cohort/asat and writes to graph store
 * - SnapshotCalendarSection composes it with the base DSL and re-fetches snapshots
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { contextRegistry } from '../services/contextRegistry';
import { parseConstraints } from '../lib/queryDSL';

export interface UseContextDropdownArgs {
  workspace?: { repository: string; branch: string };
  /** Initial context DSL (e.g. parsed from graph's currentQueryDSL). */
  initialContextDSL?: string;
  /** Pinned DSL for loading context keys (e.g. graph.dataInterestsDSL). */
  pinnedDSL?: string;
}

export function useContextDropdown({ workspace, initialContextDSL, pinnedDSL }: UseContextDropdownArgs) {
  const [contextDSL, setContextDSL] = useState(initialContextDSL || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [contextSections, setContextSections] = useState<any[]>([]);
  const [showingAll, setShowingAll] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null!);
  const dropdownRef = useRef<HTMLDivElement>(null!);

  // Derive current context values and key from the DSL
  const hasContexts = useMemo(() => {
    if (!contextDSL.trim()) return false;
    const parsed = parseConstraints(contextDSL);
    return parsed.context.length > 0 || parsed.contextAny.length > 0;
  }, [contextDSL]);

  const currentContextValues = useMemo(() => {
    if (!contextDSL.trim()) return [];
    const parsed = parseConstraints(contextDSL);
    const vals: string[] = [];
    for (const ctx of parsed.context) {
      if (ctx.value !== undefined) vals.push(ctx.value);
    }
    for (const ctxAny of parsed.contextAny) {
      for (const pair of ctxAny.pairs) {
        if (pair.value !== undefined) vals.push(pair.value);
      }
    }
    return vals;
  }, [contextDSL]);

  const currentContextKey = useMemo(() => {
    if (!contextDSL.trim()) return undefined;
    const parsed = parseConstraints(contextDSL);
    if (parsed.context.length > 0) return parsed.context[0].key;
    if (parsed.contextAny.length > 0 && parsed.contextAny[0].pairs.length > 0) {
      return parsed.contextAny[0].pairs[0].key;
    }
    return undefined;
  }, [contextDSL]);

  // Load context sections when dropdown opens
  useEffect(() => {
    if (!showDropdown || showingAll) return;
    let cancelled = false;
    void (async () => {
      try {
        // Try pinned DSL keys first, fall back to all
        let keys: { id: string }[];
        if (pinnedDSL) {
          const keySet = new Set<string>();
          for (const clause of pinnedDSL.split(';').map(c => c.trim()).filter(Boolean)) {
            const parsed = parseConstraints(clause);
            for (const ctx of parsed.context) keySet.add(ctx.key);
            for (const ctxAny of parsed.contextAny) {
              for (const pair of ctxAny.pairs) keySet.add(pair.key);
            }
          }
          keys = keySet.size > 0
            ? Array.from(keySet).map(id => ({ id }))
            : await contextRegistry.getAllContextKeys({ workspace });
        } else {
          keys = await contextRegistry.getAllContextKeys({ workspace });
        }
        const sections = await contextRegistry.getContextSections(keys, { workspace });
        if (!cancelled) setContextSections(sections);
      } catch {
        if (!cancelled) setContextSections([]);
      }
    })();
    return () => { cancelled = true; };
  }, [showDropdown, showingAll, pinnedDSL, workspace?.repository, workspace?.branch]);

  // Close on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setShowingAll(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // Apply: merge selected key+values into the existing contextDSL (compound context support).
  // Preserves context clauses for other keys; replaces/adds clauses for the applied key.
  const handleApply = useCallback((key: string, values: string[]) => {
    setShowDropdown(false);
    setShowingAll(false);

    // Parse existing context clauses, keep those for OTHER keys
    const existing = parseConstraints(contextDSL);
    const otherParts: string[] = [];
    for (const ctx of existing.context) {
      if (ctx.key !== key) otherParts.push(`context(${ctx.key}:${ctx.value})`);
    }
    for (const ctxAny of existing.contextAny) {
      const pairs = ctxAny.pairs.filter(p => p.key !== key);
      if (pairs.length === 1) otherParts.push(`context(${pairs[0].key}:${pairs[0].value})`);
      else if (pairs.length > 1) otherParts.push(`contextAny(${pairs.map(p => `${p.key}:${p.value}`).join(',')})`);
    }

    // Build clause for the applied key (empty if clearing or all-MECE)
    let newPart = '';
    if (values.length > 0) {
      const section = contextSections.find((s: any) => s.id === key);
      const allValues = section?.values || [];
      const isMECE = section?.otherPolicy !== 'undefined';
      if (!(values.length === allValues.length && isMECE)) {
        if (values.length === 1) {
          newPart = `context(${key}:${values[0]})`;
        } else {
          newPart = `contextAny(${values.map(v => `${key}:${v}`).join(',')})`;
        }
      }
    }

    const allParts = [...otherParts, newPart].filter(Boolean);
    setContextDSL(allParts.join('.'));
  }, [contextDSL, contextSections]);

  // Show all: reload ALL context keys from registry
  const handleShowAll = useCallback(async () => {
    contextRegistry.clearCache();
    const keys = await contextRegistry.getAllContextKeys({ workspace });
    const sections = await Promise.all(
      keys.map(async key => {
        const context = await contextRegistry.getContext(key.id, { workspace });
        const values = await contextRegistry.getValuesForContext(key.id);
        return {
          id: key.id,
          name: key.id.replace(/_/g, ' ').replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
          values,
          otherPolicy: context?.otherPolicy,
        };
      }),
    );
    setContextSections(sections);
    setShowingAll(true);
    return sections;
  }, [workspace?.repository, workspace?.branch]);

  const handleCancel = useCallback(() => {
    setShowDropdown(false);
    setShowingAll(false);
  }, []);

  return {
    contextDSL,
    setContextDSL,
    hasContexts,
    currentContextValues,
    currentContextKey,
    showDropdown,
    toggleDropdown: useCallback(() => setShowDropdown(v => !v), []),
    closeDropdown: useCallback(() => { setShowDropdown(false); setShowingAll(false); }, []),
    contextSections,
    showingAll,
    buttonRef,
    dropdownRef,
    handleApply,
    handleShowAll,
    handleCancel,
  };
}
