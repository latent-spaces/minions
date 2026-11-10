import { combineReportedUsage, normalizeReportedUsage, type ReportedUsage, type UsageMeasure } from '@mlswarm/contracts';
import { time } from '../shared';
import './usage-summary.css';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
export function UsageValue({ value }: { value: UsageMeasure | null }) {
  return value ? <span title={`${value.value.toLocaleString()} · ${value.reports} usage reports${value.partial ? ' · incomplete coverage' : ''}`}>
    {compact.format(value.value)}{value.partial && <small>Partial</small>}
  </span> : <span className="muted">Unknown</span>;
}

export function UsageSummary({ rows, scope }: { rows: (ReportedUsage | null | undefined)[]; scope: string }) {
  if (!rows.length) return null;
  const sum = combineReportedUsage(rows);
  return <section className="usage-summary" aria-label="Combined reported usage">
    <div><h3>Reported usage</h3><p>{scope} · {sum.agents} agents</p></div>
    <dl><div><dt>Input (not cached)</dt><dd><UsageValue value={sum.uncached} /></dd></div>
      <div><dt>Output</dt><dd><UsageValue value={sum.output} /></dd></div>
      <div><dt>Total</dt><dd><UsageValue value={sum.investment} /></dd></div></dl>
    <p>Input + output, excluding cache reads. Received reports only. Partial totals exclude data that cannot be normalized.</p>
  </section>;
}

type DetailUsage = ReportedUsage & { firstReportedAt: number; lastReportedAt: number; seconds: number;
  toolCalls?: number; toolReports?: number; partialToolReports?: number };
export function AgentUsage({ usage, now }: { usage: DetailUsage | null; now: number }) {
  const value = normalizeReportedUsage(usage);
  const total = combineReportedUsage([usage]).investment;
  return <section className="agent-panel agent-usage-panel" aria-labelledby="agent-usage">
    <h3 id="agent-usage">Reported usage</h3>
    <dl className="agent-usage-primary">
      <div><dt>Input (not cached)</dt><dd><UsageValue value={value.uncached} /></dd></div>
      <div><dt>Output</dt><dd><UsageValue value={value.output} /></dd></div>
      <div><dt>Total</dt><dd><UsageValue value={total} /></dd></div>
    </dl>
    <p className="agent-help">Input + output, excluding cache reads.</p>
    <dl className="agent-usage">
      <div><dt>Reported run time</dt><dd>{usage ? `${Math.floor(usage.seconds / 60).toLocaleString()}m ${Math.floor(usage.seconds % 60)}s` : 'Unknown'}</dd></div>
    </dl>
    <p className="agent-help">{usage ? <>All received reports · Updated {time(usage.lastReportedAt, true, now)}</> : 'No usage reports received.'}</p>
    <details><summary>Usage details</summary>
      <dl className="agent-usage">
        <div><dt>Cache read</dt><dd><UsageValue value={value.cacheRead} /></dd></div>
        <div><dt>Input including cache reads</dt><dd><UsageValue value={value.input} /></dd></div>
        <div><dt>Cache write</dt><dd><UsageValue value={value.cacheWrite} /></dd></div>
        <div><dt>Tool calls</dt><dd>{usage && (usage.toolReports ?? 0) > 0 ? usage.toolCalls?.toLocaleString() : 'Unknown'}</dd>
          {usage && (usage.toolReports ?? 0) > 0 && <dd className="agent-help">{usage.toolReports}/{usage.turns} reports{usage.partialToolReports ? ' · partial tool coverage' : ''}</dd>}</div>
      </dl>
      <p className="agent-help">Based on {value.reports} usage reports. Cache reads are excluded from input and total above. Cache writes count as uncached input. Unknown means it was not reported.</p>
      <p className="agent-help">Usage is reported for agents, not individual tasks.</p>
    </details>
  </section>;
}
