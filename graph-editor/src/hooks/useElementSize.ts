import { useLayoutEffect, useRef, useState } from 'react';

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    let disposed = false;
    const update = () => {
      if (disposed) return;
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    update();

    const ro = new ResizeObserver(() => update());
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
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
      ro.disconnect();
    };
  }, []);

  return { ref, width: size.width, height: size.height };
}


