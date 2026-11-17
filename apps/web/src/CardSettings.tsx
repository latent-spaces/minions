import { Pencil } from './ui/icons';
import { MarkdownField } from './ui/MarkdownField';
import { ChatBody } from './ui/ChatTimeline';
import { Button } from './ui/Button';
// The project card in Settings: name, description and rules, read-only for everyone. The owner's Edit opens the form;
// Save or Cancel closes it (owner, 15 November 2026). Each save is a new version on the server; the history list is not
// shown in Settings (owner, 16 November 2026).
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import type { ProjectRequest } from './explore-api';
import type { Workspace } from './project-api';
import { CARD_FIELDS, cardBody, cardFields, type CardFields } from './project-settings';
import { hold } from './route';

const LABELS: Record<typeof CARD_FIELDS[number], string> = { title: 'Project name', goal: 'Description', rules: 'Rules' };

export function CardSettings({ request, workspace, definition, refresh }: { request: ProjectRequest; workspace: Workspace; definition: NonNullable<Workspace['definition']>; refresh: () => void }) {
  const owner = workspace.execution !== 'closed' && workspace.role === 'owner', version = workspace.cardVersion ?? 1;
  const [fields, setFields] = useState<CardFields>(() => cardFields(definition));
  const [pending, setPending] = useState<object | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [saved, setSaved] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  // base is the version the fields were loaded from. A save is fenced on it, so a reload during an edit cannot move
  // the edit onto a version the owner has not read.
  const [base, setBase] = useState(version);
  const dirty = useRef(false);
  const [hasEdits, setHasEdits] = useState(false);
  const locked = busy || pending !== null;
  const [editing, setEditing] = useState(false);
  const titleId = 'card-basics-title';
  useEffect(() => locked || hasEdits ? hold() : undefined, [locked, hasEdits]);
  // A reload shows the current version unless the owner has unsaved edits.
  useEffect(() => { if (!dirty.current) { setFields(cardFields(definition)); setBase(version); } }, [definition, version]);
  function edit(field: typeof CARD_FIELDS[number], value: string) { dirty.current = true; setHasEdits(true); setSaved(null); setFields(previous => ({ ...previous, [field]: value })); }
  async function save(body: object) {
    if (busy) return;
    setPending(body); setBusy(true); setError(null); setSaved(null); setStale(false);
    try {
      const result = await request<{ version: number }>(`/${workspace.id}/card`, body);
      dirty.current = false; setHasEdits(false); setBase(result.version); setPending(null); setSaved(result.version); setEditing(false); refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Retry the original request.');
      // A definite refusal saved nothing: the edits stay editable and a new save is a new request. An unknown outcome
      // keeps the original request for a safe retry.
      if (e instanceof ApiError && [400, 401, 403, 404, 409].includes(e.status)) { setPending(null); setStale(e.status === 409); refresh(); }
    } finally { setBusy(false); }
  }
  function reload() { dirty.current = false; setHasEdits(false); setBase(version); setPending(null); setStale(false); setError(null); setFields(cardFields(definition)); refresh(); }
  function cancel() { reload(); setEditing(false); }
  const form = owner && editing && <form className="settings-form card-form" onSubmit={e => { e.preventDefault(); void save({ ...cardBody(fields, base, definition), client_request_id: crypto.randomUUID() }); }}>
    <fieldset disabled={locked}>
      {CARD_FIELDS.map(field => <div key={field}>
        <label htmlFor={`card-${field}`}>{LABELS[field]}{field === 'rules' && <span className="muted"> (optional)</span>}</label>
        {field === 'title'
          ? <input id="card-title" required maxLength={120} value={fields.title} onChange={e => edit('title', e.target.value)} />
          : <MarkdownField id={`card-${field}`} rows={field === 'rules' ? 4 : 3} maxLength={field === 'rules' ? 3000 : 1500} required={field === 'goal'} value={fields[field]} onChange={e => edit(field, e.target.value)} />}
      </div>)}
      <div className="settings-save-row"><Button disabled={!hasEdits || stale}>{busy ? 'Saving…' : 'Save changes'}</Button>{!pending && <Button type="button" className="soft" onClick={cancel}>Cancel</Button>}</div>
    </fieldset>
  </form>;
  return <section className="settings-section" aria-labelledby={titleId}>
    <h3 id={titleId} className="visually-hidden">Project card</h3>
    {!form && <dl className="settings-readonly"><div><dt>Project name</dt><dd>{definition.title}</dd></div><div><dt>Description</dt><dd><ChatBody body={definition.goal} /></dd></div>{definition.rules && <div><dt>Rules</dt><dd><ChatBody body={definition.rules} /></dd></div>}</dl>}
    {owner && !form && <div className="settings-save-row"><Button type="button" className="soft card-edit" onClick={() => { setSaved(null); setEditing(true); }}><Pencil size={14} aria-hidden="true" />Edit</Button></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {saved !== null && <p role="status">Saved as version {saved}.</p>}
    {pending && !busy && <div className="pending-action"><p>Save not confirmed. Retry the same request before making another edit.</p>
      <div className="actions"><Button disabled={busy} onClick={() => void save(pending)}>Retry original save</Button><Button disabled={busy} onClick={reload}>Discard edits and reload</Button></div>
    </div>}
    {stale && <div className="pending-action"><p>A newer version is available. Your draft is kept; copy it before reloading.</p>
      <Button disabled={busy} onClick={reload}>Discard edits and load current version</Button>
    </div>}
    {form}
  </section>;
}
