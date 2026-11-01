export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'histogram' | 'gauge';
}

export interface GaugeSample {
  readonly labels: MetricLabels;
  readonly value: number;
}

export interface GaugeFamily {
  readonly definition: MetricDefinition;
  readonly samples: readonly GaugeSample[];
}

export const METRIC = {
  operations: {
    name: 'wagering_operations_total',
    help: 'Operations handled by this process, by source and result',
    type: 'counter',
  },
  duplicates: {
    name: 'wagering_duplicates_total',
    help: 'Duplicate deliveries detected by this process (idempotent replay or inbox duplicate)',
    type: 'counter',
  },
  retries: {
    name: 'wagering_retries_total',
    help: 'Retries scheduled by this process, by component and reason',
    type: 'counter',
  },
  deadLetters: {
    name: 'wagering_dead_letters_total',
    help: 'Messages or events sent to a dead letter by this process',
    type: 'counter',
  },
  lockConflicts: {
    name: 'wagering_lock_conflicts_total',
    help: 'Wallet lock conflicts (lock timeout or serialization failure) seen by this process',
    type: 'counter',
  },
  duration: {
    name: 'wagering_operation_duration_seconds',
    help: 'Processing latency of operations handled by this process',
    type: 'histogram',
  },
  reconciliations: {
    name: 'wagering_reconciliations_total',
    help: 'Wallet reconciliations run by this process, by result',
    type: 'counter',
  },
} as const satisfies Record<string, MetricDefinition>;

export const DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

interface CounterSeries {
  readonly labels: MetricLabels;
  value: number;
}

interface HistogramSeries {
  readonly labels: MetricLabels;
  readonly buckets: number[];
  count: number;
  sum: number;
}

export class Metrics {
  readonly #counters = new Map<string, Map<string, CounterSeries>>();
  readonly #histograms = new Map<string, Map<string, HistogramSeries>>();

  increment(
    definition: MetricDefinition,
    labels: MetricLabels = {},
    by = 1,
  ): void {
    const series = seriesOf(this.#counters, definition.name);
    const key = labelKey(labels);
    const current = series.get(key);
    if (current === undefined) {
      series.set(key, { labels, value: by });
      return;
    }
    current.value += by;
  }

  observe(
    definition: MetricDefinition,
    seconds: number,
    labels: MetricLabels = {},
  ): void {
    const series = seriesOf(this.#histograms, definition.name);
    const key = labelKey(labels);
    let current = series.get(key);
    if (current === undefined) {
      current = {
        labels,
        buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
        count: 0,
        sum: 0,
      };
      series.set(key, current);
    }
    for (const [index, bound] of DURATION_BUCKETS_SECONDS.entries()) {
      if (seconds <= bound) {
        current.buckets[index] = (current.buckets[index] ?? 0) + 1;
      }
    }
    current.count += 1;
    current.sum += seconds;
  }

  counterValue(
    definition: MetricDefinition,
    labels: MetricLabels = {},
  ): number {
    return (
      this.#counters.get(definition.name)?.get(labelKey(labels))?.value ?? 0
    );
  }

  render(gauges: readonly GaugeFamily[] = []): string {
    const lines: string[] = [];
    for (const definition of Object.values(METRIC)) {
      lines.push(...header(definition));
      if (definition.type === 'histogram') {
        for (const series of this.#histograms.get(definition.name)?.values() ??
          []) {
          lines.push(...histogramLines(definition.name, series));
        }
        continue;
      }
      for (const series of this.#counters.get(definition.name)?.values() ??
        []) {
        lines.push(sample(definition.name, series.labels, series.value));
      }
    }
    for (const family of gauges) {
      lines.push(...header(family.definition));
      for (const gauge of family.samples) {
        lines.push(sample(family.definition.name, gauge.labels, gauge.value));
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function seriesOf<T>(
  families: Map<string, Map<string, T>>,
  name: string,
): Map<string, T> {
  let series = families.get(name);
  if (series === undefined) {
    series = new Map();
    families.set(name, series);
  }
  return series;
}

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ''}`)
    .join(',');
}

function header(definition: MetricDefinition): string[] {
  return [
    `# HELP ${definition.name} ${definition.help}`,
    `# TYPE ${definition.name} ${definition.type}`,
  ];
}

function histogramLines(name: string, series: HistogramSeries): string[] {
  const lines = DURATION_BUCKETS_SECONDS.map((bound, index) =>
    sample(
      `${name}_bucket`,
      { ...series.labels, le: String(bound) },
      series.buckets[index] ?? 0,
    ),
  );
  lines.push(
    sample(`${name}_bucket`, { ...series.labels, le: '+Inf' }, series.count),
    sample(`${name}_sum`, series.labels, series.sum),
    sample(`${name}_count`, series.labels, series.count),
  );
  return lines;
}

function sample(name: string, labels: MetricLabels, value: number): string {
  const rendered = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${escapeLabel(labels[key] ?? '')}"`)
    .join(',');
  return `${name}${rendered === '' ? '' : `{${rendered}}`} ${formatValue(value)}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function formatValue(value: number): string {
  return Number.isFinite(value) ? String(value) : 'NaN';
}
