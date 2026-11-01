export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface StructuredLog {
  write(level: LogLevel, event: string, fields?: LogFields): void;
}

export class JsonLinesLog implements StructuredLog {
  constructor(
    private readonly component: string,
    private readonly sink: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    const entry: Record<string, string | number | boolean> = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      event,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        entry[key] = value;
      }
    }
    this.sink(JSON.stringify(entry));
  }
}
