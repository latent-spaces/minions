import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import type { ProjectUsage as Usage, UsageMeasure } from '@mlswarm/contracts';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

/** The repository bar's token figures: input excluding cache reads and output. Nothing renders
 *  until an agent has reported one of them. */
export function ProjectUsageFigures({ usage }: { usage?: Usage | null }) {
  const measures = ([['Input excluding cache reads', usage?.uncached], ['Output', usage?.output]] as [string, UsageMeasure | null | undefined][])
    .filter((entry): entry is [string, UsageMeasure] => !!entry[1]);
  if (!measures.length) return null;
  return <dl className="k42-ph-usage" aria-label="Project token usage">
    {measures.map(([label, value]) => <div key={label} title={`${label}: ${value.value.toLocaleString('en')} tokens · ${value.reports} usage ${value.reports === 1 ? 'report' : 'reports'}${value.partial ? ' · incomplete coverage' : ''}`} data-tip={label}>
      <dt>{label === 'Output' ? <ArrowUpFromLine size={16} aria-hidden="true" /> : <ArrowDownToLine size={16} aria-hidden="true" />}<span className="visually-hidden">{label}</span></dt><dd>{compact.format(value.value)}</dd>
    </div>)}
  </dl>;
}
