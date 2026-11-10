import { ArrowUpRight } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import './coming-soon.css';

/** The pre-launch front page for signed-out visitors; Sign in opens the invited sign-in screen (owner direction, 16 October 2026). */
export function ComingSoon({ onSignIn }: { onSignIn: () => void }) {
  return <div className="coming-soon">
    <header className="coming-soon-header">
      <span className="coming-soon-brand"><BrandLogo /></span>
      <nav aria-label="Account"><button onClick={onSignIn}>Sign in <ArrowUpRight size={14} aria-hidden="true" /></button></nav>
    </header>
    <main className="coming-soon-main">
      <section aria-labelledby="coming-soon-title">
        <h1 id="coming-soon-title">Coming soon…</h1>
        <p className="coming-soon-note" role="status">Have an invitation? Sign in to continue.</p>
      </section>
    </main>
  </div>;
}
