import { BrandLogo } from './BrandLogo';
import './coming-soon.css';

/** Restore authentication and admission before showing any entry or onboarding screen. */
export function SessionLoading() {
  return <div className="coming-soon">
    <header className="coming-soon-header"><span className="coming-soon-brand"><BrandLogo /></span></header>
    <main className="coming-soon-main"><p className="coming-soon-note" role="status">Opening MyLittleSwarm…</p></main>
  </div>;
}
