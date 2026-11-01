import { describe, expect, it } from 'bun:test';
import {
  ConcurrencyConflictError,
  PersistenceUnavailableError,
  IntegrityConstraintViolationError,
  UniqueConstraintViolationError,
} from '../../../src/application/ports/persistence.errors.js';
import { translateDatabaseError } from '../../../src/infrastructure/persistence/database-errors.js';

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error(`pg ${code}`), { code, constraint });

describe('translateDatabaseError', () => {
  it('maps unique violations with their constraint', () => {
    const original = pgError('23505', 'wager_tx_single_reversal_uq');
    const translated = translateDatabaseError(original);
    expect(translated).toBeInstanceOf(UniqueConstraintViolationError);
    if (translated instanceof UniqueConstraintViolationError) {
      expect(translated.constraint).toBe('wager_tx_single_reversal_uq');
      expect(translated.cause).toBe(original);
    }
  });

  it.each([['23001'], ['23502'], ['23503'], ['23514']])(
    'maps %s to an integrity violation',
    (code) => {
      const translated = translateDatabaseError(pgError(code, 'some_ck'));
      expect(translated).toBeInstanceOf(IntegrityConstraintViolationError);
      if (translated instanceof IntegrityConstraintViolationError) {
        expect(translated.sqlState).toBe(code);
        expect(translated.constraint).toBe('some_ck');
      }
    },
  );

  it.each([['40001'], ['40P01'], ['55P03']])(
    'maps %s to a retryable concurrency conflict',
    (code) => {
      expect(translateDatabaseError(pgError(code))).toBeInstanceOf(
        ConcurrencyConflictError,
      );
    },
  );

  it('keeps unrelated errors untouched', () => {
    const syntax = pgError('42601');
    const plain = new Error('boom');
    const unknownCode = Object.assign(new Error('odd'), { code: 'EWHATEVER' });
    expect(translateDatabaseError(syntax)).toBe(syntax);
    expect(translateDatabaseError(plain)).toBe(plain);
    expect(translateDatabaseError(unknownCode)).toBe(unknownCode);
  });

  it.each([['08006'], ['08001'], ['57P01'], ['53300']])(
    'maps %s to a retryable unavailability',
    (code) => {
      const error = pgError(code);
      const translated = translateDatabaseError(error);
      expect(translated).toBeInstanceOf(PersistenceUnavailableError);
      if (translated instanceof PersistenceUnavailableError) {
        expect(translated.cause).toBe(error);
      }
    },
  );

  it.each([['ECONNREFUSED'], ['ECONNRESET'], ['ETIMEDOUT']])(
    'maps the network failure %s to a retryable unavailability',
    (code) => {
      const nodeError = Object.assign(new Error('network'), { code });
      expect(translateDatabaseError(nodeError)).toBeInstanceOf(
        PersistenceUnavailableError,
      );
    },
  );

  it('does not wrap an already translated error twice', () => {
    const conflict = new ConcurrencyConflictError('stale version');
    expect(translateDatabaseError(conflict)).toBe(conflict);
  });
});
