// Self-hosted document store: the Firestore Admin API subset apps/server uses,
// over node:sqlite (no native dependency; Windows, macOS and Linux). Documents are
// canonical JSON rows; queries narrow string equality in SQL, then filter and sort in
// process with Firestore value ordering, so this targets a single-node engine, not
// Firestore-scale data.
// test/document-store-contract.ts defines the behaviour it must match.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { Timestamp, FieldPath, FieldValue, Filter } from 'firebase-admin/firestore';

type Data = Record<string, any>;
type Row = { path: string; parent: string; coll: string; data: string; create_us: number; update_us: number };
// A read-only transaction's view: the pre-image of every document committed since it began (null = absent then).
type Snapshot = { before: Map<string, Row | null>; readTime: Timestamp };

const DOC_ID = '__name__';
// Defining an own data field keeps arbitrary map keys from invoking Object.prototype setters.
function putField(target: Data, key: string, value: any): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
function fieldName(field: any): string {
  if (typeof field === 'string') return field;
  if (field instanceof FieldPath) {
    const s = (field as any).formattedName ?? (field as any)._formattedName ?? String(field);
    if (field.isEqual(FieldPath.documentId())) return DOC_ID;
    return typeof s === 'string' ? s.replace(/`/g, '') : (field as any).segments.join('.');
  }
  throw new Error(`Unsupported field ${String(field)}`);
}

// ---- value encoding -------------------------------------------------------
const TAG = '__k42';
function encode(value: any): any {
  if (value instanceof Timestamp) return { __k42: 'ts', s: value.seconds, n: value.nanoseconds };
  if (value instanceof Date) return encode(Timestamp.fromDate(value));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __k42: 'bytes', b: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  // JSON has no NaN or Infinity; Firestore stores them as doubles.
  if (typeof value === 'number' && !Number.isFinite(value)) return { [TAG]: 'num', v: String(value) };
  if (value && typeof value === 'object') {
    if (value instanceof DocRef) return { __k42: 'ref', p: value.path };
    // Sorted keys make the stored JSON canonical, so identical writes compare equal.
    const out: Data = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) putField(out, k, encode(value[k]));
    // A user map that has the tag key itself is wrapped, so it never decodes as a typed value.
    return Object.hasOwn(out, TAG) ? { [TAG]: 'map', v: out } : out;
  }
  return value;
}
function decode(value: any, db: SqliteFirestore): any {
  if (Array.isArray(value)) return value.map(v => decode(v, db));
  if (value && typeof value === 'object') {
    const tag = Object.hasOwn(value, TAG) ? value[TAG] : undefined;
    if (tag === 'ts') return new Timestamp(value.s, value.n);
    if (tag === 'bytes') return Buffer.from(value.b, 'base64');
    if (tag === 'ref') return db.doc(value.p);
    if (tag === 'num') return Number(value.v);
    const out: Data = {};
    for (const [k, v] of Object.entries(tag === 'map' ? value.v : value)) putField(out, k, decode(v, db));
    return out;
  }
  return value;
}

// ---- Firestore value ordering --------------------------------------------
function typeRank(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (v instanceof Timestamp) return 3;
  if (typeof v === 'string') return 4;
  if (Buffer.isBuffer(v)) return 5;
  if (v instanceof DocRef) return 6;
  if (Array.isArray(v)) return 8;
  return 9;
}
const utf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function compare(a: any, b: any): number {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0: return 0;
    case 1: return Number(a) - Number(b);
    case 2: if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1; if (Number.isNaN(b)) return 1; return a < b ? -1 : a > b ? 1 : 0;
    case 3: return a.seconds - b.seconds || a.nanoseconds - b.nanoseconds;
    case 4: return utf8(a, b);
    case 5: return Buffer.compare(a, b);
    case 6: return comparePaths(a.path, b.path);
    case 8: { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; } return a.length - b.length; }
    default: {
      const ka = Object.keys(a).sort(utf8), kb = Object.keys(b).sort(utf8);
      for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
        const c = utf8(ka[i], kb[i]) || compare(a[ka[i]], b[kb[i]]); if (c) return c;
      }
      return ka.length - kb.length;
    }
  }
}
function comparePaths(a: string, b: string): number {
  const sa = a.split('/'), sb = b.split('/');
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) { const c = utf8(sa[i], sb[i]); if (c) return c; }
  return sa.length - sb.length;
}
const equal = (a: any, b: any) => typeRank(a) === typeRank(b) && compare(a, b) === 0;

function getField(data: Data, path: string): { found: boolean; value?: any } {
  let cur: any = data;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || cur instanceof Timestamp || !Object.hasOwn(cur, seg)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

// ---- field transforms (FieldValue sentinels from firebase-admin) ----------
function transformKind(v: any): string | null {
  const name = v instanceof FieldValue ? (v as any).methodName : undefined;
  return typeof name === 'string' && name.startsWith('FieldValue.') ? name : null;
}
function applyTransform(kind: string, sentinel: any, previous: any, now: Timestamp): any {
  switch (kind) {
    case 'FieldValue.serverTimestamp': return now;
    case 'FieldValue.increment': { const op = sentinel.operand ?? sentinel._operand; return (typeof previous === 'number' ? previous : 0) + op; }
    case 'FieldValue.arrayUnion': { const out = Array.isArray(previous) ? [...previous] : []; for (const e of sentinel.elements ?? sentinel._elements) if (!out.some(x => equal(x, e))) out.push(e); return out; }
    case 'FieldValue.arrayRemove': { const els = sentinel.elements ?? sentinel._elements; return (Array.isArray(previous) ? previous : []).filter(x => !els.some((e: any) => equal(x, e))); }
    default: throw new Error(`Unsupported transform ${kind}`);
  }
}
function setPath(target: Data, path: string[], value: any, now: Timestamp) {
  let cur = target;
  const last = path[path.length - 1], kind = transformKind(value);
  for (const seg of path.slice(0, -1)) {
    if (!Object.hasOwn(cur, seg) || !isPlainMap(cur[seg])) {
      // Deleting below a missing or non-map field leaves the document as it is.
      if (kind === 'FieldValue.delete') return;
      putField(cur, seg, {});
    }
    cur = cur[seg];
  }
  if (kind === 'FieldValue.delete') delete cur[last];
  else if (kind) putField(cur, last, applyTransform(kind, value, Object.hasOwn(cur, last) ? cur[last] : undefined, now));
  else putField(cur, last, resolveTransforms(value, undefined, now));
}
// Replace nested sentinels (set without merge, plain values).
function resolveTransforms(value: any, previous: any, now: Timestamp): any {
  const kind = transformKind(value);
  if (kind === 'FieldValue.delete') throw new Error('FieldValue.delete() is only allowed in update or merge');
  if (kind) return applyTransform(kind, value, previous, now);
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Timestamp) && !Buffer.isBuffer(value) && !(value instanceof DocRef) && !(value instanceof Date)) {
    const out: Data = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) putField(out, k, resolveTransforms(v, previous && Object.hasOwn(previous, k) ? previous[k] : undefined, now));
    return out;
  }
  return value;
}
function mergeInto(target: Data, patch: Data, now: Timestamp) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    // Firestore merges into non-empty maps only: an empty map is a leaf value, and a map replaces any non-map value.
    if (isPlainMap(v) && Object.keys(v).length) {
      const had = Object.hasOwn(target, k), previous = had ? target[k] : undefined, replaced = !had || !isPlainMap(previous);
      if (replaced) putField(target, k, {});
      mergeInto(target[k], v, now);
      // A patch that only deleted keys under a missing or non-map field writes nothing there.
      if (replaced && !Object.keys(target[k]).length) { if (had) putField(target, k, previous); else delete target[k]; }
    } else setPath(target, [k], v, now);
  }
}
function isPlainMap(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !Buffer.isBuffer(v) && !(v instanceof DocRef)
    && !(v instanceof Date) && !transformKind(v);
}
function splitFieldPath(p: any): string[] {
  if (p instanceof FieldPath) return (p as any).segments ?? (p as any)._segments;
  return String(p).split('.');
}

// ---- errors with gRPC-like codes -----------------------------------------
class StoreError extends Error {
  constructor(public code: number, message: string) { super(`${code} ${['', '', '', 'INVALID_ARGUMENT', '', 'NOT_FOUND', 'ALREADY_EXISTS', '', '', 'FAILED_PRECONDITION', 'ABORTED'][code] ?? ''}: ${message}`); }
  get details() { return this.message; }
}

// ---- snapshots ------------------------------------------------------------
class DocSnap {
  constructor(public ref: DocRef, private raw: Data | undefined, public createTime: Timestamp | undefined,
    public updateTime: Timestamp | undefined, public readTime: Timestamp, private fields?: string[]) {}
  get id() { return this.ref.id; }
  get exists() { return this.raw !== undefined; }
  private plain(): Data | undefined {
    if (!this.raw) return undefined;
    if (!this.fields) return this.raw;
    const out: Data = {};
    for (const f of this.fields) { const r = getField(this.raw, f); if (r.found) setPath(out, f.split('.'), r.value, this.readTime); }
    return out;
  }
  data(): any {
    const plain = this.plain();
    if (plain === undefined) return undefined;
    const conv = this.ref.converter;
    return conv ? conv.fromFirestore(new DocSnap(this.ref.withConverter(null), plain, this.createTime, this.updateTime, this.readTime) as any) : structuredCloneData(plain);
  }
  // Like data(), a projected snapshot (select() or a getAll fieldMask) answers only its projected fields.
  get(field: any) { const source = this.plain(); const r = source && getField(source, fieldName(field)); return r && r.found ? r.value : undefined; }
  isEqual(other: DocSnap) { return other.ref.path === this.ref.path && compare(this.updateTime ?? null, other.updateTime ?? null) === 0; }
  rawData() { return this.raw; }
}
function structuredCloneData(d: Data): Data { return decodeLoose(d); }
function decodeLoose(v: any): any {
  if (Array.isArray(v)) return v.map(decodeLoose);
  if (v && typeof v === 'object' && !(v instanceof Timestamp) && !Buffer.isBuffer(v) && !(v instanceof DocRef)) {
    const out: Data = {}; for (const [k, x] of Object.entries(v)) putField(out, k, decodeLoose(x)); return out;
  }
  return v;
}
class QuerySnap {
  // A one-off get() reports every document as added, as Firestore does.
  constructor(public query: Query, public docs: DocSnap[], public readTime: Timestamp,
    private changes: any[] = docs.map((doc, newIndex) => ({ type: 'added', doc, oldIndex: -1, newIndex }))) {}
  get empty() { return this.docs.length === 0; }
  get size() { return this.docs.length; }
  forEach(fn: (d: DocSnap) => void) { this.docs.forEach(fn); }
  docChanges() { return this.changes; }
}

// ---- references & queries -------------------------------------------------
type Where = { kind: 'field'; field: string; op: string; value: any } | { kind: 'composite'; op: 'AND' | 'OR'; filters: Where[] };
type Order = { field: string; dir: 'asc' | 'desc' };
type QState = { parent: string | null; group: string | null; wheres: Where[]; orders: Order[]; limit?: number; offset?: number;
  start?: { values: any[]; before: boolean }; end?: { values: any[]; before: boolean }; select?: string[]; limitToLast?: boolean };

function toWhere(filter: any): Where {
  // firebase-admin Filter objects (UnaryFilter / CompositeFilter); use their public-ish getters.
  if (typeof filter._getFilters === 'function') {
    return { kind: 'composite', op: String(filter._getOperator()).toUpperCase() === 'OR' ? 'OR' : 'AND', filters: filter._getFilters().map(toWhere) };
  }
  if (typeof filter._getField === 'function') return { kind: 'field', field: fieldName(filter._getField()), op: filter._getOperator(), value: filter._getValue() };
  throw new Error('Unsupported filter object');
}

export class Query {
  constructor(public db: SqliteFirestore, public state: QState, public converter: any = null) {}
  get firestore() { return this.db; }
  protected next(patch: Partial<QState>) { return new Query(this.db, { ...this.state, ...patch }, this.converter); }
  where(a: any, op?: string, value?: any): Query {
    const w: Where = a instanceof Filter || (a && (a._getFilters || a._getField)) ? toWhere(a) : { kind: 'field', field: fieldName(a), op: op!, value };
    return this.next({ wheres: [...this.state.wheres, w] });
  }
  orderBy(field: any, dir: 'asc' | 'desc' = 'asc') { return this.next({ orders: [...this.state.orders, { field: fieldName(field), dir }] }); }
  limit(n: number) { return this.next({ limit: n, limitToLast: false }); }
  limitToLast(n: number) { return this.next({ limit: n, limitToLast: true }); }
  offset(n: number) { return this.next({ offset: n }); }
  select(...fields: any[]) { return this.next({ select: fields.map(fieldName) }); }
  startAfter(...v: any[]) { return this.next({ start: { values: v, before: false } }); }
  startAt(...v: any[]) { return this.next({ start: { values: v, before: true } }); }
  endBefore(...v: any[]) { return this.next({ end: { values: v, before: true } }); }
  endAt(...v: any[]) { return this.next({ end: { values: v, before: false } }); }
  withConverter(c: any) { return new Query(this.db, this.state, c); }
  count() { return new AggregateQuery(this.next({ select: undefined })); }
  async get(): Promise<QuerySnap> { return this.db.querySnapshot(this); }
  onSnapshot(next: (s: QuerySnap) => void, error?: (e: any) => void) { return this.db.listen({ query: this }, next, error); }
  isEqual(o: Query) { return JSON.stringify(o.state) === JSON.stringify(this.state); }
}

// count() returns a class instance with get() on its prototype, like the SDK, so callers and tests treat both alike.
export class AggregateQuery {
  constructor(public query: Query) {}
  async get() { return new AggregateSnap(this, this.query.db.runQuery(this.query, false).length, this.query.db.now()); }
}
class AggregateSnap {
  constructor(public query: AggregateQuery, private count: number, public readTime: Timestamp) {}
  data() { return { count: this.count }; }
}

export class CollRef extends Query {
  constructor(db: SqliteFirestore, public path: string, converter: any = null) {
    super(db, { parent: path, group: null, wheres: [], orders: [] }, converter);
  }
  get id() { return this.path.split('/').pop()!; }
  get parent() { const s = this.path.split('/'); return s.length > 1 ? new DocRef(this.db, s.slice(0, -1).join('/'), null) : null; }
  doc(id?: string) { return new DocRef(this.db, `${this.path}/${id ?? autoId()}`, this.converter); }
  async add(data: any) { const ref = this.doc(); await ref.create(data); return ref; }
  async listDocuments() { return this.db.listChildren(this.path).map(p => new DocRef(this.db, p, this.converter)); }
  override withConverter(c: any): any { return new CollRef(this.db, this.path, c); }
}

export class DocRef {
  // firestore.ts recognizes stored references by this brand without importing this module.
  constructor(public db: SqliteFirestore, public path: string, public converter: any = null) {
    if (path.split('/').length % 2 !== 0) throw new Error(`Invalid document path ${path}`);
  }
  get firestore() { return this.db; }
  get id() { return this.path.split('/').pop()!; }
  get parent() { return new CollRef(this.db, this.path.split('/').slice(0, -1).join('/'), this.converter); }
  collection(id: string) { return new CollRef(this.db, `${this.path}/${id}`); }
  async listCollections() { return this.db.listSubcollections(this.path).map(p => new CollRef(this.db, p)); }
  withConverter(c: any): any { return new DocRef(this.db, this.path, c); }
  isEqual(o: DocRef) { return o?.path === this.path; }
  async get() { return this.db.readDoc(this); }
  // Like the SDK, invalid data throws synchronously, before any promise.
  set(data: any, opts?: any) { return this.db.commit([checked({ kind: 'set', ref: this, data, opts })]); }
  create(data: any) { return this.db.commit([checked({ kind: 'create', ref: this, data })]); }
  update(data: any, ...rest: any[]) { return this.db.commit([checked({ kind: 'update', ref: this, data: normalizeUpdate(data, rest) })]); }
  async delete(pre?: any) { return this.db.commit([{ kind: 'delete', ref: this, pre }]); }
  onSnapshot(next: (s: DocSnap) => void, error?: (e: any) => void) { return this.db.listen({ doc: this }, next as any, error); }
}

// Firestore refuses undefined anywhere in written data (the server does not set ignoreUndefinedProperties),
// synchronously, before anything is sent; dropping it here would hide a bug that fails in production.
// The SDK likewise refuses a FieldValue sentinel anywhere inside an array.
function assertStorable(value: any, field: string, inArray = false) {
  if (value === undefined) throw new Error(`Cannot use "undefined" as a Firestore value${field ? ` (found in field "${field}")` : ''}.`);
  const kind = transformKind(value);
  if (kind && inArray) throw new Error(`${kind}() cannot be used inside of an array${field ? ` (found in field "${field}")` : ''}.`);
  // Elements of arrayUnion/arrayRemove are array members too.
  if (kind === 'FieldValue.arrayUnion' || kind === 'FieldValue.arrayRemove') for (const v of value.elements ?? value._elements) assertStorable(v, field, true);
  if (Array.isArray(value)) for (const v of value) assertStorable(v, field, true);
  else if (value && typeof value === 'object' && !kind && !(value instanceof Timestamp) && !Buffer.isBuffer(value)
    && !(value instanceof Uint8Array) && !(value instanceof DocRef) && !(value instanceof Date) && !(value instanceof FieldPath))
    for (const [k, v] of Object.entries(value)) assertStorable(v, field ? `${field}.${k}` : k, inArray);
}
function checked(w: Write): Write {
  if (w.kind === 'update') for (const [p, v] of (w.data as any).pairs) assertStorable(v, p.join('.'));
  else if (w.kind !== 'delete') assertStorable(w.ref.converter ? w.ref.converter.toFirestore(w.data, w.opts) : w.data, '');
  return w;
}
function normalizeUpdate(data: any, rest: any[]): Map<string[], any> | { pairs: [string[], any][]; pre?: any } {
  const pairs: [string[], any][] = [];
  let pre: any;
  if (typeof data === 'string' || data instanceof FieldPath) {
    const args = [data, ...rest];
    if (args.length % 2 === 1) pre = args.pop();
    for (let i = 0; i < args.length; i += 2) pairs.push([splitFieldPath(args[i]), args[i + 1]]);
  } else {
    for (const [k, v] of Object.entries(data)) pairs.push([k.split('.'), v]);
    pre = rest[0];
  }
  return { pairs, pre };
}

type Write = { kind: 'set' | 'create' | 'update' | 'delete'; ref: DocRef; data?: any; opts?: any; pre?: any };

const AUTO_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function autoId() { const b = randomBytes(20); let s = ''; for (const x of b) s += AUTO_ID[x % 62]; return s; }

// ---- database -------------------------------------------------------------
type Listener = { target: { query?: Query; doc?: DocRef }; next: (s: any) => void; error?: (e: any) => void; previous: Map<string, DocSnap> | null; live: boolean; scheduled: boolean };

const COMMIT_CLOCK = 1, LEGACY_READ_LEASE = 2, READ_LEASE_US = 1_000_000, EXTERNAL_WRITE_POLL_MS = 200;

export class SqliteFirestore {
  private sql: DatabaseSync;
  private lastUs = 0;
  private listeners = new Set<Listener>();
  private snapshots = new Set<Snapshot>();
  private closed = false;
  private readonly shared: boolean;
  constructor(file = ':memory:') {
    this.shared = file !== ':memory:';
    this.sql = new DatabaseSync(file);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, parent TEXT NOT NULL, coll TEXT NOT NULL,
        data TEXT NOT NULL, create_us INTEGER NOT NULL, update_us INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent); CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
      CREATE INDEX IF NOT EXISTS docs_parent_project ON docs(parent, json_extract(data, '$.projectId'));
      CREATE INDEX IF NOT EXISTS docs_coll_project ON docs(coll, json_extract(data, '$.projectId'));
      CREATE INDEX IF NOT EXISTS docs_parent_status ON docs(parent, json_extract(data, '$.status'));
      CREATE INDEX IF NOT EXISTS docs_coll_status ON docs(coll, json_extract(data, '$.status'));
      CREATE INDEX IF NOT EXISTS docs_parent_tagged ON docs(parent) WHERE instr(data, '"__k42":"map"') > 0;
      CREATE INDEX IF NOT EXISTS docs_coll_tagged ON docs(coll) WHERE instr(data, '"__k42":"map"') > 0;
      CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK (id IN (1, 2)), last_us INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS read_leases (conn TEXT PRIMARY KEY, last_us INTEGER NOT NULL);`);
    // Resume after the latest time this file has recorded or any connection has leased to readers, so a reopen
    // never hands out times below a persisted update time or a read time a client may hold as a cursor, even if
    // the system clock moved backward. Files written before the clock table existed fall back to their newest
    // document; clock row 2 is the shared lease older versions wrote.
    const docs = this.sql.prepare('SELECT coalesce(max(max(create_us), max(update_us)), 0) AS us FROM docs').get() as { us: number };
    const leased = this.sql.prepare('SELECT coalesce(max(last_us), 0) AS us FROM read_leases').get() as { us: number };
    this.lastUs = Math.max(this.persistedUs(), this.persistedUs(LEGACY_READ_LEASE), Number(leased.us), Number(docs.us));
    // A lease at or below the commit clock bounds nothing more: its connection closed uncleanly or will raise it again.
    try {
      this.sql.prepare('DELETE FROM read_leases WHERE last_us <= ?').run(this.persistedUs());
      this.sql.prepare('DELETE FROM clock WHERE id = ? AND last_us <= ?').run(LEGACY_READ_LEASE, this.persistedUs());
    } catch { /* read-only file */ }
  }
  // Row 1 is the latest commit time, or the latest time a cleanly closed connection handed out.
  private persistedUs(id = COMMIT_CLOCK): number {
    const row = this.sql.prepare('SELECT last_us FROM clock WHERE id = ?').get(id) as { last_us: number } | undefined;
    return row ? Number(row.last_us) : 0;
  }
  // Each connection leases read times in its own row (see now()), so closing one never lowers another's bound.
  private readonly conn = randomBytes(12).toString('base64url');
  private ownLeaseUs(): number {
    const row = this.sql.prepare('SELECT last_us FROM read_leases WHERE conn = ?').get(this.conn) as { last_us: number } | undefined;
    return row ? Number(row.last_us) : 0;
  }
  private readLeaseUs = 0;
  // Strictly monotonic microsecond clock: every commit gets a unique, increasing update time. Called inside
  // the commit's write transaction, it also stays ahead of commits by another connection to the same file.
  // It does not stay ahead of read times another live connection leased: if the system clock moves backward
  // while two connections are open, a commit here can sort below a read time handed out there. Waiting out
  // other leases would push every commit up to a lease ahead, so the guarantee is for one live connection per
  // file. The standalone engine holds an exclusive lock on its file (self-hosted-lock.ts), and tests that
  // share a file across processes do not move the clock backward.
  tickUs() {
    this.lastUs = Math.max(Date.now() * 1000, this.lastUs + 1, this.persistedUs() + 1);
    this.sql.prepare('INSERT INTO clock(id, last_us) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_us = excluded.last_us').run(this.lastUs);
    return this.lastUs;
  }
  // A read time is reserved on the same clock, so every later commit is strictly after it (Date.now() only has
  // millisecond resolution: without this, a commit in the same millisecond could share an earlier read's time).
  // Read times are made durable through a lease: before handing out a time past the persisted bound, the bound
  // moves one lease ahead, so the file is written at most about once per lease rather than on every read.
  now() {
    this.lastUs = Math.max(Date.now() * 1000, this.lastUs);
    if (this.lastUs > this.readLeaseUs) {
      this.readLeaseUs = this.lastUs + READ_LEASE_US;
      this.sql.prepare('INSERT INTO read_leases(conn, last_us) VALUES (?, ?) ON CONFLICT(conn) DO UPDATE SET last_us = excluded.last_us').run(this.conn, this.readLeaseUs);
    }
    return usToTs(this.lastUs);
  }
  collection(path: string) { return new CollRef(this, path); }
  doc(path: string) { return new DocRef(this, path); }
  collectionGroup(id: string) { return new Query(this, { parent: null, group: id, wheres: [], orders: [] }); }
  batch() { return new Batch(this); }
  async getAll(...args: any[]) { const fields = readMask(args); return args.filter(a => a instanceof DocRef).map(r => masked(this.readDocSync(r), fields)); }
  async listCollections() { return this.listSubcollections('').map(p => new CollRef(this, p)); }
  async recursiveDelete(ref: DocRef | CollRef) {
    const prefix = ref.path + '/';
    const paths = (this.sql.prepare('SELECT path FROM docs WHERE path = ? OR substr(path, 1, ?) = ?').all(ref.path, prefix.length, prefix) as any[]).map(r => r.path);
    await this.commit(paths.map(p => ({ kind: 'delete', ref: this.doc(p) })));
  }
  // Stops listeners and closes the file; the store is unusable afterwards. Every time this connection handed out
  // is at most lastUs, so a clean close records lastUs and gives back only its own unused lease: the next open
  // resumes at lastUs rather than up to a lease ahead of the system clock, and other connections' leases stay.
  close() {
    for (const l of this.listeners) l.live = false; this.listeners.clear();
    this.stopWatchingFile();
    if (this.closed) return;
    this.closed = true;
    // If the file cannot be written, the lease stays: safe, only further ahead on the next open.
    try {
      this.sql.exec('BEGIN IMMEDIATE');
      this.sql.prepare('INSERT INTO clock(id, last_us) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_us = max(last_us, excluded.last_us)').run(COMMIT_CLOCK, this.lastUs);
      this.sql.prepare('DELETE FROM read_leases WHERE conn = ?').run(this.conn);
      this.sql.exec('COMMIT');
    } catch { try { this.sql.exec('ROLLBACK'); } catch { /* not in a transaction */ } }
    this.sql.close();
  }
  async terminate() { this.close(); }
  settings() {}
  // Test helper: like an emulator reset, open listeners observe the removals before the next write.
  reset() { this.sql.exec('DELETE FROM docs'); for (const l of this.listeners) this.deliver(l); }

  listChildren(parent: string) { return (this.sql.prepare('SELECT path FROM docs WHERE parent = ?').all(parent) as any[]).map(r => r.path); }
  listSubcollections(docPath: string) {
    const prefix = docPath ? docPath + '/' : '';
    const rows = this.sql.prepare('SELECT DISTINCT parent FROM docs WHERE substr(parent, 1, ?) = ?').all(prefix.length, prefix) as any[];
    const out = new Set<string>();
    for (const r of rows) { const rest = r.parent.slice(prefix.length).split('/'); out.add(prefix + rest[0]); }
    return [...out];
  }

  row(path: string): Row | undefined { return this.sql.prepare('SELECT * FROM docs WHERE path = ?').get(path) as any; }
  snapFromRow(ref: DocRef, row: Row | undefined, readTime: Timestamp, fields?: string[]) {
    return row ? new DocSnap(ref, decode(JSON.parse(row.data), this), usToTs(row.create_us), usToTs(row.update_us), readTime, fields)
      : new DocSnap(ref, undefined, undefined, undefined, readTime);
  }
  readDocSync(ref: DocRef, at?: Snapshot) {
    return at ? this.snapFromRow(ref, at.before.has(ref.path) ? at.before.get(ref.path) ?? undefined : this.row(ref.path), at.readTime)
      : this.snapFromRow(ref, this.row(ref.path), this.now());
  }
  async readDoc(ref: DocRef) { return this.readDocSync(ref); }

  runQuery(q: Query, project = true, at?: Snapshot): DocSnap[] {
    const s = q.state, readTime = at?.readTime ?? this.now();
    const pre = sqlPrefilter(s.wheres), scope = s.group ? 'coll' : 'parent', scopeKey = s.group ?? s.parent;
    // Two halves so each can use an index: an OR with the wrapped-map guard would force a scan of the whole scope.
    let rows = (pre.conds
      ? this.sql.prepare(`SELECT * FROM docs WHERE ${scope} = ? AND ${pre.conds} UNION SELECT * FROM docs WHERE ${scope} = ? AND ${TAGGED_MAP}`).all(scopeKey, ...pre.params, scopeKey)
      : this.sql.prepare(`SELECT * FROM docs WHERE ${scope} = ?`).all(scopeKey)) as Row[];
    if (at?.before.size) {
      // Rewind documents committed since the snapshot began to their pre-images.
      const inScope = (row: Row) => s.group ? row.coll === s.group : row.parent === s.parent;
      const current = new Map(rows.map(row => [row.path, row]));
      for (const [path, row] of at.before) { current.delete(path); if (row && inScope(row)) current.set(path, row); }
      rows = [...current.values()];
    }
    // Firestore implicit ordering: inequality field first, then document name.
    const orders = [...s.orders];
    const inequality = findInequality(s.wheres);
    if (inequality && !orders.length) orders.push({ field: inequality, dir: 'asc' });
    if (!orders.some(o => o.field === DOC_ID)) orders.push({ field: DOC_ID, dir: orders.length ? orders[orders.length - 1].dir : 'asc' });
    let docs = rows.map(r => ({ path: r.path as string, data: decode(JSON.parse(r.data), this), row: r as Row }))
      .filter(d => s.wheres.every(w => matches(d.path, d.data, w, this)))
      .filter(d => orders.every(o => o.field === DOC_ID || getField(d.data, o.field).found));
    const key = (d: { path: string; data: Data }, o: Order) => o.field === DOC_ID ? new DocRef(this, d.path) : getField(d.data, o.field).value;
    docs.sort((a, b) => { for (const o of orders) { const c = compare(key(a, o), key(b, o)); if (c) return o.dir === 'desc' ? -c : c; } return 0; });
    const cursorValues = (c: { values: any[] }) => {
      if (c.values.length === 1 && c.values[0] instanceof DocSnap) {
        const snap = c.values[0] as DocSnap;
        return orders.map(o => o.field === DOC_ID ? snap.ref : snap.get(o.field));
      }
      return c.values.map((v, i) => orders[i]?.field === DOC_ID && typeof v === 'string' ? new DocRef(this, v.includes('/') ? v : `${s.parent}/${v}`) : v);
    };
    const cmpCursor = (d: any, values: any[]) => { for (let i = 0; i < values.length; i++) { const o = orders[i]; const c = compare(key(d, o), values[i]); if (c) return o.dir === 'desc' ? -c : c; } return 0; };
    if (s.start) { const v = cursorValues(s.start); docs = docs.filter(d => { const c = cmpCursor(d, v); return s.start!.before ? c >= 0 : c > 0; }); }
    if (s.end) { const v = cursorValues(s.end); docs = docs.filter(d => { const c = cmpCursor(d, v); return s.end!.before ? c < 0 : c <= 0; }); }
    if (s.offset) docs = docs.slice(s.offset);
    if (s.limit !== undefined) docs = s.limitToLast ? docs.slice(-s.limit) : docs.slice(0, s.limit);
    const conv = q.converter;
    return docs.map(d => this.snapFromRow(new DocRef(this, d.path, conv), d.row, readTime, project ? s.select : undefined));
  }
  async querySnapshot(q: Query) { return new QuerySnap(q, this.runQuery(q), this.now()); }

  // ---- writes / transactions ----
  async commit(writes: Write[]) { return this.applyWrites(writes); }
  applyWrites(writes: Write[]) {
    const results: any[] = [];
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const us = this.tickUs(), now = usToTs(us);
      for (const w of writes) {
        const path = w.ref.path, existing = this.row(path);
        for (const snapshot of this.snapshots) if (!snapshot.before.has(path)) snapshot.before.set(path, existing ?? null);
        const pre = w.kind === 'update' ? w.data.pre : w.pre;
        if (pre?.lastUpdateTime && (!existing || compare(usToTs(existing.update_us), pre.lastUpdateTime) !== 0)) throw new StoreError(9, `Precondition failed for ${path}`);
        if (pre?.exists === true && !existing) throw new StoreError(5, `No document to update: ${path}`);
        if (w.kind === 'delete') { this.sql.prepare('DELETE FROM docs WHERE path = ?').run(path); results.push({ writeTime: now }); continue; }
        let data: Data;
        const prev = existing ? decode(JSON.parse(existing.data), this) : undefined;
        const conv = w.ref.converter;
        if (w.kind === 'create') {
          if (existing) throw new StoreError(6, `Document already exists: ${path}`);
          data = resolveTransforms(conv ? conv.toFirestore(w.data) : w.data, undefined, now);
        } else if (w.kind === 'set') {
          const input = conv ? conv.toFirestore(w.data, w.opts) : w.data;
          if (w.opts?.merge) { data = prev ? decodeLoose(prev) : {}; mergeInto(data, input, now); }
          else if (w.opts?.mergeFields) { data = prev ? decodeLoose(prev) : {}; for (const f of w.opts.mergeFields) { const r = getField(input, fieldName(f)); setPath(data, splitFieldPath(f), r.found ? r.value : FieldValue.delete(), now); } }
          else data = resolveTransforms(input, prev, now);
        } else {
          if (!existing) throw new StoreError(5, `No document to update: ${path}`);
          data = decodeLoose(prev);
          for (const [p, v] of (w.data as any).pairs) setPath(data, p, v, now);
        }
        const json = JSON.stringify(encode(data));
        // Firestore treats rewriting identical data as a no-op: updateTime stays put.
        if (existing && existing.data === json) { results.push({ writeTime: usToTs(existing.update_us) }); continue; }
        const segs = path.split('/');
        this.sql.prepare(`INSERT INTO docs(path,parent,coll,data,create_us,update_us) VALUES(?,?,?,?,?,?)
          ON CONFLICT(path) DO UPDATE SET data=excluded.data, update_us=excluded.update_us`)
          .run(path, segs.slice(0, -1).join('/'), segs[segs.length - 2], json, existing?.create_us ?? us, us);
        results.push({ writeTime: now });
      }
      this.sql.exec('COMMIT');
    } catch (error) {
      this.sql.exec('ROLLBACK');
      // A lease written inside the rolled-back transaction is gone; take the bound from the file again.
      this.readLeaseUs = this.ownLeaseUs();
      throw error;
    }
    this.notify(writes.map(w => w.ref.path));
    return writes.length === 1 ? results[0] : results;
  }

  // Optimistic first attempt: record read versions, validate synchronously at commit.
  // On conflict, retries queue behind one FIFO lock so hot documents make progress
  // (Firestore serializes these with server-side locks). Nested transactions skip the
  // lock to avoid self-deadlock.
  private retryQueue: Promise<void> = Promise.resolve();
  private inRetry = new AsyncLocalStorage<boolean>();
  async runTransaction<T>(fn: (tx: Tx) => Promise<T>, opts?: { maxAttempts?: number; readOnly?: boolean }): Promise<T> {
    // Like the SDK, a callback that throws ABORTED (code 10) runs again, up to maxAttempts in all.
    const maxAttempts = opts?.maxAttempts ?? 5;
    let aborts = 0;
    const call = async (tx: Tx) => {
      try { return { ok: true as const, result: await fn(tx) }; }
      catch (error) { if (isAborted(error) && ++aborts < maxAttempts) return { ok: false as const }; throw error; }
    };
    // A read-only transaction reads one consistent snapshot and never conflicts, so it only retries on ABORTED.
    if (opts?.readOnly) {
      for (;;) {
        const snapshot: Snapshot = { before: new Map(), readTime: this.now() };
        this.snapshots.add(snapshot);
        const tx = new Tx(this, snapshot);
        try { const r = await call(tx); if (r.ok) return r.result; }
        finally { tx.closed = true; this.snapshots.delete(snapshot); }
      }
    }
    const attempt = async () => {
      const tx = new Tx(this);
      try {
        const called = await call(tx);
        if (!called.ok) return called;
        const result = called.result;
        if (!tx.validate()) return { ok: false as const };
        if (tx.writes.length) this.applyWrites(tx.writes);
        return { ok: true as const, result };
      } finally { tx.closed = true; }
    };
    const first = await attempt();
    if (first.ok) return first.result;
    if (this.inRetry.getStore()) {
      for (let i = 1; i < (opts?.maxAttempts ?? 5); i++) { const r = await attempt(); if (r.ok) return r.result; }
      throw new StoreError(10, 'Transaction contention; too many retries.');
    }
    let release!: () => void;
    const previous = this.retryQueue;
    this.retryQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await this.inRetry.run(true, async () => {
        for (let i = 0; i < 20; i++) { const r = await attempt(); if (r.ok) return r.result; }
        throw new StoreError(10, 'Transaction contention; too many retries.');
      });
    } finally { release(); }
  }

  // ---- listeners (in-process change feed) ----
  listen(target: Listener['target'], next: (s: any) => void, error?: (e: any) => void) {
    const l: Listener = { target, next, error, previous: null, live: true, scheduled: false };
    this.listeners.add(l);
    this.schedule(l);
    this.watchFile();
    return () => { l.live = false; this.listeners.delete(l); if (!this.listeners.size) this.stopWatchingFile(); };
  }
  // Commits through this connection notify listeners directly. Another connection to the same file (a test
  // harness writing beside the engine, or an operator tool) is seen through SQLite's data_version, which changes
  // only when some other connection commits; every listener then re-runs and reports only what really changed.
  private fileWatch: NodeJS.Timeout | undefined;
  private dataVersion = 0;
  private watchFile() {
    if (!this.shared || this.fileWatch || this.closed) return;
    this.dataVersion = this.readDataVersion();
    this.fileWatch = setInterval(() => {
      if (this.closed) return this.stopWatchingFile();
      // A throw here would be uncaught and end the process; a transient busy or I/O error just waits for the next tick.
      let version: number;
      try { version = this.readDataVersion(); } catch { return; }
      if (version === this.dataVersion) return;
      this.dataVersion = version;
      for (const l of this.listeners) this.schedule(l);
    }, EXTERNAL_WRITE_POLL_MS);
    this.fileWatch.unref();
  }
  private stopWatchingFile() { if (this.fileWatch) { clearInterval(this.fileWatch); this.fileWatch = undefined; } }
  private readDataVersion(): number {
    return Number((this.sql.prepare('PRAGMA data_version').get() as { data_version: number }).data_version);
  }
  // Re-runs only listeners whose document, collection or collection group was written: a query costs a scan of
  // its whole collection, so re-running every listener on every commit grows with everything being watched.
  private notify(paths: string[]) {
    const docs = new Set(paths), parents = new Set<string>(), groups = new Set<string>();
    for (const path of paths) { const segs = path.split('/'); parents.add(segs.slice(0, -1).join('/')); groups.add(segs[segs.length - 2]); }
    for (const l of this.listeners) {
      const { doc, query } = l.target, s = query?.state;
      if (doc ? docs.has(doc.path) : s!.group ? groups.has(s!.group) : parents.has(s!.parent!)) this.schedule(l);
    }
  }
  private schedule(l: Listener) {
    if (l.scheduled) return;
    l.scheduled = true;
    // Every store call settles on microtasks alone, so a macrotask here would let a chain of awaited writes
    // run ahead of its listeners; Firestore's network round trips always give them a turn.
    queueMicrotask(() => { l.scheduled = false; this.deliver(l); });
  }
  private deliver(l: Listener) {
    if (!l.live) return;
    {
      try {
        const readTime = this.now();
        const docs = l.target.doc ? [this.readDocSync(l.target.doc)] : this.runQuery(l.target.query!);
        const current = new Map(docs.filter(d => d.exists).map(d => [d.ref.path, d]));
        const prev = l.previous;
        const changed = !prev || prev.size !== current.size || [...current].some(([p, d]) => !prev.get(p) || compare(prev.get(p)!.updateTime, d.updateTime) !== 0);
        if (!changed) return;
        const changes: any[] = [];
        if (prev) {
          for (const [p, d] of prev) if (!current.has(p)) changes.push({ type: 'removed', doc: d, oldIndex: 0, newIndex: -1 });
          docs.forEach((d, i) => { const o = prev.get(d.ref.path); if (!o) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i }); else if (compare(o.updateTime, d.updateTime) !== 0) changes.push({ type: 'modified', doc: d, oldIndex: 0, newIndex: i }); });
        } else docs.forEach((d, i) => d.exists && changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i }));
        l.previous = current;
        l.next(l.target.doc ? docs[0] : new QuerySnap(l.target.query!, docs, readTime, changes));
      } catch (e) { l.error?.(e); }
    }
  }
}
function usToTs(us: number) { return new Timestamp(Math.floor(us / 1e6), (us % 1e6) * 1000); }

