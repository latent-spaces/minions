import { ArrowLeft, RotateCw } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { Button } from './Button';
import { GitHubIcon } from './GitHubIcon';
import { SignInStory } from './SignInStory';
import { GitHubSignInButton } from './AccountEntryFields';
import './invited-sign-in.css';

export type AccessRefusal = 'not-invited' | 'check-failed';

/** Pre-launch entry for invited people: sign in on the left, what MyLittleSwarm is on the right (design 2026-10-16). */
export function InvitedSignIn({ onSignIn, onChooseAccount, onSignOut, onRetry, onBack, pending, checking, signedInEmail, refused }: {
  onSignIn: () => void; onChooseAccount: () => void; onSignOut: () => void; onRetry: () => void;
  /** Back to Coming soon; only offered before an account is signed in. */
  onBack?: () => void;
  pending: boolean; checking: boolean;
  /** Set when an account is signed in. */
  signedInEmail?: string;
  /** Why a signed-in account cannot continue. */
  refused?: AccessRefusal;
}) {
  const status = pending ? 'Continuing to GitHub…'
    : checking ? 'Checking your invitation…' : '';
  return <div className="k42-split-page">
    <main className="k42-split-main">
      <div className="k42-split-top"><BrandLogo />{onBack && <button type="button" className="k42-split-back" onClick={onBack} disabled={pending}><ArrowLeft size={16} aria-hidden="true" />Back</button>}</div>
      <section className="k42-split-body" aria-labelledby="sign-in-title">
        <span className="k42-tag k42-tone-lilac">You're invited</span>
        <h1 id="sign-in-title">Welcome to MyLittleSwarm</h1>
        <p className="k42-split-lead">MyLittleSwarm is invitation-only for now. Sign in with a GitHub account that has your invited email verified.</p>
        {refused === 'not-invited' ? <div className="k42-sign-in-refused" role="alert">
          <p>This GitHub account{signedInEmail ? ` (${signedInEmail})` : ''} does not have an invitation yet.</p>
          <Button className="primary k42-github-button" onClick={onChooseAccount} disabled={pending}><GitHubIcon size={18} />Use another GitHub account</Button>
          <Button onClick={onSignOut} disabled={pending}>Sign out</Button>
        </div>
        : refused === 'check-failed' ? <div className="k42-sign-in-refused" role="alert">
          <p>Could not check your access.</p>
          <Button className="primary" onClick={onRetry}><RotateCw size={18} aria-hidden="true" />Try again</Button>
          <Button onClick={onSignOut}>Sign out</Button>
        </div>
        : <GitHubSignInButton className="k42-github-button" onClick={onSignIn} disabled={pending || checking} pending={pending} label="Sign in with GitHub" />}
        <p className="k42-split-status" role="status">{status}</p>
        {!refused && <p className="k42-split-note">No invitation yet? Ask the person who told you about MyLittleSwarm to invite you.</p>}
      </section>
    </main>
    <SignInStory />
  </div>;
}
