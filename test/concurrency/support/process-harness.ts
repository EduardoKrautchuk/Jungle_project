import { fileURLToPath } from 'node:url';
import {
  parseWorkerResults,
  type WorkerJob,
  type WorkerResult,
} from './protocol.js';

const WORKER_PATH = fileURLToPath(
  new URL('./debit-worker.ts', import.meta.url),
);
const SERVER_PATH = fileURLToPath(new URL('./http-server.ts', import.meta.url));
const SQS_WORKER_PATH = fileURLToPath(
  new URL('./sqs-worker.ts', import.meta.url),
);
const OUTBOX_PUBLISHER_PATH = fileURLToPath(
  new URL('./outbox-publisher-process.ts', import.meta.url),
);

type Child = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

interface Waiter {
  prefix: string;
  resolve: (rest: string) => void;
}

const live = new Set<WorkerProcess>();

export class WorkerProcess {
  private readonly lines: string[] = [];
  private readonly waiters: Waiter[] = [];
  private stderr = '';

  private constructor(
    readonly name: string,
    private readonly child: Child,
  ) {
    void this.pump();
    void this.collectStderr();
  }

  static spawn(name: string, job: WorkerJob): WorkerProcess {
    return WorkerProcess.start(name, WORKER_PATH, {
      WORKER_JOB: JSON.stringify(job),
    });
  }

  static spawnServer(name: string): WorkerProcess {
    return WorkerProcess.start(name, SERVER_PATH, {});
  }

  static spawnSqsWorker(
    name: string,
    env: Record<string, string>,
  ): WorkerProcess {
    return WorkerProcess.start(name, SQS_WORKER_PATH, env);
  }

  static spawnOutboxPublisher(
    name: string,
    env: Record<string, string>,
  ): WorkerProcess {
    return WorkerProcess.start(name, OUTBOX_PUBLISHER_PATH, env);
  }

  output(prefix: string): string[] {
    return this.lines.filter((line) => line.includes(prefix));
  }

  private static start(
    name: string,
    script: string,
    env: Record<string, string>,
  ): WorkerProcess {
    const child = Bun.spawn({
      cmd: [process.execPath, script],
      env: { ...process.env, ...env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const worker = new WorkerProcess(name, child);
    live.add(worker);
    return worker;
  }

  get pid(): number {
    return this.child.pid;
  }

  waitFor(prefix: string, timeoutMs: number): Promise<string> {
    const index = this.lines.findIndex((line) => line.startsWith(prefix));
    if (index >= 0) {
      const [line] = this.lines.splice(index, 1);
      return Promise.resolve((line ?? '').slice(prefix.length).trim());
    }
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { prefix, resolve };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `${this.name} (pid ${this.pid}) did not print "${prefix}" within ${timeoutMs}ms. stderr: ${this.stderr.slice(-2000)}`,
          ),
        );
      }, timeoutMs);
      waiter.resolve = (rest) => {
        clearTimeout(timer);
        resolve(rest);
      };
      this.waiters.push(waiter);
    });
  }

  async results(timeoutMs: number): Promise<WorkerResult[]> {
    return parseWorkerResults(await this.waitFor('RESULT', timeoutMs));
  }

  hasPrinted(prefix: string): boolean {
    return this.lines.some((line) => line.startsWith(prefix));
  }

  send(line: string): void {
    void this.child.stdin.write(`${line}\n`);
    void this.child.stdin.flush();
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill(signal);
    }
  }

  async exit(timeoutMs: number): Promise<{
    exitCode: number | null;
    signalCode: string | null;
  }> {
    const timer = setTimeout(() => this.kill('SIGKILL'), timeoutMs);
    await this.child.exited;
    clearTimeout(timer);
    live.delete(this);
    return {
      exitCode: this.child.exitCode,
      signalCode:
        this.child.signalCode === null ? null : String(this.child.signalCode),
    };
  }

  get errorOutput(): string {
    return this.stderr;
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of this.child.stdout) {
      buffer += decoder.decode(chunk);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        this.deliver(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
  }

  private async collectStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.child.stderr) {
      this.stderr += decoder.decode(chunk);
    }
  }

  private deliver(line: string): void {
    const waiterIndex = this.waiters.findIndex((w) =>
      line.startsWith(w.prefix),
    );
    const waiter = this.waiters[waiterIndex];
    if (waiter) {
      this.waiters.splice(waiterIndex, 1);
      waiter.resolve(line.slice(waiter.prefix.length).trim());
      return;
    }
    this.lines.push(line);
  }
}

export async function startTogether(
  workers: WorkerProcess[],
  timeoutMs: number,
): Promise<void> {
  await Promise.all(
    workers.map((worker) => worker.waitFor('READY', timeoutMs)),
  );
  for (const worker of workers) {
    worker.send('GO');
  }
}

export async function killAll(): Promise<void> {
  const workers = [...live];
  for (const worker of workers) {
    worker.kill('SIGKILL');
  }
  await Promise.all(workers.map((worker) => worker.exit(5_000)));
}