function findInequality(ws: Where[]): string | undefined {
  for (const w of ws) {
    if (w.kind === 'composite') { const f = findInequality(w.filters); if (f) return f; }
    else if (['<', '<=', '>', '>=', '!=', 'not-in'].includes(w.op)) return w.field;
  }
  return undefined;
}
// Narrows the rows a query decodes: top-level == / in filters on string values become SQL conditions.
// It only ever keeps a superset (matches() still decides), so rows whose stored JSON could hide a field
// from a plain JSON path (a wrapped tag-shaped map) are always kept.
const PLAIN_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAGGED_MAP = `instr(data, '"${TAG}":"map"') > 0`;
// SQLite and the parameter binding read a lone UTF-16 surrogate differently, so SQL could drop a row JS would match.
const sqlSafe = (v: unknown): v is string => typeof v === 'string' && !/\p{Cs}/u.test(v);
// The path is written into the SQL, not bound, so an expression index on that exact path can serve the query;
// PLAIN_SEGMENT admits only identifier segments, so it cannot carry quotes or other SQL.
function sqlPrefilter(ws: Where[]): { conds: string; params: string[] } {
  const conds: string[] = [], params: string[] = [];
  for (const w of ws) {
    if (w.kind !== 'field' || w.field === DOC_ID || !w.field.split('.').every(seg => PLAIN_SEGMENT.test(seg))) continue;
    if (w.op === '==' && sqlSafe(w.value)) { conds.push(`json_extract(data, '$.${w.field}') = ?`); params.push(w.value); }
    else if (w.op === 'in' && Array.isArray(w.value) && w.value.length && w.value.every(sqlSafe)) {
      conds.push(`json_extract(data, '$.${w.field}') IN (${w.value.map(() => '?').join(', ')})`); params.push(...w.value);
    }
  }
  return { conds: conds.length ? `(${conds.join(' AND ')})` : '', params };
}
function matches(path: string, data: Data, w: Where, db: SqliteFirestore): boolean {
  if (w.kind === 'composite') return w.op === 'AND' ? w.filters.every(f => matches(path, data, f, db)) : w.filters.some(f => matches(path, data, f, db));
  let found: boolean, v: any;
  let target = w.value;
  if (w.field === DOC_ID) {
    found = true; v = new DocRef(db, path);
    const asRef = (x: any) => x instanceof DocRef ? x : typeof x === 'string' ? new DocRef(db, x.includes('/') ? x : `${path.split('/').slice(0, -1).join('/')}/${x}`) : x;
    target = Array.isArray(target) && (w.op === 'in' || w.op === 'not-in') ? target.map(asRef) : asRef(target);
  } else ({ found, value: v } = getField(data, w.field));
  if (!found) return false;
  // As in Firestore, ranges compare values of one type only, and NaN satisfies no range (only == NaN).
  const ranged = typeRank(v) === typeRank(target) && !Number.isNaN(v) && !Number.isNaN(target);
  switch (w.op) {
    case '==': return equal(v, target);
    case '!=': return v !== null && !equal(v, target);
    case '<': return ranged && compare(v, target) < 0;
    case '<=': return ranged && compare(v, target) <= 0;
    case '>': return ranged && compare(v, target) > 0;
    case '>=': return ranged && compare(v, target) >= 0;
    // As in Firestore, null inside an in-list matches nothing.
    case 'in': return (target as any[]).some(t => t !== null && equal(v, t));
    case 'not-in': return v !== null && !(target as any[]).some(t => equal(v, t));
    case 'array-contains': return Array.isArray(v) && v.some(x => equal(x, target));
    case 'array-contains-any': return Array.isArray(v) && v.some(x => (target as any[]).some(t => equal(x, t)));
    default: throw new Error(`Unsupported operator ${w.op}`);
  }
}

