import React, { useEffect, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, Code } from 'lucide-react';

interface PostItEditorProps {
  content: string;
  fontSize: number;
  editing: boolean;
  focusAt?: { x: number; y: number } | null;
  onFocusAtApplied?: () => void;
  onEditingChange: (editing: boolean) => void;
  onChange: (markdown: string) => void;
}

const btnBaseStyle: React.CSSProperties = {
  width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', borderRadius: '2px', cursor: 'pointer', padding: 0,
};

export function PostItEditor({
  content,
  fontSize,
  editing,
  focusAt,
  onFocusAtApplied,
  onEditingChange,
  onChange,
}: PostItEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Type here...' }),
      Markdown.configure({ html: false, tightLists: true, transformPastedText: true }),
    ],
    content,
    editable: true,
    onUpdate: ({ editor: ed }) => {
      onChange(ed.storage.markdown?.getMarkdown?.() ?? ed.getText());
    },
    onBlur: ({ editor: ed }) => {
      onEditingChange(false);
      ed.commands.setTextSelection(0);
      window.getSelection()?.removeAllRanges();
    },
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
    },
  });

  // Apply caret placement for "single click enters edit mode".
  useEffect(() => {
    if (!editing || !focusAt || !editor || editor.isDestroyed) return;

    // Ensure the editor is focused first.
    editor.commands.focus();

    const coords = { left: focusAt.x, top: focusAt.y };
    const pos = editor.view.posAtCoords(coords);
    if (pos?.pos != null) {
      editor.commands.setTextSelection(pos.pos);
    }
    onFocusAtApplied?.();
  }, [editing, focusAt, editor, onFocusAtApplied]);

  // Sync external content changes
  useEffect(() => {
    if (!editor || editor.isFocused || editor.isDestroyed) return;
    const md = editor.storage.markdown?.getMarkdown?.() ?? '';
    if (md !== content) editor.commands.setContent(content || '');
  }, [editor, content]);

  const Btn = useCallback(({ cmd, active, icon: Icon, title }: { cmd: () => void; active: boolean; icon: any; title: string }) => (
    <button onMouseDown={(e) => { e.preventDefault(); cmd(); }} title={title} className={`postit-toolbar-btn${active ? ' active' : ''}`} style={btnBaseStyle}>
      <Icon size={11} />
    </button>
  ), []);

  if (!editor) return null;

  return (
    <>
      {editing && (
        <div
          className="nodrag postit-editor-toolbar"
          style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: '4px',
            display: 'flex', gap: '1px', padding: '2px 3px',
            borderRadius: '4px', zIndex: 10,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Btn cmd={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} icon={Bold} title="Bold (Ctrl+B)" />
          <Btn cmd={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} icon={Italic} title="Italic (Ctrl+I)" />
          <div className="postit-toolbar-divider" />
          <Btn cmd={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} icon={Heading1} title="Heading 1" />
          <Btn cmd={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} icon={Heading2} title="Heading 2" />
          <div className="postit-toolbar-divider" />
          <Btn cmd={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} icon={List} title="Bullet List" />
          <Btn cmd={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} icon={ListOrdered} title="Numbered List" />
          <div className="postit-toolbar-divider" />
          <Btn cmd={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')} icon={Code} title="Code" />
        </div>
      )}

      <div
        className="postit-editor-scroll nowheel"
        onFocus={() => onEditingChange(true)}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && e.currentTarget.contains(next)) return;
          onEditingChange(false);
        }}
        style={{ width: '100%', height: '100%', overflow: 'auto', pointerEvents: editing ? 'auto' : 'none' }}
      >
        <EditorContent
          editor={editor}
          className={editing ? 'nodrag nowheel nopan' : ''}
          style={{ width: '100%', fontSize: `${fontSize}px`, lineHeight: 1.4, color: '#333', cursor: 'text', pointerEvents: editing ? 'auto' : 'none' }}
        />
      </div>
    </>
  );
}
