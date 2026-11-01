import {
  InvalidRequestError,
  type ValidationIssue,
} from '../../application/application.errors.js';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IDENTIFIER_PATTERN = /^[\x21-\x7E](?:[\x20-\x7E]{0,254}[\x21-\x7E])?$/;

export interface StringRule {
  readonly pattern: RegExp;
  readonly code: string;
  readonly message: string;
}

export const IDENTIFIER: StringRule = {
  pattern: IDENTIFIER_PATTERN,
  code: 'INVALID_IDENTIFIER',
  message:
    'must be 1 to 256 printable ASCII characters without leading or trailing spaces',
};

export const PROVIDER_ID: StringRule = {
  pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  code: 'INVALID_PROVIDER_ID',
  message:
    'must be 1 to 64 characters of letters, digits, ".", "_" or "-" starting with a letter or digit',
};

export const CORRELATION_ID: StringRule = {
  pattern: /^[A-Za-z0-9._:-]{1,128}$/,
  code: 'INVALID_CORRELATION_ID',
  message:
    'must be 1 to 128 characters of letters, digits, ".", "_", ":" or "-"',
};

export const SUBMITTABLE_KIND: StringRule = {
  pattern: /^(BET|WIN|LOSS|REFUND|ROLLBACK)$/,
  code: 'UNSUPPORTED_KIND',
  message: 'must be one of BET, WIN, LOSS, REFUND, ROLLBACK',
};

const UUID: StringRule = {
  pattern: UUID_PATTERN,
  code: 'INVALID_UUID',
  message: 'must be a UUID',
};

export type JsonObject = { readonly [key: string]: unknown };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RequestReader {
  readonly #issues: ValidationIssue[] = [];

  issue(field: string, code: string, message: string): void {
    this.#issues.push({ field, code, message });
  }

  object(
    value: unknown,
    field: string,
    allowed: readonly string[],
  ): JsonObject {
    if (!isJsonObject(value)) {
      this.issue(field, 'INVALID_TYPE', 'must be a JSON object');
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        const path = field === 'body' ? key : `${field}.${key}`;
        this.issue(path, 'UNKNOWN_FIELD', 'is not an accepted field');
      }
    }
    return value;
  }

  string(value: unknown, field: string, rule: StringRule): string {
    if (value === undefined || value === null) {
      this.issue(field, 'REQUIRED', 'is required');
      return '';
    }
    if (typeof value !== 'string') {
      this.issue(field, 'INVALID_TYPE', 'must be a string');
      return '';
    }
    if (!rule.pattern.test(value)) {
      this.issue(field, rule.code, rule.message);
      return '';
    }
    return value;
  }

  optionalString(
    value: unknown,
    field: string,
    rule: StringRule,
  ): string | undefined {
    return value === undefined ? undefined : this.string(value, field, rule);
  }

  uuid(value: unknown, field: string): string {
    return this.string(value, field, UUID).toLowerCase();
  }

  money(value: unknown, field: string): { amount: string; currency: string } {
    const money = this.object(value, field, ['amount', 'currency']);
    return {
      amount: this.#plainString(money.amount, `${field}.amount`),
      currency: this.#plainString(money.currency, `${field}.currency`),
    };
  }

  finish<T>(result: T): T {
    if (this.#issues.length > 0) {
      throw new InvalidRequestError([...this.#issues]);
    }
    return result;
  }

  #plainString(value: unknown, field: string): string {
    if (value === undefined || value === null) {
      this.issue(field, 'REQUIRED', 'is required');
      return '';
    }
    if (typeof value !== 'string') {
      this.issue(field, 'INVALID_TYPE', 'must be a string');
      return '';
    }
    return value;
  }
}

export function readUuid(value: unknown, field: string): string {
  const reader = new RequestReader();
  const uuid = reader.uuid(value, field);
  return reader.finish(uuid);
}
