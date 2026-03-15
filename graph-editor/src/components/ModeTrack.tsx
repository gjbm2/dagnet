import React, { useState, useCallback } from 'react';
import type { CanvasAnalysisMode } from '../types';

interface ModeTrackProps {
  mode: CanvasAnalysisMode;
  onClick: () => void;
}

/**
 * Module-level settling timestamp — survives React unmount/remount.
 *
 * CSS :hover is uncontrollable during unmount/remount cycles, so we
 * don't use it at all. Instead, hover preview is driven entirely by
 * a JS-managed class (.cfp-mode-track--previewing).
 *
 * On click: _settleUntil = now + 2s, previewing = false.
 * On mouseEnter: only enable previewing if settle window has passed.
 * On mouseLeave: clear previewing (if spurious during remount, new
 *   instance starts with previewing=false — correct behaviour).
 */
let _settleUntil = 0;

export function ModeTrack({ mode, onClick }: ModeTrackProps) {
  const [previewing, setPreviewing] = useState(false);

  const handleClick = useCallback(() => {
    _settleUntil = Date.now() + 2000;
    setPreviewing(false);
    onClick();
  }, [onClick]);

  const handleMouseEnter = useCallback(() => {
    if (Date.now() >= _settleUntil) {
      setPreviewing(true);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setPreviewing(false);
  }, []);

  const cls = `cfp-mode-track cfp-mode-track--${mode}${previewing ? ' cfp-mode-track--previewing' : ''}`;
  const nextLabel = mode === 'live' ? 'Custom' : mode === 'custom' ? 'Fixed' : 'Live';

  return (
    <button
      type="button"
      className={cls}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      title={`${mode === 'live' ? 'Live' : mode === 'custom' ? 'Custom' : 'Fixed'} — click for ${nextLabel}`}
    >
      <span className={`cfp-mode-track__stop cfp-mode-track__stop--pos-live ${mode === 'live' ? 'cfp-mode-track__stop--active' : 'cfp-mode-track__stop--inactive'}`}>
        Live
      </span>
      <span className="cfp-mode-track__line" />
      <span className={`cfp-mode-track__stop cfp-mode-track__stop--pos-custom ${mode === 'custom' ? 'cfp-mode-track__stop--active' : 'cfp-mode-track__stop--inactive'}`}>
        Custom
      </span>
      <span className="cfp-mode-track__line" />
      <span className={`cfp-mode-track__stop cfp-mode-track__stop--pos-fixed ${mode === 'fixed' ? 'cfp-mode-track__stop--active' : 'cfp-mode-track__stop--inactive'}`}>
        Fixed
      </span>
    </button>
  );
}
