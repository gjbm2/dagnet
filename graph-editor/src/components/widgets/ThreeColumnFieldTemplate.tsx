import React from 'react';
import { FieldTemplateProps } from '@rjsf/utils';

/**
 * ThreeColumnFieldTemplate
 *
 * Layout goals:
 * - Column 1 (10%): label
 * - Column 2 (60%): field (children) + errors + help
 * - Column 3 (30%): long description / helper copy
 *
 * This uses CSS Grid on a per-field basis instead of trying to
 * re-style the entire RJSF / MUI DOM with global CSS selectors.
 * That makes it much more resilient to DOM structure changes.
 * 
 * Material UI labels are hidden since we render our own in column 1.
 */
export function ThreeColumnFieldTemplate(props: FieldTemplateProps) {
  const {
    id,
    classNames,
    label,
    required,
    description,
    errors,
    help,
    children,
    hidden,
    schema,
  } = props;

  if (hidden) {
    return <>{children}</>;
  }

  // For object & array containers, let the existing templates (accordion / tabbed)
  // control layout – the three-column layout is mainly for leaf fields.
  const isContainer =
    schema.type === 'object' ||
    schema.type === 'array' ||
    // some schemas omit type on container nodes; use heuristic
    (!schema.type && (schema.properties || schema.items));

  if (isContainer) {
    return (
      <div className={classNames} style={{ marginBottom: 16 }}>
        {children}
      </div>
    );
  }

  const hasLabel = !!label;
  const hasDescriptionNode = !!description;

  // Sanitize ID for use in CSS class (remove special characters)
  const safeId = String(id || '').replace(/[^a-zA-Z0-9-_]/g, '-');

  return (
    <div
      className={`${classNames} three-column-field-wrapper-${safeId}`}
      style={{ marginBottom: 12 }}
    >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '10% 50% 40%',
            columnGap: 16,
            alignItems: 'flex-start',
          }}
        >
          {/* Column 1: label */}
          <div
            style={{
              textAlign: 'right',
              paddingTop: 8,
              paddingRight: 8,
              fontWeight: 500,
              whiteSpace: 'normal',
              wordBreak: 'break-word',
            }}
          >
            {hasLabel && (
              <label
                htmlFor={id}
                style={{
                  margin: 0,
                  fontSize: 13,
                }}
              >
                {label}
                {required && (
                  <span style={{ color: '#d32f2f', marginLeft: 2 }}>*</span>
                )}
              </label>
            )}
          </div>

          {/* Column 2: field + errors + help */}
          <div className="field-column" style={{ width: '100%', minWidth: 0 }}>
            {children}
            {/* errors & help are already wrapped in MUI typography by @rjsf/mui */}
            {errors}
            {help}
          </div>

          {/* Column 3: long description / helper copy */}
          <div
            className="field-description-column"
            style={{
              fontSize: 11,
              color: '#6c757d',
              paddingTop: 8,
              paddingRight: 8,
              paddingLeft: 0,
              lineHeight: 1.4,
              wordBreak: 'break-word',
            }}
          >
            {hasDescriptionNode && description}
          </div>
        </div>
      </div>
  );
}


