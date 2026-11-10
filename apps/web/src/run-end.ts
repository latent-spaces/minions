// What the operator is told about how an agent's last run ended (ui/YourAgent.tsx and MyAgents.tsx), kept pure so it is
// tested without a browser. The service stores the reason as written, so a value this list does not know is shown
// as it is, and a reason the runner did not report is said so rather than guessed.
export type LastRun = { startedAt: number | null; endedAt: number | null; endReason: string | null } | null;

// The line for a run that has ended. A run still running has no stop line, and no run is unknown.
export function runEndLine(run: LastRun | undefined): string | null {
  if (!run) return 'Last run: unknown';
  if (run.endedAt === null) return null;
  switch (run.endReason) {
    case null: return 'Stopped (reason not reported)';
    case 'operator': return 'Stopped by you';
    case 'repeated_failures': return 'Stopped after repeated failures';
    case 'superseded': return 'Replaced by a newer run';
    case 'checkout_missing': return 'Stopped: the agent’s folder isn’t a copy of the project’s repository. The download may not have finished. Add the agent again.';
    case 'controller_failed': return 'Stopped after an error on your computer';
    case 'operator_revoked': return 'Revoked';
    case 'membership_removed':
    case 'operator_removed': return 'Access removed';
    default: return `Stopped (${run.endReason})`;
  }
}
