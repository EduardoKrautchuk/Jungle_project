import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261031190000_create_financial_schema } from './Migration20261031190000_create_financial_schema.js';
import { Migration20261031190100_create_messaging_schema } from './Migration20261031190100_create_messaging_schema.js';
import { Migration20261031200000_enforce_single_reversal_and_wallet_link } from './Migration20261031200000_enforce_single_reversal_and_wallet_link.js';

export const MIGRATIONS: MigrationObject[] = [
  {
    name: 'Migration20261031190000_create_financial_schema',
    class: Migration20261031190000_create_financial_schema,
  },
  {
    name: 'Migration20261031190100_create_messaging_schema',
    class: Migration20261031190100_create_messaging_schema,
  },
  {
    name: 'Migration20261031200000_enforce_single_reversal_and_wallet_link',
    class: Migration20261031200000_enforce_single_reversal_and_wallet_link,
  },
];
