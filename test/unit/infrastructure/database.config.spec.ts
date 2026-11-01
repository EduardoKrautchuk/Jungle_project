import { describe, expect, it } from 'bun:test';
import {
  InvalidConfigurationError,
  loadDatabaseConfig,
} from '../../../src/infrastructure/config/database.config.js';

const ENV = {
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '55432',
  DATABASE_USER: 'jungle_gaming',
  DATABASE_PASSWORD: 'secret',
  DATABASE_NAME: 'jungle_gaming',
  DATABASE_TEST_NAME: 'jungle_gaming_test',
  DATABASE_POOL_MIN: '2',
  DATABASE_POOL_MAX: '8',
};

describe('loadDatabaseConfig', () => {
  it('loads the development database', () => {
    expect(loadDatabaseConfig(ENV)).toEqual({
      host: '127.0.0.1',
      port: 55432,
      user: 'jungle_gaming',
      password: 'secret',
      dbName: 'jungle_gaming',
      poolMin: 2,
      poolMax: 8,
    });
  });

  it('loads the isolated test database', () => {
    expect(loadDatabaseConfig(ENV, 'test').dbName).toBe('jungle_gaming_test');
  });

  it('applies defaults for port and pool', () => {
    const config = loadDatabaseConfig({
      ...ENV,
      DATABASE_PORT: undefined,
      DATABASE_POOL_MIN: undefined,
      DATABASE_POOL_MAX: '',
    });
    expect([config.port, config.poolMin, config.poolMax]).toEqual([
      5432, 1, 10,
    ]);
  });

  it('reports every missing variable at once', () => {
    expect(() => loadDatabaseConfig({})).toThrow(
      'DATABASE_NAME is required; DATABASE_HOST is required; DATABASE_USER is required; DATABASE_PASSWORD is required',
    );
  });

  it.each([
    ['DATABASE_PORT', '0'],
    ['DATABASE_PORT', '70000'],
    ['DATABASE_PORT', '54.32'],
    ['DATABASE_PORT', 'abc'],
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_POOL_MIN', '-1'],
  ])('rejects invalid %s=%p', (key, value) => {
    expect(() => loadDatabaseConfig({ ...ENV, [key]: value })).toThrow(
      InvalidConfigurationError,
    );
  });

  it('rejects a pool minimum above the maximum', () => {
    expect(() =>
      loadDatabaseConfig({ ...ENV, DATABASE_POOL_MIN: '9' }),
    ).toThrow('DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX');
  });

  it.each([
    ['jungle_gaming', 'must end with "_test"'],
    ['jungle_gaming_dev', 'must end with "_test"'],
  ])('refuses %p as test database', (name, message) => {
    expect(() =>
      loadDatabaseConfig({ ...ENV, DATABASE_TEST_NAME: name }, 'test'),
    ).toThrow(message);
  });

  it('refuses a test database equal to the development database', () => {
    expect(() =>
      loadDatabaseConfig(
        {
          ...ENV,
          DATABASE_NAME: 'shared_test',
          DATABASE_TEST_NAME: 'shared_test',
        },
        'test',
      ),
    ).toThrow('DATABASE_TEST_NAME must differ from DATABASE_NAME');
  });

  it('requires DATABASE_TEST_NAME only for the test target', () => {
    const env = { ...ENV, DATABASE_TEST_NAME: undefined };
    expect(loadDatabaseConfig(env).dbName).toBe('jungle_gaming');
    expect(() => loadDatabaseConfig(env, 'test')).toThrow(
      'DATABASE_TEST_NAME is required',
    );
  });
});
