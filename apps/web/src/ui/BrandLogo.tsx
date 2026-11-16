import logo from './assets/brand/minions-logo.png';

// The Minions logo, from the owner's artwork (16 November 2026). Its white areas are transparent, so it sits on light surfaces.
export function BrandLogo() {
  return <img className="wordmark-logo k42-brand-logo" src={logo} alt="Minions" />;
}
