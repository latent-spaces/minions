import '@github/markdown-toolbar-element';
import { useId, useRef, type DetailedHTMLProps, type HTMLAttributes, type KeyboardEvent, type SyntheticEvent, type TextareaHTMLAttributes } from 'react';
import { Bold, Code, Heading, Italic, Link, List, ListOrdered, Quote } from './icons';
import './markdown-field.css';

// GitHub's <markdown-toolbar> custom elements (MIT, @github/markdown-toolbar-element).
type ToolbarElement = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { for?: string; class?: string };
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'markdown-toolbar': ToolbarElement; 'md-header': ToolbarElement; 'md-bold': ToolbarElement; 'md-italic': ToolbarElement;
      'md-quote': ToolbarElement; 'md-code': ToolbarElement; 'md-link': ToolbarElement;
      'md-unordered-list': ToolbarElement; 'md-ordered-list': ToolbarElement;
    }
  }
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (letter: string) => `${mac ? '⌘' : 'Ctrl+'}${letter}`;
// GitHub's shortcuts: each one clicks its toolbar button, which edits the textarea with native undo.
const SHORTCUTS: Record<string, string> = { b: 'md-bold', i: 'md-italic', k: 'md-link', e: 'md-code' };

/** A Markdown textarea with GitHub's formatting toolbar; no Write / Preview tabs and no preview (owner, 16 November 2026).
 * Callers keep their own label (htmlFor the id). */
export function MarkdownField({ id, value, rows = 4, onKeyDown, ...textarea }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const fallback = useId(), fieldId = id ?? fallback;
  const input = useRef<HTMLTextAreaElement>(null), toolbar = useRef<HTMLElement>(null);
  // Custom toolbar elements are not natively disabled by a containing fieldset.
  // Guard them in capture phase so a locked exact-retry form cannot be edited.
  const locked = () => !!input.current && (input.current.matches(':disabled') || input.current.readOnly);
  function guardToolbar(event: SyntheticEvent) {
    if (locked() && event.target instanceof Element && event.target.closest('markdown-toolbar')) {
      event.preventDefault(); event.stopPropagation();
    }
  }
  function shortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    const button = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && SHORTCUTS[event.key.toLowerCase()];
    if (!button || event.defaultPrevented || locked()) return;
    event.preventDefault();
    toolbar.current?.querySelector<HTMLElement>(button)?.click();
  }
  const tool = (Tag: 'md-header' | 'md-bold' | 'md-italic' | 'md-quote' | 'md-code' | 'md-link' | 'md-unordered-list' | 'md-ordered-list', label: string, Icon: typeof Bold, letter?: string) =>
    <Tag role="button" aria-label={label} title={letter ? `${label} (${key(letter)})` : label}><Icon size={16} aria-hidden="true" /></Tag>;
  return <div className="k42-md-field" onClickCapture={guardToolbar} onKeyDownCapture={guardToolbar}>
    <div className="k42-md-bar">
      <markdown-toolbar ref={toolbar} for={fieldId} class="k42-md-toolbar" aria-label="Formatting">
        {tool('md-header', 'Heading', Heading)}{tool('md-bold', 'Bold', Bold, 'B')}{tool('md-italic', 'Italic', Italic, 'I')}
        <span className="k42-md-gap" aria-hidden="true" />
        {tool('md-quote', 'Quote', Quote)}{tool('md-code', 'Code', Code, 'E')}{tool('md-link', 'Link', Link, 'K')}
        <span className="k42-md-gap" aria-hidden="true" />
        {tool('md-unordered-list', 'Bulleted list', List)}{tool('md-ordered-list', 'Numbered list', ListOrdered)}
      </markdown-toolbar>
    </div>
    <textarea ref={input} id={fieldId} value={value} rows={rows} onKeyDown={shortcut} {...textarea} />
  </div>;
}
