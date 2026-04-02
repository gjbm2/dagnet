import React from 'react';
import type { WidgetProps } from '@rjsf/utils';

/**
 * SectionHeadingWidget — renders a visual section divider with heading text.
 *
 * Use in a JSON schema as a string property with "ui:widget": "SectionHeading".
 * The heading text comes from the schema title; the optional description renders
 * below as muted helper text.
 *
 * Example schema property:
 *   "_section_bayes": { "type": "string", "title": "Bayesian Model Priors" }
 *
 * Example UI schema:
 *   "_section_bayes": { "ui:widget": "SectionHeading" }
 *
 * The property value is never stored in the data (the widget renders no input).
 */
export function SectionHeadingWidget(props: WidgetProps) {
  const { label, schema } = props;
  const title = label || schema?.title || '';
  const description = schema?.description || '';

  return (
    <div style={{
      gridColumn: '1 / -1',
      borderTop: '2px solid var(--accent-color, #1976d2)',
      marginTop: 24,
      paddingTop: 14,
      marginBottom: 8,
    }}>
      <div style={{
        fontSize: 15,
        fontWeight: 700,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.06em',
        color: 'var(--accent-color, #1976d2)',
      }}>
        {title}
      </div>
      {description && (
        <div style={{
          fontSize: 12,
          color: 'var(--text-muted, #6c757d)',
          marginTop: 4,
          lineHeight: 1.45,
        }}>
          {description}
        </div>
      )}
    </div>
  );
}
