import type { GraphIssue } from './graphIssuesService';

type IssueSeverity = 'error' | 'warning' | 'info';

export function formatIssuesForClipboard(args: {
  issues: GraphIssue[];
  context?: {
    searchTerm?: string;
    graphFilter?: string;
    includeReferencedFiles?: boolean;
    severities?: IssueSeverity[];
    generatedAt?: string;
  };
}): string {
  const { issues, context } = args;
  const generatedAt = context?.generatedAt ?? new Date().toISOString();
  const summary = {
    total: issues.length,
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
  };

  const payload = {
    generated_at: generatedAt,
    context: {
      searchTerm: context?.searchTerm ?? '',
      graphFilter: context?.graphFilter ?? '',
      includeReferencedFiles: context?.includeReferencedFiles,
      severities: context?.severities,
    },
    summary,
    issues: issues.map(i => ({
      fileId: i.fileId,
      type: i.type,
      severity: i.severity,
      category: i.category,
      message: i.message,
      field: i.field,
      suggestion: i.suggestion,
      details: i.details,
      nodeUuid: i.nodeUuid,
      edgeUuid: i.edgeUuid,
    })),
  };

  return JSON.stringify(payload, null, 2);
}



