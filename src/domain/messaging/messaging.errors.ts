import { DomainError } from '../shared/domain-error.js';

export type MessagingErrorCode =
  'MESSAGING_INVALID_MESSAGE' | 'MESSAGING_INVALID_STATE';

export abstract class MessagingError extends DomainError<MessagingErrorCode> {}

export class InvalidMessageError extends MessagingError {
  constructor(reason: string) {
    super('MESSAGING_INVALID_MESSAGE', `Invalid message: ${reason}`);
  }
}

export class InvalidMessageStateError extends MessagingError {
  constructor(reason: string) {
    super('MESSAGING_INVALID_STATE', `Invalid message state: ${reason}`);
  }
}
