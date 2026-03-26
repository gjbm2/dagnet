import React, { useEffect, useCallback, useState, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import { Bold, Italic, Heading1, Heading2, List, ListOrdered, Code, ChevronDown } from 'lucide-react';
import { POSTIT_COLOURS } from './PostItNode';

const FONT_SIZE_LABELS: Record<string, string> = { S: 'S', M: 'M', L: 'L', XL: 'XL' };

const COLOUR_NAMES: Record<string, string> = {
  '#FFF475': 'Canary Yellow',
  '#F4BFDB': 'Power Pink',
  '#B6E3E9': 'Aqua Splash',
  '#CEED9D': 'Limeade',
  '#FFD59D': 'Neon Orange',
  '#D3BFEE': 'Iris',
};

interface PostItEditorProps {
  content: string;
  fontSize: number;
  fontSizeKey: string;
  colour: string;
  editing: boolean;
  zoom: number;
  focusAt?: { x: number; y: number } | null;
  onFocusAtApplied?: () => void;
  onEditingChange: (editing: boolean) => void;
  onChange: (markdown: string) => void;
  onFontSizeChange: (key: string) => void;
  onColourChange: (hex: string) => void;
}

const btnBaseStyle: React.CSSProperties = {
  width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', borderRadius: '2px', cursor: 'pointer', padding: 0,
};

export function PostItEditor({
  content,
  fontSize,
  fontSizeKey,
  colour,
  editing,
  zoom,
  focusAt,
  onFocusAtApplied,
  onEditingChange,
  onChange,
  onFontSizeChange,
  onColourChange,
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
      onChange((ed.storage as any).markdown?.getMarkdown?.() ?? ed.getText());
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

  // Auto-focus for freshly-created notes (no click position available).
  useEffect(() => {
    if (!editing || focusAt || !editor || editor.isDestroyed) return;
    if (editor.isFocused) return;
    if ((content ?? '') !== '') return;
    editor.commands.focus('end');
  }, [editing, focusAt, editor, content]);

  // Sync external content changes
  useEffect(() => {
    if (!editor || editor.isFocused || editor.isDestroyed) return;
    const md = (editor.storage as any).markdown?.getMarkdown?.() ?? '';
    if (md !== content) editor.commands.setContent(content || '');
  }, [editor, content]);

  const Btn = useCallback(({ cmd, active, icon: Icon, title }: { cmd: () => void; active: boolean; icon: any; title: string }) => (
    <button onMouseDown={(e) => { e.preventDefault(); cmd(); }} title={title} className={`postit-toolbar-btn${active ? ' active' : ''}`} style={btnBaseStyle}>
      <Icon size={11} />
    </button>
  ), []);

  // Dropdown state
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [colourOpen, setColourOpen] = useState(false);
  const fontSizeRef = useRef<HTMLDivElement>(null);
  const colourRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!fontSizeOpen && !colourOpen) return;
    const handler = (e: MouseEvent) => {
      if (fontSizeOpen && fontSizeRef.current && !fontSizeRef.current.contains(e.target as Node)) setFontSizeOpen(false);
      if (colourOpen && colourRef.current && !colourRef.current.contains(e.target as Node)) setColourOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [fontSizeOpen, colourOpen]);

  if (!editor) return null;

  return (
    <>
      {editing && (
        <div
          className="nodrag postit-editor-toolbar"
          style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: `${4 / zoom}px`,
            display: 'flex', gap: '1px', padding: '2px 3px',
            borderRadius: '4px', zIndex: 10, alignItems: 'center',
            transformOrigin: 'bottom left',
            ...(zoom && zoom !== 1 ? { zoom: 1 / zoom } as any : {}),
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
          <div className="postit-toolbar-divider" />

          {/* Font size dropdown */}
          <div ref={fontSizeRef} style={{ position: 'relative' }}>
            <button
              onMouseDown={(e) => { e.preventDefault(); setFontSizeOpen(!fontSizeOpen); }}
              title="Font size"
              className="postit-toolbar-btn"
              style={{ ...btnBaseStyle, width: 'auto', padding: '0 3px', gap: '1px', fontSize: '10px', fontWeight: 600 }}
            >
              {fontSizeKey}<ChevronDown size={8} />
            </button>
            {fontSizeOpen && (
              <div
                className="postit-editor-toolbar"
                style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: '2px',
                  display: 'flex', flexDirection: 'column', padding: '2px',
                  borderRadius: '4px', zIndex: 20, minWidth: '28px',
                }}
              >
                {Object.entries(FONT_SIZE_LABELS).map(([key, label]) => (
                  <button
                    key={key}
                    onMouseDown={(e) => { e.preventDefault(); onFontSizeChange(key); setFontSizeOpen(false); }}
                    className={`postit-toolbar-btn${key === fontSizeKey ? ' active' : ''}`}
                    style={{ ...btnBaseStyle, width: '100%', fontSize: '10px', fontWeight: key === fontSizeKey ? 700 : 400, justifyContent: 'center' }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="postit-toolbar-divider" />

          {/* Colour dropdown */}
          <div ref={colourRef} style={{ position: 'relative' }}>
            <button
              onMouseDown={(e) => { e.preventDefault(); setColourOpen(!colourOpen); }}
              title="Colour"
              className="postit-toolbar-btn"
              style={{ ...btnBaseStyle, width: 'auto', padding: '0 3px', gap: '3px', fontSize: '10px', fontWeight: 600 }}
            >
              <span style={{
                display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%',
                background: colour, border: '1px solid rgba(0,0,0,0.2)', flexShrink: 0,
              }} />
              <ChevronDown size={8} />
            </button>
            {colourOpen && (
              <div
                className="postit-editor-toolbar"
                style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: '2px',
                  display: 'flex', flexDirection: 'column', padding: '2px',
                  borderRadius: '4px', zIndex: 20, minWidth: '100px',
                }}
              >
                {POSTIT_COLOURS.map((c) => (
                  <button
                    key={c}
                    onMouseDown={(e) => { e.preventDefault(); onColourChange(c); setColourOpen(false); }}
                    className={`postit-toolbar-btn${c === colour ? ' active' : ''}`}
                    style={{
                      ...btnBaseStyle, width: '100%', fontSize: '10px',
                      fontWeight: c === colour ? 700 : 400,
                      justifyContent: 'flex-start', gap: '6px', padding: '2px 6px',
                    }}
                  >
                    <span style={{
                      display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%',
                      background: c, border: '1px solid rgba(0,0,0,0.15)', flexShrink: 0,
                    }} />
                    {COLOUR_NAMES[c] || c}
                  </button>
                ))}
              </div>
            )}
          </div>
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
          style={{ width: '100%', fontSize: `${fontSize}px`, lineHeight: 1.4, color: 'inherit', cursor: 'text', pointerEvents: editing ? 'auto' : 'none' }}
        />
      </div>
    </>
  );
}
