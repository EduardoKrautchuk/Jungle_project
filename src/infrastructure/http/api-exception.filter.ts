import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  InvalidRequestError,
  type ApplicationErrorCode,
  type ValidationIssue,
} from '../../application/application.errors.js';
import {
  ConcurrencyConflictError,
  PersistenceUnavailableError,
} from '../../application/ports/persistence.errors.js';
import type { StructuredLog } from '../observability/structured-log.js';
import { HTTP_LOG } from './http-observability.interceptor.js';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: readonly ValidationIssue[];
  };
}

const APPLICATION_STATUS: Readonly<Record<ApplicationErrorCode, number>> = {
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  MESSAGE_PAYLOAD_MISMATCH: HttpStatus.CONFLICT,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
};

const HTTP_ERRORS: Readonly<
  Partial<Record<number, { code: string; message: string }>>
> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'MALFORMED_REQUEST',
    message: 'The request could not be parsed',
  },
  [HttpStatus.NOT_FOUND]: {
    code: 'ROUTE_NOT_FOUND',
    message: 'Route not found',
  },
  [HttpStatus.METHOD_NOT_ALLOWED]: {
    code: 'METHOD_NOT_ALLOWED',
    message: 'Method not allowed',
  },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    code: 'PAYLOAD_TOO_LARGE',
    message: 'The request body is too large',
  },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Unsupported media type',
  },
};

const LOCK_CONFLICT_RETRY_AFTER_SECONDS = '1';
const UNAVAILABLE_RETRY_AFTER_SECONDS = '5';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(HTTP_LOG) private readonly log: StructuredLog) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApplicationError) {
      const body: ApiErrorBody = {
        error: { code: exception.code, message: exception.message },
      };
      if (exception instanceof InvalidRequestError) {
        body.error.details = exception.issues;
      }
      response.status(APPLICATION_STATUS[exception.code]).json(body);
      return;
    }

    if (exception instanceof ConcurrencyConflictError) {
      response
        .setHeader('Retry-After', LOCK_CONFLICT_RETRY_AFTER_SECONDS)
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json(
          errorBody(
            'CONCURRENCY_CONFLICT',
            'The wallet is busy, retry the same request later',
          ),
        );
      return;
    }

    if (exception instanceof PersistenceUnavailableError) {
      response
        .setHeader('Retry-After', UNAVAILABLE_RETRY_AFTER_SECONDS)
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json(
          errorBody(
            'SERVICE_UNAVAILABLE',
            'A dependency is temporarily unavailable, retry the same request later',
          ),
        );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (
        typeof payload === 'object' &&
        payload !== null &&
        !('statusCode' in payload)
      ) {
        response.status(status).json(payload);
        return;
      }
      const known = HTTP_ERRORS[status];
      response
        .status(status)
        .json(
          errorBody(
            known?.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
            known?.message ??
              (status >= 500 ? 'Internal server error' : 'Request failed'),
          ),
        );
      return;
    }

    this.log.write('error', 'http.unexpected_error', {
      errorName: exception instanceof Error ? exception.name : typeof exception,
    });
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(errorBody('INTERNAL_ERROR', 'Internal server error'));
  }
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}
