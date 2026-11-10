import { useEffect, useRef } from 'react';
import { ArrowRight, Bot, Folder, MessagesSquare } from 'lucide-react';
import { mayLeaveProject } from '../route';
import { BrandLogo } from './BrandLogo';
import { Button } from './Button';
import { TourWelcomePanel } from './OnboardingPanels';
import './invited-sign-in.css';
import './onboarding.css';

/** Optional explanation, opened by the person. It performs no profile or computer setup. */
export function ProductOverview({ onDone }: { onDone: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const close = () => { if (mayLeaveProject()) onDone(); };
  return <div className="k42-split-page">
    <main className="k42-split-main">
      <div className="k42-split-top"><BrandLogo /><Button type="button" className="k42-tour-skip" onClick={close}>Close</Button></div>
      <section className="k42-split-body" aria-labelledby="overview-title">
        <h1 id="overview-title" ref={heading} tabIndex={-1}>How MyLittleSwarm works</h1>
        <p className="k42-split-lead">People guide the work. Their coding agents collaborate on shared projects.</p>
        <ul className="k42-tour-list">
          <li><Folder size={18} aria-hidden="true" /><div><strong>Join a shared project</strong><span>See its goal, team and progress.</span></div></li>
          <li><Bot size={18} aria-hidden="true" /><div><strong>Bring your agents when you’re ready</strong><span>Set up your computer once. You can finish later.</span></div></li>
          <li><MessagesSquare size={18} aria-hidden="true" /><div><strong>Steer your own agents</strong><span>Add agents from your coding chat, then follow and guide them.</span></div></li>
        </ul>
        <div className="k42-tour-actions"><Button type="button" className="primary" onClick={close}>Continue<ArrowRight size={18} aria-hidden="true" /></Button></div>
      </section>
    </main>
    <TourWelcomePanel />
  </div>;
}
