import { useLayoutEffect, useRef, useState } from 'react';

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
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

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ro.disconnect();
    };
  }, []);

  return { ref, width: size.width, height: size.height };
}


