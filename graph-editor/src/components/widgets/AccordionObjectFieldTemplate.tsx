import React, { useState } from 'react';
import { ObjectFieldTemplateProps } from '@rjsf/utils';
import { Accordion, AccordionSummary, AccordionDetails, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

/**
 * Group definition for ui:options.groups — partitions flat properties
 * into collapsible accordion sections without changing the data model.
 *
 * Usage in UI schema:
 * ```json
 * "forecasting": {
 *   "ui:options": {
 *     "groups": [
 *       { "title": "Baseline & Blending", "fields": ["RECENCY_HALF_LIFE_DAYS", ...] },
 *       { "title": "Bayesian Priors",     "fields": ["BAYES_LOG_KAPPA_MU", ...] }
 *     ]
 *   }
 * }
 * ```
 */
interface FieldGroup {
  title: string;
  description?: string;
  fields: string[];
  defaultExpanded?: boolean;
}

/**
 * AccordionObjectFieldTemplate
 *
 * Three modes (checked in order):
 *
 * 1. **Grouped accordion** — `ui:options.groups` is an array of FieldGroup.
 *    Flat properties are partitioned into collapsible sections.  Data model
 *    is untouched — this is purely a presentation-layer grouping.
 *
 * 2. **Single accordion** — `ui:options.accordion = true`.
 *    The entire object is wrapped in one collapsible section (existing behaviour).
 *
 * 3. **Plain** — default.  Title + description + flat list of fields.
 *
 * All layout classes are defined in FormEditor.css (prefixed `fe-`).
 */
export function AccordionObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { title, description, properties, uiSchema, schema } = props;

  // ── Mode 1: Grouped accordion ──
  const groups = uiSchema?.['ui:options']?.groups as FieldGroup[] | undefined;
  if (Array.isArray(groups) && groups.length > 0) {
    return (
      <GroupedAccordion
        title={title}
        description={description}
        properties={properties}
        groups={groups}
        schema={schema}
      />
    );
  }

  // ── Mode 2: Single accordion ──
  const shouldUseAccordion = uiSchema?.['ui:options']?.accordion === true;

  // ── Mode 3: Plain ──
  const isRootObject = !title || (schema && title === schema.title);

  if (!shouldUseAccordion) {
    return (
      <div className="fe-object-header">
        {title && (
          <Typography
            variant="h6"
            className={`fe-object-title ${isRootObject ? 'fe-object-title--root' : ''}`}
          >
            {title}
          </Typography>
        )}
        {description && (
          <Typography
            variant="body2"
            color="textSecondary"
            className={`fe-object-description ${isRootObject ? 'fe-object-description--root' : ''}`}
          >
            {description}
          </Typography>
        )}
        <div>
          {properties.map((prop) => prop.content)}
        </div>
      </div>
    );
  }

  // Single accordion (existing behaviour)
  return <SingleAccordion {...props} />;
}

// ── Single accordion (extracted for hook compliance) ──────────────────────

function SingleAccordion(props: ObjectFieldTemplateProps) {
  const { title, description, properties, required } = props;
  const [expanded, setExpanded] = useState(false);

  return (
    <Accordion
      expanded={expanded}
      onChange={() => setExpanded(!expanded)}
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ mb: 2 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography>
          {title || 'Details'}
          {Array.isArray(required) && required.length > 0 && (
            <span className="fe-accordion-required">*</span>
          )}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        {description && (
          <Typography variant="body2" color="textSecondary" className="fe-accordion-description">
            {description}
          </Typography>
        )}
        <div>
          {properties.map((prop) => (
            <div key={prop.name} className="fe-accordion-field">
              {prop.content}
            </div>
          ))}
        </div>
      </AccordionDetails>
    </Accordion>
  );
}

// ── Grouped accordion ────────────────────────────────────────────────────

function GroupedAccordion({
  title,
  description,
  properties,
  groups,
  schema,
}: {
  title?: string;
  description?: string;
  properties: ObjectFieldTemplateProps['properties'];
  groups: FieldGroup[];
  schema: ObjectFieldTemplateProps['schema'];
}) {
  const isRootObject = !title || (schema && title === schema.title);

  // Build a lookup: field name → rendered content
  const propMap = new Map<string, React.ReactNode>();
  for (const prop of properties) {
    propMap.set(prop.name, prop.content);
  }

  // Collect field names claimed by groups so we can render unclaimed fields
  const claimed = new Set(groups.flatMap(g => g.fields));
  const unclaimed = properties.filter(p => !claimed.has(p.name));

  // Track which accordions are expanded — allow multiple
  const [expandedSet, setExpandedSet] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    groups.forEach((g, i) => { if (g.defaultExpanded) initial.add(i); });
    if (initial.size === 0 && groups.length > 0) initial.add(0);
    return initial;
  });

  const toggle = (idx: number) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  return (
    <div className="fe-object-header">
      {title && (
        <Typography
          variant="h6"
          className={`fe-object-title ${isRootObject ? 'fe-object-title--root' : ''}`}
        >
          {title}
        </Typography>
      )}
      {description && (
        <Typography
          variant="body2"
          color="textSecondary"
          className={`fe-object-description ${isRootObject ? 'fe-object-description--root' : ''}`}
        >
          {description}
        </Typography>
      )}

      {groups.map((group, idx) => {
        const groupFields = group.fields
          .map(name => propMap.get(name))
          .filter(Boolean);

        if (groupFields.length === 0) return null;

        return (
          <Accordion
            key={idx}
            expanded={expandedSet.has(idx)}
            onChange={() => toggle(idx)}
            slotProps={{ transition: { unmountOnExit: true } }}
            sx={{ mb: 1 }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography sx={{ fontWeight: 600 }}>
                {group.title}
              </Typography>
            </AccordionSummary>
            <AccordionDetails>
              {group.description && (
                <Typography variant="body2" color="textSecondary" className="fe-group-description">
                  {group.description}
                </Typography>
              )}
              <div>
                {groupFields.map((content, i) => (
                  <div key={i} className="fe-group-field">
                    {content}
                  </div>
                ))}
              </div>
            </AccordionDetails>
          </Accordion>
        );
      })}

      {unclaimed.length > 0 && (
        <div className="fe-group-unclaimed">
          {unclaimed.map(prop => prop.content)}
        </div>
      )}
    </div>
  );
}
