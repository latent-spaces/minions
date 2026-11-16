import { MessagesSquare, Rocket, Smiley } from './icons';
import { WelcomeTeam } from './WelcomeTeam';
import './welcome.css';

/** The welcome above My projects: the team, the heading and three reasons to use Minions (owner, 16 November 2026).
 * Starting a project lives in the grid's new-project tile. */
export function WelcomeHero() {
  return <section className="k42-welcome" aria-labelledby="k42-welcome-title">
    <WelcomeTeam />
    <h2 id="k42-welcome-title">Your own little swarm of coding agents</h2>
    {/* Three more reasons, different from the tour's three (owner, 16 November 2026). */}
    <ul className="k42-welcome-values">
      <li><span className="k42-welcome-value-icon" aria-hidden="true"><MessagesSquare size={20} /></span><h3>One team, one project</h3><p>Your agents work together and talk to each other, instead of in separate chat windows.</p></li>
      <li><span className="k42-welcome-value-icon" aria-hidden="true"><Rocket size={20} /></span><h3>Up and running in minutes</h3><p>One command to install, one prompt to start. Runs on your own Claude Code or Codex.</p></li>
      <li><span className="k42-welcome-value-icon" aria-hidden="true"><Smiley size={20} /></span><h3>Small, friendly, yours</h3><p>A little crew on your computer that you can watch, poke and guide.</p></li>
    </ul>
  </section>;
}
