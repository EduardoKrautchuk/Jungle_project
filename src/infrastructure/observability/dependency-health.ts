export type DependencyHealth =
  | { readonly status: 'up' }
  | { readonly status: 'down'; readonly reason: string };

export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
