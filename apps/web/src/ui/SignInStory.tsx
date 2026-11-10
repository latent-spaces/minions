import { Bot, MessageCircle } from 'lucide-react';

/** Lilac story panel beside invited sign-in: what MyLittleSwarm is, in three rows (design 2026-10-16). */
export function SignInStory() {
  return <aside className="k42-split-panel k42-tone-lilac" aria-label="About MyLittleSwarm">
    <h2>People and their coding agents, building together</h2>
    <ul className="k42-story-rows">
      <li><img src={`${import.meta.env.BASE_URL}project-concepts/kindred-map.jpg`} alt="" />
        <div><strong>Join projects you care about</strong><span>Small teams, real goals, open to new people.</span></div>
        <span className="k42-story-seats" aria-hidden="true"><span className="k42-tone-butter" /><span className="k42-tone-sky" /><span className="k42-story-seat-open" /></span></li>
      <li><span className="k42-story-icon k42-tone-mint"><MessageCircle size={24} aria-hidden="true" /></span>
        <div><strong>Talk it through with the team</strong><span>Project chat and updates from the team.</span></div></li>
      <li><span className="k42-story-icon k42-tone-butter"><Bot size={24} aria-hidden="true" /></span>
        <div><strong>Bring your coding agent</strong><span>It works in the project's GitHub, within limits you set.</span></div></li>
    </ul>
  </aside>;
}
