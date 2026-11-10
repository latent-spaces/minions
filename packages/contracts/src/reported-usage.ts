/** Raw received counters. Accounting describes the counters, not a provider identity. */
export type ReportedUsage = {
  turns: number; input: number; output: number;
  cacheRead?: number; cacheWrite?: number; inputSemantics?: string;
  tokenCoverage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
};
export type UsageMeasure = { value: number; reports: number; partial: boolean };

/** Never assume absent cache counters are zero, or subtract counters from different report sets. */
export function normalizeReportedUsage(usage: ReportedUsage | null | undefined) {
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const reports = count(usage?.turns) ? usage.turns : 0;
  const metric = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): UsageMeasure | null => {
    const value = usage?.[key], coverage = usage?.tokenCoverage?.[key];
    return reports > 0 && count(value) && count(coverage) && coverage > 0 && coverage <= reports
      ? { value, reports: coverage, partial: coverage < reports } : null;
  };
  const rawInput = metric('input'), output = metric('output'), cacheRead = metric('cacheRead'), cacheWrite = metric('cacheWrite');
  let input: UsageMeasure | null = null, uncached: UsageMeasure | null = null;
  if (usage?.inputSemantics === 'includes-cache') {
    input = rawInput;
    // Equal counts below the total do not prove that the reports cover the same turns.
    if (input && !input.partial && cacheRead && !cacheRead.partial) {
      if (cacheRead.value <= input.value) uncached = { ...input, value: input.value - cacheRead.value };
      else input = null;
    }
  } else if (usage?.inputSemantics === 'uncached') {
    if (rawInput && cacheRead && cacheWrite && !rawInput.partial && !cacheRead.partial && !cacheWrite.partial) {
      const total = rawInput.value + cacheRead.value + cacheWrite.value;
      if (count(total)) {
        input = { ...rawInput, value: total };
        uncached = { ...rawInput, value: rawInput.value + cacheWrite.value };
      }
    }
  }
  return { input, output, cacheRead, cacheWrite, uncached, reports };
}

/** A summary of exactly the supplied agents, never an implicit full-project total. */
export function combineReportedUsage(rows: (ReportedUsage | null | undefined)[]) {
  const normalized = rows.map(normalizeReportedUsage);
  const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'uncached') => {
    const known = normalized.map(row => row[key]).filter((v): v is UsageMeasure => v !== null);
    const value = known.reduce((n, v) => n + v.value, 0);
    return known.length && Number.isSafeInteger(value)
      ? { value, reports: known.reduce((n, v) => n + v.reports, 0), partial: known.length < rows.length || known.some(v => v.partial) }
      : null;
  };
  const eligible = normalized.filter(row => row.uncached && row.output && !row.uncached.partial && !row.output.partial);
  const investment = eligible.reduce((n, row) => n + row.uncached!.value + row.output!.value, 0);
  return { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), uncached: sum('uncached'), agents: rows.length,
    investment: eligible.length && Number.isSafeInteger(investment) ? { value: investment,
      reports: eligible.reduce((n, row) => n + row.reports, 0), partial: eligible.length < rows.length } : null,
    reportedAgents: normalized.filter(row => row.reports > 0).length, includedAgents: eligible.length,
    reports: normalized.reduce((n, row) => n + row.reports, 0) };
}

export type ProjectUsage = ReturnType<typeof combineReportedUsage> & { lastReportedAt: number | null; serverTime: number };
