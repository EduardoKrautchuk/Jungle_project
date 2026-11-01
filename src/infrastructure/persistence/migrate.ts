import { MikroORM } from '@mikro-orm/postgresql';
import { loadDatabaseConfig } from '../config/database.config.js';
import { createMikroOrmConfig } from './mikro-orm.config.js';

const COMMANDS = ['up', 'down', 'status'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return COMMANDS.some((command) => command === value);
}

const [commandArg, ...flags] = process.argv.slice(2);
if (!isCommand(commandArg)) {
  console.error(
    'Usage: bun src/infrastructure/persistence/migrate.ts <up|down|status> [--test] [--all]',
  );
  process.exit(1);
}

const target = flags.includes('--test') ? 'test' : 'default';
const database = loadDatabaseConfig(process.env, target);
const orm = await MikroORM.init(createMikroOrmConfig(database));

try {
  const migrator = orm.migrator;
  if (commandArg === 'up') {
    const applied = await migrator.up();
    console.log(
      `[${database.dbName}] applied: ${applied.map((m) => m.name).join(', ') || 'none'}`,
    );
  } else if (commandArg === 'down') {
    const reverted = await migrator.down(
      flags.includes('--all') ? { to: 0 } : undefined,
    );
    console.log(
      `[${database.dbName}] reverted: ${reverted.map((m) => m.name).join(', ') || 'none'}`,
    );
  } else {
    const executed = await migrator.getExecuted();
    const pending = await migrator.getPending();
    console.log(
      `[${database.dbName}] executed: ${executed.map((m) => m.name).join(', ') || 'none'}`,
    );
    console.log(
      `[${database.dbName}] pending: ${pending.map((m) => m.name).join(', ') || 'none'}`,
    );
  }
} finally {
  await orm.close(true);
}
