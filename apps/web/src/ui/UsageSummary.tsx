import { combineReportedUsage, normalizeReportedUsage, type ReportedUsage, type UsageMeasure } from '@minions/contracts';
import './usage-summary.css';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
export function UsageValue({ value }: { value: UsageMeasure | null }) {
  return value ? <span title={`${value.value.toLocaleString()} · ${value.reports} usage reports${value.partial ? ' · incomplete coverage' : ''}`}>
    {compact.format(value.value)}{value.partial && <small>Partial</small>}
  </span> : <span className="muted">Unknown</span>;
}

type DetailUsage = ReportedUsage & { firstReportedAt: number; lastReportedAt: number; seconds: number;
  toolCalls?: number; toolReports?: number; partialToolReports?: number };
export function AgentUsage({ usage }: { usage: DetailUsage | null }) {
  const value = normalizeReportedUsage(usage);
  const total = combineReportedUsage([usage]).investment;
  // One line on the agent page (owner, 12 November 2026); the rest of the numbers open from it.
  return <section className="agent-panel agent-usage-panel" aria-labelledby="agent-usage">
    <h3 id="agent-usage">Usage</h3>
    {usage ? <details><summary><UsageValue value={value.output} /> output · {Math.floor(usage.seconds / 60).toLocaleString()}m run</summary>
      <dl className="agent-usage">
        <div><dt>Input (not cached)</dt><dd><UsageValue value={value.uncached} /></dd></div>
        <div><dt>Total</dt><dd><UsageValue value={total} /></dd></div>
        <div><dt>Cache read</dt><dd><UsageValue value={value.cacheRead} /></dd></div>
        <div><dt>Cache write</dt><dd><UsageValue value={value.cacheWrite} /></dd></div>
        <div><dt>Tool calls</dt><dd>{(usage.toolReports ?? 0) > 0 ? usage.toolCalls?.toLocaleString() : 'Unknown'}</dd></div>
      </dl>
      <p className="agent-help">Total is input plus output, without cache reads. Unknown means the agent didn’t report it.</p>
    </details> : <p className="muted">No usage reported yet.</p>}
  </section>;
}
