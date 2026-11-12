import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import type {
  Firestore,
  DocumentData,
  CollectionReference,
  DocumentReference,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { readProjectRecord, type ProjectRecord } from './projects/schema.js';
import { deploymentKind } from './deployment.js';
import type { AgentPersona } from '@mlswarm/contracts';

// The only module that imports firebase-admin/firestore: server code takes the database API from here. The engine
// stores documents in SQLite (storage/sqlite-firestore.ts), which implements this API; firebase-admin supplies the
// types and value classes (Timestamp, FieldPath, FieldValue, Filter) only and never connects anywhere
// (guarded by test/firestore-seam.test.ts).
export {
  DocumentReference, DocumentSnapshot, FieldPath, FieldValue, Filter, Query, QueryDocumentSnapshot,
  QuerySnapshot, Timestamp, Transaction,
} from 'firebase-admin/firestore';
export type { DocumentData } from 'firebase-admin/firestore';

// MyLittleSwarm runs as the self-hosted engine, whose documents live in one local SQLite file. Server tests run as a
// disposable test session (tests/run.mjs) with their own file, or an in-memory store per process.
export async function openDatabase(env: NodeJS.ProcessEnv = process.env): Promise<Firestore> {
  const kind = deploymentKind(env);
  let file: string;
  if (kind === 'self-hosted') {
    file = env.MLSWARM_SQLITE_PATH ?? '';
    if (!isAbsolute(file)) throw new Error('A self-hosted engine needs MLSWARM_SQLITE_PATH: the absolute path of its database file.');
  } else if (kind === 'test') {
    // One file per session lets processes a test starts share its documents; otherwise each process gets its own.
    file = env.MLSWARM_TEST_SQLITE_PATH ?? ':memory:';
    if (file !== ':memory:' && !isAbsolute(file)) throw new Error('MLSWARM_TEST_SQLITE_PATH must be an absolute path.');
  } else {
    throw new Error('MyLittleSwarm runs as the self-hosted engine: set MLSWARM_ENGINE=self-hosted and MLSWARM_SQLITE_PATH (npm run setup does this).');
  }
  const { SqliteFirestore } = await import('./storage/sqlite-firestore.js');
  return new SqliteFirestore(file) as unknown as Firestore;
}
export const db = await openDatabase();

// Brand set by storage/sqlite-firestore.ts on its references, so this check never has to load node:sqlite.
const SQLITE_DOCUMENT_REFERENCE = Symbol.for('mlswarm.sqliteDocumentReference');
/** True for a stored document reference. */
export function isDocumentReference(value: unknown): value is DocumentReference {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SQLITE_DOCUMENT_REFERENCE] === true;
}

export type WithId<T> = T & { id: string };

// Times are Unix milliseconds.
export type Project = {
  name: string;
  mission: string;
  rules: string;
  repoUrl: string;
  startsAt: number;
  // The job's end time, shared by all its workers. Absent until the owner gives the job time.
  endsAt?: number;
  // The job's optional token cap: one pool for all the owner's agents in this job.
  tokenLimit?: { tokens: number };
  paused: boolean;
  pauseRequest?: { revision: number; requestedAt: number };
  started: boolean;
  awaitingKickoff?: boolean;
  completedAt?: number;
};

export type Profile = {
  character?: import('@mlswarm/contracts').PersonCharacter | null;
  // Private account preference: first confirmed tour skip/finish, shared across devices.
  onboardingCompletedAt?: number;
  // MyLittleSwarm invitations this person may have pending or accepted at once. Super admins set it; absent means none.
  mlswarmInvites?: number;
  photoPreparationRevision?: number;
  photo?: { id: string; publicConsent: true; publishedAt: number } | null;
  profile?: { linkedinProfileUrl: string | null; bio?: string };
  profileRevision?: number;
  // From the person's latest GitHub sign-in (identity/server-sessions.ts). Shown on their profile; owners' agents add it to repositories.
  githubUsername?: string;
  name: string;
  email: string;
  removedAt: number | null;
};

// The verified emails GitHub reported at the account's latest sign-in, keyed by GitHub account ID. `firebaseUid`
// is the sign-in subject; the field keeps its stored name so existing databases stay readable.
export type GithubAccount = { firebaseUid: string; login: string; emails: string[]; avatarUrl: string | null; checkedAt: number };

export type Agent = {
  // Exact computer grant that connected this credential; older rows are bound on verified replay/sync.
  computerConnectionId?: string;
  ownerProfileId: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  revokedAt: number | null;
  // Null means registered but never paired; paired connections record the issuance time.
  tokenIssuedAt: number | null;
  // The operator's project membership generation when this connection was made.
  connectionEpoch: number;
  // Plan v2: the times of the agent's recent sends, and of its recent project-wide sends.
  recentSends?: number[];
  recentProjectSends?: number[];
  // How the operator wants this agent to work once connected; absent reads as the default.
  workSettings?: WorkSettings;
  persona?: AgentPersona;
  focus?: import('@mlswarm/contracts').AgentFocus & { runId: string; sequence?: number };
};

export type WorkSettings = { involvement: 'with_me' | 'on_own' };

export function collection<T extends DocumentData>(path: string) {
  const converter: FirestoreDataConverter<T> = {
    toFirestore: (data) => data as DocumentData,
    fromFirestore: (snap: QueryDocumentSnapshot) => snap.data() as T,
  };
  return db.collection(path).withConverter(converter);
}
export function validatedCollection<T extends DocumentData>(path: string, parse: (value: unknown) => T) {
  return db.collection(path).withConverter<T>({ toFirestore: value => parse(value), fromFirestore: snap => parse(snap.data()) });
}

const projectContext = new AsyncLocalStorage<string>();
export function currentProjectId(): string {
  const id = projectContext.getStore();
  if (id === undefined) throw new Error('No project scope.');
  return id;
}
export function inProject<T>(id: string, work: () => T): T {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid project scope.');
  return projectContext.run(id, work);
}
// Every project keeps its records under its own namespace (OPE-33).
const scopedCollections = new Map<string, CollectionReference<DocumentData>>();
export function projectCollection<T extends DocumentData>(path: string) {
  const key = `projects/${currentProjectId()}/${path}`;
  if (!scopedCollections.has(key)) {
    if (scopedCollections.size >= 1000) scopedCollections.delete(scopedCollections.keys().next().value!);
    scopedCollections.set(key, collection<T>(key));
  }
  return scopedCollections.get(key)! as CollectionReference<T>;
}
const documents = new Map<string, DocumentReference<DocumentData>>();
export function projectDocument<T extends DocumentData>(path: string) {
  const key = `projects/${currentProjectId()}/${path}`;
  if (!documents.has(key)) {
    if (documents.size >= 400) documents.delete(documents.keys().next().value!);
    documents.set(key, db.doc(key).withConverter<T>({ toFirestore: value => value as DocumentData, fromFirestore: snap => snap.data() as T }));
  }
  return documents.get(key)! as DocumentReference<T>;
}
const scopedProjects = new Map<string, DocumentReference<ProjectRecord>>();
export function projectDoc() {
  const id = currentProjectId();
  if (!scopedProjects.has(id)) {
    if (scopedProjects.size >= 100) scopedProjects.delete(scopedProjects.keys().next().value!);
    scopedProjects.set(id, validatedCollection<ProjectRecord>('projects', value => readProjectRecord(value)).doc(id));
  }
  return scopedProjects.get(id)!;
}
export const profiles = collection<Profile>('profiles');
export const githubAccounts = collection<GithubAccount>('githubAccounts');
export const agents = () => projectCollection<Agent>('agents');
