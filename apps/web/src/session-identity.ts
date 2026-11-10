// The signed-in person as the web app uses them: a stable account ID, the profile fields shown in the UI and a
// bearer token for the service. The MyLittleSwarm engine issues the session (src/server-session.ts).
export type SessionUser = {
  /** The sign-in service's stable account ID; the server's `subject`. */
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** A current bearer token for the service; `forceRefresh` asks the sign-in service for a new one. */
  getIdToken(forceRefresh?: boolean): Promise<string>;
};

// The one module that talks to the engine's sign-in (server-session.ts, created in site-session.ts).
export type SessionClient = {
  currentUser(): SessionUser | null;
  /** The signed-in account ID at the moment of the call; requests use it to refuse a changed account. */
  currentUid(): string | undefined;
  /** Sign-in and sign-out. Returns the unsubscribe function. */
  onUserChanged(listener: (user: SessionUser | null) => void): () => void;
  /** Sign-in, sign-out and every new token, so access can be rechecked after reauthentication. */
  onTokenChanged(listener: (user: SessionUser | null) => void): () => void;
  /** Signs in with GitHub and lets the service confirm the account before resolving. */
  signIn(options?: { chooseAccount?: boolean }): Promise<void>;
  signOut(): Promise<void>;
};
