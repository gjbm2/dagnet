import React, { useState } from 'react';
import { ArrayFieldTemplateProps } from '@rjsf/utils';
import { Box, Tabs, Tab, IconButton, Tooltip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';

/**
 * TabbedArrayWidget for React JSON Schema Form
 * 
 * Renders array items as tabs instead of a vertical list.
 * Each item gets its own tab, making large arrays (like connections) manageable.
 * 
 * Can be used as global ArrayFieldTemplate - only renders as tabs if ui:options.tabField is present.
 * Otherwise, renders with default RJSF array template.
 * 
 * Usage in UI schema:
 * {
 *   "connections": {
 *     "ui:options": {
 *       "tabField": "name"  // Field to use as tab label - presence enables tabbed view
 *     }
 *   }
 * }
 */
export function TabbedArrayWidget(props: ArrayFieldTemplateProps) {
  const { items, onAddClick, canAdd, title, schema, uiSchema, disabled, readonly } = props;
  
  // Get tab label field from ui:options (defaults to 'name')
  const tabField = (uiSchema?.['ui:options'] as any)?.tabField;
  
  // If no tabField specified, render with default RJSF array template
  if (!tabField) {
    return (
      <Box sx={{ width: '100%', mb: 2 }}>
        {title && (
          <div 
            className="array-field-title"
            style={{ 
              marginBottom: '8px', 
              fontWeight: 500,
              marginLeft: 'calc(10% + 16px)',
              width: '50%',
              maxWidth: '50%',
              textTransform: 'capitalize'
            }}
          >
            {title}
          </div>
        )}
        {items.map(item => (
          <Box 
            key={item.key} 
            sx={{ 
              mb: 2, 
              p: 2, 
              border: '1px solid #e0e0e0', 
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 2
            }}
          >
            <Box sx={{ flex: 1 }}>
              {item.children}
            </Box>
            {item.hasRemove && !disabled && !readonly && (
              <Box sx={{ flexShrink: 0 }}>
                <Tooltip title="Delete this item">
                  <IconButton onClick={item.onDropIndexClick(item.index)} size="small" color="error">
                    <DeleteIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            )}
          </Box>
        ))}
        {canAdd && !disabled && !readonly && (
          <Box sx={{ 
            display: 'grid',
            gridTemplateColumns: '10% 50% 40%',
            columnGap: '16px',
            marginTop: '8px'
          }}>
            <Box sx={{ gridColumn: 2 }}>
              <Tooltip title="Add new item">
                <IconButton onClick={onAddClick as any} size="small" color="primary">
                  <AddIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        )}
      </Box>
    );
  }
  
  // Track active tab
  const [activeTab, setActiveTab] = useState(0);
  
  // Ensure activeTab is valid
  const safeActiveTab = Math.min(activeTab, items.length - 1);
  
  // Handle tab change
  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };
  
  // Handle add new item
  const handleAddClick = (event: React.MouseEvent) => {
    if (onAddClick) {
      onAddClick(event as any);
      // Switch to the new tab after adding
      setActiveTab(items.length);
    }
  };
  
  // Get label for a tab
  const getTabLabel = (item: any, index: number): string => {
    const formData = item.children.props.formData;
    
    if (formData && typeof formData === 'object' && tabField in formData) {
      const value = formData[tabField];
      return value || `Item ${index + 1}`;
    }
    
    return `Item ${index + 1}`;
  };
  
  return (
    <Box sx={{ width: '100%', mb: 3 }}>
      {/* Title */}
      {title && (
        <Box sx={{ mb: 1, mt: 5, marginLeft: 'calc(10% + 16px)', width: '50%', maxWidth: '50%' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 500, textTransform: 'capitalize' }}>
            {title}
          </h3>
        </Box>
      )}
      
      {/* Tab Bar */}
      <Box sx={{ 
        borderBottom: 1, 
        borderColor: 'divider', 
        display: 'flex', 
        alignItems: 'center',
        marginLeft: 'calc(10% + 16px)',
        width: '50%',
        maxWidth: '50%'
      }}>
        <Tabs 
          value={items.length > 0 ? safeActiveTab : false}
          onChange={handleTabChange}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ flexGrow: 1 }}
        >
          {items.map((item, index) => (
            <Tab 
              key={item.key}
              label={getTabLabel(item, index)}
              disabled={disabled}
              sx={{
                minWidth: 120,
                textTransform: 'none',
                fontSize: '0.875rem'
              }}
            />
          ))}
        </Tabs>
        
        {/* Add Button */}
        {canAdd && !disabled && !readonly && (
          <Tooltip title="Add new item">
            <IconButton 
              onClick={handleAddClick}
              size="small"
              sx={{ ml: 1, mr: 1 }}
              color="primary"
            >
              <AddIcon />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      
      {/* Tab Panels */}
      <Box 
        className="tabbed-array-panel"
        sx={{ 
          mt: 2, 
          p: 3, 
          border: '1px solid #e0e0e0', 
          borderRadius: '4px',
          backgroundColor: '#fafafa'
        }}
      >
        {items.length === 0 ? (
          <Box sx={{ 
            textAlign: 'center', 
            py: 4, 
            color: 'text.secondary',
            fontStyle: 'italic'
          }}>
            No items yet. Click the + button to add one.
          </Box>
        ) : (
          items.map((item, index) => (
            <Box 
              key={item.key}
              sx={{ 
                display: index === safeActiveTab ? 'block' : 'none'
              }}
            >
              {/* Item Content */}
              <Box sx={{ mb: 2 }}>
                {item.children}
              </Box>
              
              {/* Delete Button */}
              {item.hasRemove && !disabled && !readonly && (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                  <Tooltip title="Delete this item">
                    <IconButton
                      onClick={item.onDropIndexClick(item.index)}
                      color="error"
                      size="small"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
            </Box>
          ))
        )}
      </Box>
      
      {/* Description */}
      {schema.description && (
        <Box sx={{ mt: 1, fontSize: '0.875rem', color: 'text.secondary', fontStyle: 'italic' }}>
          {schema.description}
        </Box>
      )}
    </Box>
  );
}

