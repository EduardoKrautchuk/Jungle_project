import { InvalidConfigurationError } from '../config/database.config.js';
import type { Metrics } from './metrics.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface MetricsServer {
  readonly port: number;
  stop(): Promise<void>;
}

export function loadMetricsPort(env: Env): number | undefined {
  const raw = env.METRICS_PORT?.trim();
  if (!raw) {
    return undefined;
  }
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new InvalidConfigurationError(
      ['METRICS_PORT must be an integer between 0 and 65535'],
      'metrics',
    );
  }
  return port;
}

export function serveMetrics(metrics: Metrics, port: number): MetricsServer {
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(request) {
      if (new URL(request.url).pathname !== '/metrics') {
        return new Response('not found', { status: 404 });
      }
      return new Response(metrics.render(), {
        headers: { 'content-type': 'text/plain; version=0.0.4' },
      });
    },
  });
  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}
