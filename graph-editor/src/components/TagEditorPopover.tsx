/**
 * TagEditorPopover — lightweight floating editor for file tags.
 * Shown from Navigator context menu "Edit Tags…".
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChipInput } from './ChipInput';
import { fileRegistry } from '../contexts/TabContext';

interface TagEditorPopoverProps {
  /** File ID to edit tags for */
  fileId: string;
  /** Position to anchor the popover */
  x: number;
  y: number;
  /** Called when the popover should close */
  onClose: () => void;
}

export function TagEditorPopover({ fileId, x, y, onClose }: TagEditorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const file = fileRegistry.getFile(fileId);
  const data = file?.data as any;

  // Current tags — different file types store tags at different paths
  const currentTags: string[] = data?.tags || data?.metadata?.tags || [];
  const [tags, setTags] = useState<string[]>(currentTags);

  // Collect all existing tags for autocomplete
  const [allTags] = useState<string[]>(() => {
    const tagSet = new Set<string>();
    try {
      for (const f of fileRegistry.getAllFiles?.() ?? []) {
        const d = f?.data as any;
        d?.tags?.forEach?.((t: string) => tagSet.add(t));
        d?.metadata?.tags?.forEach?.((t: string) => tagSet.add(t));
      }
    } catch { /* ignore */ }
    return Array.from(tagSet).sort();
  });

  // Save tags to file
  const saveTags = useCallback((newTags: string[]) => {
    setTags(newTags);
    if (!file) return;

    const updatedData = { ...data };
    // Graph files store tags in metadata.tags, all others in data.tags
    if (file.type === 'graph') {
      updatedData.metadata = { ...(updatedData.metadata || {}), tags: newTags };
    } else {
      updatedData.tags = newTags;
    }
    fileRegistry.updateFile(fileId, updatedData);
  }, [file, data, fileId]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Small delay to avoid the context menu click closing us immediately
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Position: keep on screen
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 280),
    top: Math.min(y, window.innerHeight - 120),
    zIndex: 10000,
    background: '#fff',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    padding: '10px 12px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    width: '260px',
  };

  return (
    <div ref={popoverRef} style={style}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#666', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Tags
      </div>
      <ChipInput
        values={tags}
        onChange={saveTags}
        suggestions={allTags}
        placeholder="Add tag…"
      />
    </div>
  );
}
