import React from 'react';
import { FieldTemplateProps } from '@rjsf/utils';

/**
 * ThreeColumnFieldTemplate
 *
 * Layout:
 * - Column 1 (10%): label
 * - Column 2 (50%): field (children) + errors + help
 * - Column 3 (40%): long description / helper copy
 *
 * Uses CSS Grid via class names defined in FormEditor.css.
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
  // control layout — the three-column layout is mainly for leaf fields.
  const isContainer =
    schema.type === 'object' ||
    schema.type === 'array' ||
    (!schema.type && (schema.properties || schema.items));

  if (isContainer) {
    return (
      <div className={`${classNames} fe-container`}>
        {children}
      </div>
    );
  }

  const hasLabel = !!label;
  const hasDescriptionNode = !!description;

  return (
    <div className={`${classNames} fe-field`}>
      <div className="fe-field-grid">
        {/* Column 1: label */}
        <div className="fe-field-label">
          {hasLabel && (
            <label htmlFor={id}>
              {label}
              {required && <span className="fe-required">*</span>}
            </label>
          )}
        </div>

        {/* Column 2: field + errors + help */}
        <div className="fe-field-input">
          {children}
          {errors}
          {help}
        </div>

        {/* Column 3: long description / helper copy */}
        <div className="fe-field-description">
          {hasDescriptionNode && description}
        </div>
      </div>
    </div>
  );
}
