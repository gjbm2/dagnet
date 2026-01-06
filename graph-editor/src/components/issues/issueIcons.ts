export type IssueSeverity = 'error' | 'warning' | 'info';

export function getSeverityIcon(severity: IssueSeverity): string {
  if (severity === 'error') return '❌';
  if (severity === 'warning') return '⚠️';
  return 'ℹ️';
}

export function getSeverityLabel(severity: IssueSeverity): string {
  if (severity === 'error') return 'Errors';
  if (severity === 'warning') return 'Warnings';
  return 'Info';
}


