import '@github/markdown-toolbar-element';
import { useId, useRef, useState, type DetailedHTMLProps, type HTMLAttributes, type KeyboardEvent, type SyntheticEvent, type TextareaHTMLAttributes } from 'react';
import { Bold, Code, Heading, Italic, Link, List, ListOrdered, Quote } from 'lucide-react';
import { ChatBody } from './ChatTimeline';
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

/** A Markdown textarea with GitHub's formatting toolbar and Write / Preview tabs. Callers keep their own label (htmlFor the id). */
export function MarkdownField({ id, value, rows = 4, onKeyDown, ...textarea }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const fallback = useId(), fieldId = id ?? fallback, panel = useId();
  const [preview, setPreview] = useState(false);
  const [height, setHeight] = useState<number>();
  const input = useRef<HTMLTextAreaElement>(null), toolbar = useRef<HTMLElement>(null), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function show(next: boolean) {
    if (next === preview) return;
    if (next) setHeight(input.current?.offsetHeight);
    setPreview(next);
  }
  function arrows(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const focused = tabs.current.indexOf(document.activeElement as HTMLButtonElement) === 1;
    const next = event.key === 'Home' ? false : event.key === 'End' ? true : !focused;
    show(next); tabs.current[next ? 1 : 0]?.focus();
  }
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
  const tab = (on: boolean, label: string) => <button id={`${panel}-${on ? 'preview' : 'write'}`} ref={element => { tabs.current[on ? 1 : 0] = element; }} type="button" role="tab" aria-selected={preview === on} aria-controls={panel} tabIndex={preview === on ? 0 : -1} onClick={() => show(on)}>{label}</button>;
  const tool = (Tag: 'md-header' | 'md-bold' | 'md-italic' | 'md-quote' | 'md-code' | 'md-link' | 'md-unordered-list' | 'md-ordered-list', label: string, Icon: typeof Bold, letter?: string) =>
    <Tag role="button" aria-label={label} title={letter ? `${label} (${key(letter)})` : label}><Icon size={16} aria-hidden="true" /></Tag>;
  return <div className="k42-md-field" onClickCapture={guardToolbar} onKeyDownCapture={guardToolbar}>
    <div className="k42-md-bar">
      <div className="k42-md-tabs" role="tablist" aria-label="Write or preview" onKeyDown={arrows}>{tab(false, 'Write')}{tab(true, 'Preview')}</div>
      <markdown-toolbar ref={toolbar} for={fieldId} class="k42-md-toolbar" aria-label="Formatting" hidden={preview || undefined}>
        {tool('md-header', 'Heading', Heading)}{tool('md-bold', 'Bold', Bold, 'B')}{tool('md-italic', 'Italic', Italic, 'I')}
        <span className="k42-md-gap" aria-hidden="true" />
        {tool('md-quote', 'Quote', Quote)}{tool('md-code', 'Code', Code, 'E')}{tool('md-link', 'Link', Link, 'K')}
        <span className="k42-md-gap" aria-hidden="true" />
        {tool('md-unordered-list', 'Bulleted list', List)}{tool('md-ordered-list', 'Numbered list', ListOrdered)}
      </markdown-toolbar>
    </div>
    <div id={panel} role="tabpanel" aria-labelledby={`${panel}-${preview ? 'preview' : 'write'}`}>
      <textarea ref={input} id={fieldId} value={value} rows={rows} hidden={preview} onKeyDown={shortcut} {...textarea} />
      {preview && <div className="k42-md-preview" style={{ minHeight: height }}>{value.trim() ? <ChatBody body={value} /> : <p className="k42-md-empty">Nothing to preview</p>}</div>}
    </div>
  </div>;
}
