import claude from './assets/tools/claude.svg';
import codex from './assets/tools/codex.svg';

/** The coding tools a prompt goes to, as small marks (owner, 16 November 2026). Sources: assets/tools/sources.json. */
export function ToolMarks({ size = 14 }: { size?: number }) {
  return <span className="k42-tool-marks" aria-hidden="true">
    <img src={claude} alt="" width={size} height={size} /><img src={codex} alt="" width={size} height={size} />
  </span>;
}
