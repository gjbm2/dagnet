import React from 'react';
import Tooltip from './Tooltip';
import { getGlossaryTerm } from '../lib/glossaryTerms';

interface GlossaryTooltipProps {
  /** Slug into the glossary registry. If not found the tooltip is suppressed and children render bare. */
  term: string;
  children: React.ReactNode;
  /** Override the registered title (rarely needed). */
  title?: string;
  /** Override or extend the registered description (rarely needed). */
  description?: string;
  delay?: number;
  position?: 'top' | 'bottom' | 'left' | 'right';
  maxWidth?: number;
  wrapper?: 'inline-block' | 'contents';
}

/**
 * Inline tooltip that renders a structured, glossary-backed explanation.
 *
 * Usage:
 *   <GlossaryTooltip term="path-t95"><label>Path t95</label></GlossaryTooltip>
 *
 * If the term is not in the registry (typo or missing seed), the component
 * logs a dev-mode warning and renders children without a tooltip — fail
 * visible in dev, silent in prod rather than crashing the UI.
 */
export default function GlossaryTooltip({
  term,
  children,
  title,
  description,
  delay,
  position = 'top',
  maxWidth = 320,
  wrapper = 'inline-block',
}: GlossaryTooltipProps) {
  const entry = getGlossaryTerm(term);

  if (!entry && !description) {
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[GlossaryTooltip] Unknown term "${term}". Add it to lib/glossaryTerms.ts.`);
    }
    return <>{children}</>;
  }

  const resolvedTitle = title ?? entry?.title ?? term;
  const resolvedDescription = description ?? entry?.description ?? '';
  const moreUrl = entry?.moreUrl;

  const content = (
    <div>
      <div className="dagnet-tooltip-title">{resolvedTitle}</div>
      <div className="dagnet-tooltip-description">{resolvedDescription}</div>
      {moreUrl && (
        <a
          className="dagnet-tooltip-more"
          href={moreUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn more →
        </a>
      )}
    </div>
  );

  return (
    <Tooltip
      content={content}
      delay={delay}
      position={position}
      maxWidth={maxWidth}
      wrapper={wrapper}
      hint
    >
      {children}
    </Tooltip>
  );
}
