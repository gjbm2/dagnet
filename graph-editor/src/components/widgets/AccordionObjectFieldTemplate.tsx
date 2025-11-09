import React, { useState } from 'react';
import { ObjectFieldTemplateProps } from '@rjsf/utils';
import { Accordion, AccordionSummary, AccordionDetails, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

/**
 * AccordionObjectFieldTemplate - Renders nested objects as collapsible accordions
 * 
 * Usage in UI schema:
 * {
 *   "adapter": {
 *     "ui:ObjectFieldTemplate": "accordion"
 *   }
 * }
 */
export function AccordionObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { title, description, properties, required, uiSchema } = props;
  
  // Only use accordion if explicitly enabled via ui:options.accordion = true
  const shouldUseAccordion = uiSchema?.['ui:options']?.accordion === true;
  
  // If not an accordion, render default (plain fields)
  if (!shouldUseAccordion) {
    return (
      <div style={{ marginBottom: '16px' }}>
        {title && <Typography variant="h6" style={{ marginBottom: '8px', fontSize: '1rem', fontWeight: 500 }}>{title}</Typography>}
        {description && <Typography variant="body2" color="textSecondary" style={{ marginBottom: '16px' }}>{description}</Typography>}
        <div>
          {properties.map((prop) => prop.content)}
        </div>
      </div>
    );
  }
  
  const [expanded, setExpanded] = useState(false);
  
  return (
    <Accordion 
      expanded={expanded}
      onChange={() => setExpanded(!expanded)}
      sx={{ mb: 2 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography>
          {title || 'Details'}
          {required && required.length > 0 && (
            <span style={{ color: 'red', marginLeft: '4px' }}>*</span>
          )}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        {description && (
          <Typography variant="body2" color="textSecondary" style={{ marginBottom: '16px' }}>
            {description}
          </Typography>
        )}
        <div>
          {properties.map((prop) => (
            <div key={prop.name} style={{ marginBottom: '16px' }}>
              {prop.content}
            </div>
          ))}
        </div>
      </AccordionDetails>
    </Accordion>
  );
}

