// This page's sign-in: the MyLittleSwarm engine's own sessions (server-session.ts), bound to the browser.
import { createServerSession } from './server-session';

export const siteSession = createServerSession({
  fetch: (input, init) => fetch(input, init),
  storage: window.localStorage,
  tabStorage: window.sessionStorage,
  nonce: () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  },
  location: window.location,
  replaceUrl: url => window.history.replaceState(window.history.state, '', url),
  navigate: url => window.location.assign(url),
  onStorage: listener => {
    const handle = (event: StorageEvent) => { if (event.storageArea === window.localStorage) listener(event.key); };
    window.addEventListener('storage', handle);
    return () => window.removeEventListener('storage', handle);
  },
});
