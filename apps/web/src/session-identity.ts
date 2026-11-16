// The local owner as the web app uses them: a stable account ID, the profile fields shown in the UI and a
// bearer token for the service. The Minions engine issues the session (src/server-session.ts).
export type SessionUser = {
  /** The owner account ID the engine issued; the server's `subject`. */
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** A current bearer token for the service; `forceRefresh` asks the engine for a new one. */
  getIdToken(forceRefresh?: boolean): Promise<string>;
};

// The one module that talks to the engine's session (server-session.ts, created in site-session.ts).
export type SessionClient = {
  currentUser(): SessionUser | null;
  /** The signed-in account ID at the moment of the call; requests use it to refuse a changed account. */
  currentUid(): string | undefined;
  /** The session opening or ending. Returns the unsubscribe function. */
  onUserChanged(listener: (user: SessionUser | null) => void): () => void;
  /** Every new token, so access can be rechecked. */
  onTokenChanged(listener: (user: SessionUser | null) => void): () => void;
};
