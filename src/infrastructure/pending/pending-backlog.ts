import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from '../config/database.config.js';
import { createMikroOrmConfig } from '../persistence/mikro-orm.config.js';

const target = process.argv.includes('--test') ? 'test' : 'default';
const orm = await MikroORM.init(
  createMikroOrmConfig(loadDatabaseConfig(process.env, target)),
);

const SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'PENDING_REFERENCE')::int AS pending,
    count(*) FILTER (WHERE status = 'PENDING_REFERENCE'
                       AND next_reference_attempt_at <= now())::int AS due,
    count(*) FILTER (WHERE status = 'PENDING_REFERENCE'
                       AND reference_attempts > 0)::int AS retrying,
    count(*) FILTER (WHERE status = 'REJECTED'
                       AND reference_attempts > 0
                       AND failure_code IN ('REFERENCE_NOT_FOUND', 'REFERENCE_NOT_PROCESSED'))::int AS exhausted,
    count(*) FILTER (WHERE reference_attempts > 0
                       AND status IN ('PROCESSED', 'REJECTED'))::int AS resolved_after_retry,
    max(reference_attempts) FILTER (WHERE status = 'PENDING_REFERENCE')::int AS max_attempts,
    floor(extract(epoch FROM now() - min(created_at)
      FILTER (WHERE status = 'PENDING_REFERENCE')) * 1000)::bigint::text AS oldest_pending_age_ms
  FROM wager_transactions`;

try {
  const rows = await orm.em.getConnection().execute(SQL, [], 'all');
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  console.log(
    JSON.stringify({
      database: orm.config.get('dbName'),
      claims: 'none: resolution runs under the wallet lock without leases',
      ...(typeof row === 'object' && row !== null ? row : {}),
    }),
  );
} catch (error) {
  console.error(
    `pending backlog failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
