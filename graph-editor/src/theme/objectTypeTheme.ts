/**
 * Object Type Theme Configuration
 * 
 * Centralized colour palette and icon mappings for consistent visual language
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
  FileType,      // Markdown
  ScrollText,    // Session Log
  Image          // Image
} from 'lucide-react';

export type ObjectType = 'graph' | 'node' | 'case' | 'context' | 'parameter' | 'event' | 'edge' | 'special' | 'credentials' | 'connections' | 'settings' | 'about' | 'markdown' | 'session-log' | 'image';

export interface ObjectTypeTheme {
  /** Light pastel background colour */
  lightColour: string;
  /** Accent colour for borders, icons */
  accentColour: string;
  /** Icon component */
  icon: LucideIcon;
  /** Display name */
  label: string;
  /** Emoji fallback (for contexts where icons aren't suitable) */
  emoji: string;
}

export const objectTypeTheme: Record<ObjectType, ObjectTypeTheme> = {
  graph: {
    lightColour: '#F3F4F6',  // light grey
    accentColour: '#9CA3AF', // grey
    icon: FileJson,
    label: 'Graph',
    emoji: '📊'
  },
  node: {
    lightColour: '#DBEAFE',  // light blue
    accentColour: '#3B82F6', // blue
    icon: Box,
    label: 'Node',
    emoji: '🔵'
  },
  case: {
    lightColour: '#F3E8FF',  // light purple
    accentColour: '#A78BFA', // purple
    icon: Layers,
    label: 'Case',
    emoji: '🗂️'
  },
  context: {
    lightColour: '#D1FAE5',  // light green
    accentColour: '#34D399', // green
    icon: FileText,
    label: 'Context',
    emoji: '📄'
  },
  parameter: {
    lightColour: '#FED7AA',  // light orange
    accentColour: '#FB923C', // orange
    icon: Sliders,
    label: 'Parameter',
    emoji: '📋'
  },
  event: {
    lightColour: '#FEF3C7',  // light yellow
    accentColour: '#EAB308', // yellow-500
    icon: Calendar,
    label: 'Event',
    emoji: '📅'
  },
  edge: {
    lightColour: '#E0E7FF',  // light indigo
    accentColour: '#6366F1', // indigo
    icon: ArrowRight,
    label: 'Edge',
    emoji: '🔗'
  },
  special: {
    lightColour: '#F3F4F6',  // light grey
    accentColour: '#9CA3AF', // grey
    icon: Settings,
    label: 'Special',
    emoji: '⚙️'
  },
  credentials: {
    lightColour: '#FEF3C7',  // light amber
    accentColour: '#F59E0B', // amber
    icon: Key,
    label: 'Credentials',
    emoji: '🔑'
  },
  connections: {
    lightColour: '#E0F2FE',  // light sky
    accentColour: '#0EA5E9', // sky-500
    icon: Settings,
    label: 'Connections',
    emoji: '🔌'
  },
  settings: {
    lightColour: '#F3F4F6',  // light grey
    accentColour: '#9CA3AF', // grey
    icon: Settings,
    label: 'Settings',
    emoji: '⚙️'
  },
  about: {
    lightColour: '#E0E7FF',  // light indigo
    accentColour: '#6366F1', // indigo
    icon: Info,
    label: 'About',
    emoji: 'ℹ️'
  },
  markdown: {
    lightColour: '#F3F4F6',  // light grey
    accentColour: '#6B7280', // grey-500
    icon: FileType,
    label: 'Document',
    emoji: '📄'
  },
  'session-log': {
    lightColour: '#F0FDF4',  // light green
    accentColour: '#22C55E', // green-500
    icon: ScrollText,
    label: 'Session Log',
    emoji: '📜'
  },
  image: {
    lightColour: '#FDF4FF',  // light purple
    accentColour: '#A855F7', // purple-500
    icon: Image,
    label: 'Image',
    emoji: '🖼️'
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
    '--object-light-colour': theme.lightColour,
    '--object-accent-colour': theme.accentColour
  } as React.CSSProperties;
}

