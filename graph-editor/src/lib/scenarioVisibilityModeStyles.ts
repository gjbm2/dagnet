import type { CSSProperties } from 'react';
import type { ScenarioVisibilityMode } from '../types';

export function getScenarioVisibilityOverlayStyle(
  mode: ScenarioVisibilityMode | undefined,
): CSSProperties | null {
  switch (mode) {
    case 'f+e':
      return {
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        background: 'repeating-linear-gradient(45deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)',
        maskImage: 'linear-gradient(90deg, transparent 0%, transparent 20%, black 80%, black 100%)',
        WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, transparent 20%, black 80%, black 100%)',
        pointerEvents: 'none',
      };
    case 'f':
      return {
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        background: 'repeating-linear-gradient(45deg, transparent 0px, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px)',
        pointerEvents: 'none',
      };
    case 'e':
    default:
      return null;
  }
}
