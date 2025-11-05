/**
 * Object Type Theme Configuration
 * 
 * Centralized color palette and icon mappings for consistent visual language
 * across Navigator, tabs, EnhancedSelector, and Properties panel.
 * 
 * Based on GRAPH_EDITOR_SIDEBAR_REDESIGN.md Section 9.1
 */

import { LucideIcon } from 'lucide-react';
import { 
  FileJson,      // Graph
  Box,           // Node
  Layers,        // Case
  FileText,      // Context
  Sliders,       // Parameter
  Calendar,      // Event
  ArrowRight,    // Edge
  Settings,      // Settings & Special
  Key,           // Credentials
  Info,          // About
  FileType       // Markdown
} from 'lucide-react';

export type ObjectType = 'graph' | 'node' | 'case' | 'context' | 'parameter' | 'event' | 'edge' | 'special' | 'credentials' | 'settings' | 'about' | 'markdown';

export interface ObjectTypeTheme {
  /** Light pastel background color */
  lightColor: string;
  /** Accent color for borders, icons */
  accentColor: string;
  /** Icon component */
  icon: LucideIcon;
  /** Display name */
  label: string;
  /** Emoji fallback (for contexts where icons aren't suitable) */
  emoji: string;
}

export const objectTypeTheme: Record<ObjectType, ObjectTypeTheme> = {
  graph: {
    lightColor: '#F3F4F6',  // light grey
    accentColor: '#9CA3AF', // grey
    icon: FileJson,
    label: 'Graph',
    emoji: '📊'
  },
  node: {
    lightColor: '#DBEAFE',  // light blue
    accentColor: '#3B82F6', // blue
    icon: Box,
    label: 'Node',
    emoji: '🔵'
  },
  case: {
    lightColor: '#F3E8FF',  // light purple
    accentColor: '#A78BFA', // purple
    icon: Layers,
    label: 'Case',
    emoji: '🗂️'
  },
  context: {
    lightColor: '#D1FAE5',  // light green
    accentColor: '#34D399', // green
    icon: FileText,
    label: 'Context',
    emoji: '📄'
  },
  parameter: {
    lightColor: '#FED7AA',  // light orange
    accentColor: '#FB923C', // orange
    icon: Sliders,
    label: 'Parameter',
    emoji: '📋'
  },
  event: {
    lightColor: '#FEF3C7',  // light yellow
    accentColor: '#EAB308', // yellow-500
    icon: Calendar,
    label: 'Event',
    emoji: '📅'
  },
  edge: {
    lightColor: '#E0E7FF',  // light indigo
    accentColor: '#6366F1', // indigo
    icon: ArrowRight,
    label: 'Edge',
    emoji: '🔗'
  },
  special: {
    lightColor: '#F3F4F6',  // light grey
    accentColor: '#9CA3AF', // grey
    icon: Settings,
    label: 'Special',
    emoji: '⚙️'
  },
  credentials: {
    lightColor: '#FEF3C7',  // light amber
    accentColor: '#F59E0B', // amber
    icon: Key,
    label: 'Credentials',
    emoji: '🔑'
  },
  settings: {
    lightColor: '#F3F4F6',  // light grey
    accentColor: '#9CA3AF', // grey
    icon: Settings,
    label: 'Settings',
    emoji: '⚙️'
  },
  about: {
    lightColor: '#E0E7FF',  // light indigo
    accentColor: '#6366F1', // indigo
    icon: Info,
    label: 'About',
    emoji: 'ℹ️'
  },
  markdown: {
    lightColor: '#F3F4F6',  // light grey
    accentColor: '#6B7280', // grey-500
    icon: FileType,
    label: 'Document',
    emoji: '📄'
  }
};

/**
 * Get theme for a given object type
 */
export function getObjectTypeTheme(type: ObjectType): ObjectTypeTheme {
  return objectTypeTheme[type] || objectTypeTheme.special;
}

/**
 * Get CSS variables for a given object type
 */
export function getObjectTypeStyles(type: ObjectType): React.CSSProperties {
  const theme = getObjectTypeTheme(type);
  return {
    '--object-light-color': theme.lightColor,
    '--object-accent-color': theme.accentColor
  } as React.CSSProperties;
}

