export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  dbName: string;
  poolMin: number;
  poolMax: number;
}

export type DatabaseTarget = 'default' | 'test';

type Env = Readonly<Record<string, string | undefined>>;

export class InvalidConfigurationError extends Error {
  constructor(problems: readonly string[], scope = 'database') {
    super(`Invalid ${scope} configuration: ${problems.join('; ')}`);
    this.name = 'InvalidConfigurationError';
  }
}

const INTEGER_PATTERN = /^\d+$/;

export function loadDatabaseConfig(
  env: Env,
  target: DatabaseTarget = 'default',
): DatabaseConfig {
  const problems: string[] = [];

  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) {
      problems.push(`${key} is required`);
      return '';
    }
    return value;
  };

  const integer = (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = env[key]?.trim();
    if (!raw) {
      return fallback;
    }
    const value = INTEGER_PATTERN.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${key} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };

  const defaultDbName = required('DATABASE_NAME');
  const config: DatabaseConfig = {
    host: required('DATABASE_HOST'),
    port: integer('DATABASE_PORT', 5432, 1, 65535),
    user: required('DATABASE_USER'),
    password: required('DATABASE_PASSWORD'),
    dbName: target === 'test' ? required('DATABASE_TEST_NAME') : defaultDbName,
    poolMin: integer('DATABASE_POOL_MIN', 1, 0, 100),
    poolMax: integer('DATABASE_POOL_MAX', 10, 1, 100),
  };

  if (config.poolMin > config.poolMax) {
    problems.push('DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX');
  }
  if (target === 'test' && config.dbName) {
    if (!config.dbName.endsWith('_test')) {
      problems.push('DATABASE_TEST_NAME must end with "_test"');
    }
    if (config.dbName === defaultDbName) {
      problems.push('DATABASE_TEST_NAME must differ from DATABASE_NAME');
    }
  }

  if (problems.length > 0) {
    throw new InvalidConfigurationError(problems);
  }
  return config;
}
