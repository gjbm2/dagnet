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
  Network,       // Graph
  LineChart,     // Chart
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
  Image,         // Image
  Link2          // Signature Links
} from 'lucide-react';

export type ObjectType = 'graph' | 'chart' | 'node' | 'case' | 'context' | 'parameter' | 'event' | 'edge' | 'special' | 'credentials' | 'connections' | 'settings' | 'about' | 'markdown' | 'session-log' | 'image' | 'signature-links' | 'hash-mappings';

export interface ObjectTypeTheme {
  /** Light pastel background colour */
  lightColour: string;
  /** Accent colour for borders, icons */
  accentColour: string;
  /** Dark mode: muted background colour */
  darkLightColour: string;
  /** Dark mode: brighter accent colour */
  darkAccentColour: string;
  /** Icon component */
  icon: LucideIcon;
  /** Display name */
  label: string;
  /** Emoji fallback (for contexts where icons aren't suitable) */
  emoji: string;
}

export const objectTypeTheme: Record<ObjectType, ObjectTypeTheme> = {
  graph: {
    lightColour: '#F3F4F6', accentColour: '#9CA3AF',
    darkLightColour: '#2a2a2a', darkAccentColour: '#9CA3AF',
    icon: Network, label: 'Graph', emoji: '📊'
  },
  chart: {
    lightColour: '#E0F2FE', accentColour: '#0EA5E9',
    darkLightColour: '#0c2a3d', darkAccentColour: '#38bdf8',
    icon: LineChart, label: 'Chart', emoji: '📈'
  },
  node: {
    lightColour: '#DBEAFE', accentColour: '#3B82F6',
    darkLightColour: '#172554', darkAccentColour: '#60a5fa',
    icon: Box, label: 'Node', emoji: '🔵'
  },
  case: {
    lightColour: '#F3E8FF', accentColour: '#A78BFA',
    darkLightColour: '#2e1065', darkAccentColour: '#c4b5fd',
    icon: Layers, label: 'Case', emoji: '🗂️'
  },
  context: {
    lightColour: '#D1FAE5', accentColour: '#34D399',
    darkLightColour: '#052e16', darkAccentColour: '#6ee7b7',
    icon: FileText, label: 'Context', emoji: '📄'
  },
  parameter: {
    lightColour: '#FED7AA', accentColour: '#FB923C',
    darkLightColour: '#431407', darkAccentColour: '#fdba74',
    icon: Sliders, label: 'Parameter', emoji: '📋'
  },
  event: {
    lightColour: '#FEF3C7', accentColour: '#EAB308',
    darkLightColour: '#422006', darkAccentColour: '#facc15',
    icon: Calendar, label: 'Event', emoji: '📅'
  },
  edge: {
    lightColour: '#E0E7FF', accentColour: '#6366F1',
    darkLightColour: '#1e1b4b', darkAccentColour: '#a5b4fc',
    icon: ArrowRight, label: 'Edge', emoji: '🔗'
  },
  special: {
    lightColour: '#F3F4F6', accentColour: '#9CA3AF',
    darkLightColour: '#2a2a2a', darkAccentColour: '#9CA3AF',
    icon: Settings, label: 'Special', emoji: '⚙️'
  },
  credentials: {
    lightColour: '#FEF3C7', accentColour: '#F59E0B',
    darkLightColour: '#422006', darkAccentColour: '#fbbf24',
    icon: Key, label: 'Credentials', emoji: '🔑'
  },
  connections: {
    lightColour: '#E0F2FE', accentColour: '#0EA5E9',
    darkLightColour: '#0c2a3d', darkAccentColour: '#38bdf8',
    icon: Settings, label: 'Connections', emoji: '🔌'
  },
  settings: {
    lightColour: '#F3F4F6', accentColour: '#9CA3AF',
    darkLightColour: '#2a2a2a', darkAccentColour: '#9CA3AF',
    icon: Settings, label: 'Settings', emoji: '⚙️'
  },
  about: {
    lightColour: '#E0E7FF', accentColour: '#6366F1',
    darkLightColour: '#1e1b4b', darkAccentColour: '#a5b4fc',
    icon: Info, label: 'About', emoji: 'ℹ️'
  },
  markdown: {
    lightColour: '#F3F4F6', accentColour: '#6B7280',
    darkLightColour: '#2a2a2a', darkAccentColour: '#9CA3AF',
    icon: FileType, label: 'Document', emoji: '📄'
  },
  'session-log': {
    lightColour: '#F0FDF4', accentColour: '#22C55E',
    darkLightColour: '#052e16', darkAccentColour: '#4ade80',
    icon: ScrollText, label: 'Session Log', emoji: '📜'
  },
  image: {
    lightColour: '#FDF4FF', accentColour: '#A855F7',
    darkLightColour: '#3b0764', darkAccentColour: '#c084fc',
    icon: Image, label: 'Image', emoji: '🖼️'
  },
  'signature-links': {
    lightColour: '#E0E7FF', accentColour: '#6366F1',
    darkLightColour: '#1e1b4b', darkAccentColour: '#a5b4fc',
    icon: Link2, label: 'Snapshot Manager', emoji: '🔗'
  },
  'hash-mappings': {
    lightColour: '#E0E7FF', accentColour: '#6366F1',
    darkLightColour: '#1e1b4b', darkAccentColour: '#a5b4fc',
    icon: Link2, label: 'Hash Mappings', emoji: '🔗'
  }
};

/**
 * Get theme for a given object type
 */
export function getObjectTypeTheme(type: ObjectType): ObjectTypeTheme {
  return objectTypeTheme[type] || objectTypeTheme.special;
}

/** Check whether dark mode is currently active (reads data-theme attribute). */
export function isDarkMode(): boolean {
  try {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  } catch {
    return false;
  }
}

/**
 * Get the effective light/accent colours for a given object type,
 * respecting the current theme (light or dark).
 */
export function getThemedColours(type: ObjectType): { lightColour: string; accentColour: string } {
  const theme = getObjectTypeTheme(type);
  if (isDarkMode()) {
    return { lightColour: theme.darkLightColour, accentColour: theme.darkAccentColour };
  }
  return { lightColour: theme.lightColour, accentColour: theme.accentColour };
}

/**
 * Get CSS variables for a given object type
 */
export function getObjectTypeStyles(type: ObjectType): React.CSSProperties {
  const { lightColour, accentColour } = getThemedColours(type);
  return {
    '--object-light-colour': lightColour,
    '--object-accent-colour': accentColour
  } as React.CSSProperties;
}

