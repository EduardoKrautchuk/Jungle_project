import { TransactionNotFoundError } from '../application.errors.js';
import type {
  StoredWagerTransaction,
  UnitOfWork,
} from '../ports/persistence.js';

export class WagerTransactionQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<StoredWagerTransaction> {
    return found(
      await this.uow.run((repositories) =>
        repositories.transactions.findById(transactionId),
      ),
    );
  }

  async getByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction> {
    return found(
      await this.uow.run((repositories) =>
        repositories.transactions.findByExternalId(
          providerId,
          externalTransactionId,
        ),
      ),
    );
  }
}

function found(
  stored: StoredWagerTransaction | undefined,
): StoredWagerTransaction {
  if (stored === undefined) {
    throw new TransactionNotFoundError();
  }
  return stored;
}
