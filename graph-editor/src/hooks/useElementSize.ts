import { useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_DEBOUNCE_MS = 300;

export function useElementSize<T extends HTMLElement>(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const update = () => {
      if (disposed) return;
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    // Debounced version for continuous resize (drag-resize of analysis nodes).
    // Avoids rebuilding expensive chart options on every frame.
    const debouncedUpdate = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => update(), debounceMs);
    };

    // Immediate first measurement
    update();

    const ro = new ResizeObserver(() => debouncedUpdate());
    ro.observe(el);

    // rc-dock / dashboard layouts can "settle" dimensions after first paint.
    // These extra re-measures avoid initial short charts until some unrelated re-render happens.
    const raf1 = requestAnimationFrame(() => update());
    const raf2 = requestAnimationFrame(() => requestAnimationFrame(() => update()));
    const t1 = window.setTimeout(() => update(), 50);
    const t2 = window.setTimeout(() => update(), 250);
    const t3 = window.setTimeout(() => update(), 1000);
    const t4 = window.setTimeout(() => update(), 2000);

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
      ro.disconnect();
    };
  }, [debounceMs]);

  return { ref, width: size.width, height: size.height };
}


