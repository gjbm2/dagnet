/**
 * HelperLinesRenderer — Canvas2D overlay for snap-to-guide lines.
 *
 * Adapted from the xyflow Pro helper-lines example (perpetual licence).
 * Draws full-viewport lines: solid for edge snaps, dashed for centre snaps.
 *
 * Uses an imperative draw model (not React state) to avoid re-rendering
 * the parent component tree during drag. The hook calls `draw()` / `clear()`
 * on the ref directly.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useStore, ReactFlowState } from 'reactflow';
import type { HelperLine } from '../services/snapService';

const storeSelector = (state: ReactFlowState) => ({
  width: state.width,
  height: state.height,
  transform: state.transform,
});

export interface HelperLinesHandle {
  draw(horizontal?: HelperLine, vertical?: HelperLine): void;
  clear(): void;
}

const DEFAULT_COLOUR = 'rgba(0, 65, 208, 0.5)';

const HelperLinesRenderer = forwardRef<HelperLinesHandle, {}>((_, ref) => {
  const storeState = useStore(storeSelector);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Keep a mutable ref to the latest store state so draw() always uses current values
  const storeRef = useRef(storeState);
  storeRef.current = storeState;

  useImperativeHandle(ref, () => ({
    draw(horizontal?: HelperLine, vertical?: HelperLine) {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx || !canvas) return;

      const { width, height, transform } = storeRef.current;
      const dpi = window.devicePixelRatio;
      canvas.width = width * dpi;
      canvas.height = height * dpi;

      ctx.scale(dpi, dpi);
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 0.75;

      if (vertical) {
        ctx.beginPath();
        ctx.setLineDash(vertical.anchorName === 'centreX' ? [5, 5] : []);
        ctx.strokeStyle = vertical.color || DEFAULT_COLOUR;
        const x = vertical.position * transform[2] + transform[0];
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      if (horizontal) {
        ctx.beginPath();
        ctx.setLineDash(horizontal.anchorName === 'centreY' ? [5, 5] : []);
        ctx.strokeStyle = horizontal.color || DEFAULT_COLOUR;
        const y = horizontal.position * transform[2] + transform[1];
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    },

    clear() {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx || !canvas) return;
      const { width, height } = storeRef.current;
      const dpi = window.devicePixelRatio;
      canvas.width = width * dpi;
      canvas.height = height * dpi;
      ctx.clearRect(0, 0, width * dpi, height * dpi);
    },
  }), []);

  return (
    <canvas
      ref={canvasRef}
      data-testid="helper-lines-canvas"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 10,
      }}
    />
  );
});

HelperLinesRenderer.displayName = 'HelperLinesRenderer';

export default HelperLinesRenderer;
