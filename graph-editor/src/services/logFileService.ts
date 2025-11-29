import { fileRegistry } from '../contexts/TabContext';
import type { TabOperations, RepositoryItem, TabState } from '../types';

// Import db dynamically to avoid circular dependencies
async function getDb() {
  const { db } = await import('../db/appDatabase');
  return db;
}

/**
 * Log File Service
 * 
 * Creates temporary, read-only log files that:
 * - Don't persist to Git
 * - Are cleaned up when the tab closes
 * - Don't appear in navigator/parameter lists
 * - Display in markdown viewer (like docs)
 */
export class LogFileService {
  /**
   * Format plain text log content as markdown for better readability
   */
  private static formatLogAsMarkdown(content: string, title?: string): string {
    const lines = content.split('\n');
    const markdownLines: string[] = [];
    
    // Check if content already starts with a markdown header
    const firstLine = lines[0]?.trim() || '';
    const alreadyHasHeader = firstLine.startsWith('# ');
    
    // Add title header only if content doesn't already have one
    if (!alreadyHasHeader) {
      const logTitle = title || 'Batch Operation Log';
      markdownLines.push(`# ${logTitle}`);
      markdownLines.push('');
    }
    
    // Process content lines
    let inResults = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Empty line
      if (trimmed === '') {
        markdownLines.push('');
        continue;
      }
      
      // Metadata lines (bold)
      if (trimmed.startsWith('Batch Operation:') || 
          trimmed.startsWith('Index Rebuild Operation') ||
          trimmed.startsWith('Started:') || 
          trimmed.startsWith('Total items:') ||
          trimmed.startsWith('Total files processed:') ||
          trimmed.startsWith('Duration:')) {
        markdownLines.push(`**${trimmed}**`);
        continue;
      }
      
      // Results section header
      if (trimmed === 'Results:' || trimmed.endsWith(':') && /^(Added to Index|Updated in Index|Already in Index|Skipped|Errors)\s*\(\d+\):$/.test(trimmed)) {
        if (trimmed === 'Results:') {
          markdownLines.push('## Results');
          markdownLines.push('');
        } else {
          // Subsection headers like "Added to Index (5):"
          markdownLines.push('');
          markdownLines.push(`### ${trimmed.replace(':', '')}`);
          markdownLines.push('');
        }
        inResults = true;
        continue;
      }
      
      // Summary section
      if (trimmed === 'Summary:') {
        markdownLines.push('');
        markdownLines.push('## Summary');
        markdownLines.push('');
        inResults = false;
        continue;
      }
      
      // Summary items (indented with icons)
      if (/^\s+[✓✗⊘]/.test(line)) {
        markdownLines.push(`- ${trimmed}`);
        continue;
      }
      
      // Completed timestamp (italic)
      if (trimmed.startsWith('Completed:')) {
        markdownLines.push('');
        markdownLines.push(`*${trimmed}*`);
        continue;
      }
      
      // Result lines (status icon + details)
      if (/^[✓✗⊘]/.test(trimmed)) {
        // Format as list item for better readability
        markdownLines.push(`- ${trimmed}`);
        continue;
      }
      
      // Default: just add the line
      markdownLines.push(line);
    }
    
    return markdownLines.join('\n');
  }

  /**
   * Create a temporary log file and open it in a new tab
   * 
   * @param content - The log content (plain text)
   * @param tabOperations - Tab operations from useTabContext()
   * @param title - Display title for the log (defaults to timestamped name)
   * @returns Promise resolving to the tab ID
   */
  static async createLogFile(
    content: string,
    tabOperations: TabOperations,
    title?: string
  ): Promise<string | null> {
    try {
      const timestamp = Date.now();
      const logFileId = `log-${timestamp}`;
      
      // Format content as markdown
      const markdownContent = this.formatLogAsMarkdown(content, title);
      
      // Create temporary log file directly in fileRegistry
      // Use 'temporary' repository to prevent Git operations
      // Store content as markdown object (MarkdownViewer expects data.content)
      await fileRegistry.getOrCreateFile(
        logFileId,
        'markdown', // Use markdown type - won't appear in params area, displays in markdown viewer
        { 
          repository: 'temporary', 
          path: `log-${timestamp}.md`, 
          branch: 'main' 
        },
        { content: markdownContent } // Store as object with content property for MarkdownViewer
      );

      // Create tab directly (bypass openTab to avoid Git loading) - similar to URL data handling
      // Use a unique tab ID that includes 'interactive' to ensure correct view mode
      const timestampStr = timestamp.toString();
      const tabId = `tab-markdown-${timestampStr}-interactive`;
      const logTitle = title || `Log ${new Date().toISOString().split('T')[0]}`;
      
      const newTab: TabState = {
        id: tabId,
        fileId: logFileId,
        viewMode: 'interactive', // Use interactive mode to show in markdown viewer (like docs)
        title: logTitle,
        icon: '📄',
        closable: true,
        group: 'main-content'
      };

      // Add to registry
      await fileRegistry.addViewTab(logFileId, tabId);
      
      // We need to add the tab to the tabs state - but we can't access setTabs directly
      // Instead, we'll use a custom event that TabContext can listen to
      // OR we can import TabContext operations differently
      // Actually, let's use the tabOperations to add the tab via a different method
      // For now, let's dispatch an event that TabContext can handle
      window.dispatchEvent(new CustomEvent('dagnet:openTemporaryTab', { 
        detail: { tab: newTab } 
      }));
      
      // Mark file as temporary for cleanup
      const file = fileRegistry.getFile(logFileId);
      if (file) {
        (file as any).isTemporary = true;
      }

      return tabId;
    } catch (error) {
      console.error('[LogFileService] Failed to create log file:', error);
      throw error;
    }
  }

  /**
   * Clean up temporary log files when their tabs close
   * Should be called from TabContext.closeTab for files with repository: 'temporary'
   */
  static async cleanupTemporaryFile(fileId: string): Promise<void> {
    try {
      const file = fileRegistry.getFile(fileId);
      if (file && file.source?.repository === 'temporary') {
        // Remove from fileRegistry
        await fileRegistry.deleteFile(fileId);
        
        // Remove from IndexedDB
        const db = await getDb();
        await db.files.delete(fileId);
        
        console.log(`[LogFileService] Cleaned up temporary log file: ${fileId}`);
      }
    } catch (error) {
      console.error(`[LogFileService] Failed to cleanup temporary file ${fileId}:`, error);
    }
  }
}

