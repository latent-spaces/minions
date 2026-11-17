import { BrandLogo } from './BrandLogo';
import './session-screen.css';

function SessionScreen({ note }: { note: string }) {
  return <div className="session-screen">
    <header className="session-screen-header"><span className="session-screen-brand"><BrandLogo /></span></header>
    <main className="session-screen-main"><p className="session-screen-note" role="status">{note}</p></main>
  </div>;
}

/** Shown while the engine opens this computer's owner session. */
export function SessionLoading() {
  return <SessionScreen note="Opening Minions…" />;
}

/** Shown when the engine refuses or cannot open the owner session. */
export function SessionUnavailable() {
  return <SessionScreen note="Minions could not open. Check that the engine is running on this computer, then reload this page." />;
}