class Tx {
  writes: Write[] = [];
  closed = false;
  private docReads = new Map<string, number | null>();
  private queryReads: { q: Query; fingerprint: string }[] = [];
  constructor(private db: SqliteFirestore, private snapshot?: Snapshot) {}
  private assertOpen() { if (this.closed) throw new StoreError(3, 'Transaction is invalid or closed'); }
  private assertWritable() {
    this.assertOpen();
    if (this.snapshot) throw new StoreError(3, 'Firestore read-only transactions cannot execute writes.');
  }
  private fingerprint(docs: DocSnap[]) { return docs.map(d => `${d.ref.path}@${d.updateTime?.toMillis()}:${d.updateTime?.nanoseconds}`).join('|'); }
  async get(target: any): Promise<any> {
    this.assertOpen();
    if (this.writes.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
    if (this.snapshot) return this.readAt(target, this.snapshot);
    if (target instanceof DocRef) return this.readDoc(target);
    if (target instanceof Query) {
      const docs = this.db.runQuery(target);
      this.queryReads.push({ q: target, fingerprint: this.fingerprint(this.db.runQuery(target.select())) });
      for (const d of docs) if (!this.docReads.has(d.ref.path)) this.docReads.set(d.ref.path, usOf(d.updateTime!));
      return new QuerySnap(target, docs, this.db.now());
    }
    // AggregateQuery from count(): fingerprint the matching documents, not just the number, so a concurrent
    // change to the predicate set aborts the commit (reserveFanoutRound relies on this; see the contract).
    if (target instanceof AggregateQuery) {
      const q = target.query, matched = this.db.runQuery(q.select());
      this.queryReads.push({ q, fingerprint: this.fingerprint(matched) });
      return new AggregateSnap(target, matched.length, this.db.now());
    }
    throw new Error('Unsupported transaction read');
  }
  private readDoc(ref: DocRef) {
    if (this.snapshot) return this.db.readDocSync(ref, this.snapshot);
    const snap = this.db.readDocSync(ref);
    // Only the first read counts: a later re-read must not hide a commit that landed in between.
    if (!this.docReads.has(ref.path)) this.docReads.set(ref.path, snap.exists ? usOf(snap.updateTime!) : null);
    return snap;
  }
  private readAt(target: any, at: Snapshot) {
    if (target instanceof DocRef) return this.db.readDocSync(target, at);
    if (target instanceof Query) return new QuerySnap(target, this.db.runQuery(target, true, at), at.readTime);
    if (target instanceof AggregateQuery) return new AggregateSnap(target, this.db.runQuery(target.query, false, at).length, at.readTime);
    throw new Error('Unsupported transaction read');
  }
  // Reads each document directly rather than through get(), so a wrapper around get() sees one call, as with the SDK.
  async getAll(...args: any[]) {
    this.assertOpen();
    if (this.writes.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
    const fields = readMask(args);
    return args.filter(a => a instanceof DocRef).map(ref => masked(this.readDoc(ref), fields));
  }
  set(ref: DocRef, data: any, opts?: any) { this.assertWritable(); this.writes.push(checked({ kind: 'set', ref, data, opts })); return this; }
  create(ref: DocRef, data: any) { this.assertWritable(); this.writes.push(checked({ kind: 'create', ref, data })); return this; }
  update(ref: DocRef, data: any, ...rest: any[]) { this.assertWritable(); this.writes.push(checked({ kind: 'update', ref, data: normalizeUpdate(data, rest) })); return this; }
  delete(ref: DocRef, pre?: any) { this.assertWritable(); this.writes.push({ kind: 'delete', ref, pre }); return this; }
  // Runs synchronously right before commit, so nothing can interleave between validation and writes.
  validate(): boolean {
    for (const [path, us] of this.docReads) { const row = this.db.row(path); if ((row?.update_us ?? null) !== us) return false; }
    for (const { q, fingerprint } of this.queryReads) if (this.fingerprint(this.db.runQuery(q.select())) !== fingerprint) return false;
    return true;
  }
}
// getAll(...refs, { fieldMask }) returns only the listed fields, as select() does for queries.
function readMask(args: any[]): string[] | undefined {
  const options = args[args.length - 1];
  return options && !(options instanceof DocRef) && Array.isArray(options.fieldMask) ? options.fieldMask.map(fieldName) : undefined;
}
function masked(snap: DocSnap, fields: string[] | undefined): DocSnap {
  return fields && snap.exists ? new DocSnap(snap.ref, snap.rawData(), snap.createTime, snap.updateTime, snap.readTime, fields) : snap;
}
function isAborted(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 10 || code === 'aborted' || code === 'ABORTED';
}
function usOf(t: Timestamp) { return t.seconds * 1e6 + Math.floor(t.nanoseconds / 1000); }

class Batch {
  private writes: Write[] = [];
  constructor(private db: SqliteFirestore) {}
  set(ref: DocRef, data: any, opts?: any) { this.writes.push(checked({ kind: 'set', ref, data, opts })); return this; }
  create(ref: DocRef, data: any) { this.writes.push(checked({ kind: 'create', ref, data })); return this; }
  update(ref: DocRef, data: any, ...rest: any[]) { this.writes.push(checked({ kind: 'update', ref, data: normalizeUpdate(data, rest) })); return this; }
  delete(ref: DocRef, pre?: any) { this.writes.push({ kind: 'delete', ref, pre }); return this; }
  async commit() { const r = this.db.applyWrites(this.writes); return Array.isArray(r) ? r : [r]; }
}
