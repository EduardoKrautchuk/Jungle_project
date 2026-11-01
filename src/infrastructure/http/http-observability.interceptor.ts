import {
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { catchError, tap, throwError, type Observable } from 'rxjs';
import { ApplicationError } from '../../application/application.errors.js';
import {
  ConcurrencyConflictError,
  PersistenceUnavailableError,
} from '../../application/ports/persistence.errors.js';
import type {
  LogFields,
  LogLevel,
  StructuredLog,
} from '../observability/structured-log.js';

export const HTTP_LOG = Symbol('HTTP_LOG');

const MAX_FIELD_LENGTH = 128;

interface Observation {
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  kind?: string;
  result?: string;
  errorCode?: string;
  idempotentReplay?: boolean;
}

@Injectable()
export class HttpObservabilityInterceptor implements NestInterceptor {
  constructor(@Inject(HTTP_LOG) private readonly log: StructuredLog) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const operation = `${context.getClass().name}.${context.getHandler().name}`;
    const startedAt = performance.now();
    const observation: Observation = requestObservation(request);

    response.once('finish', () => {
      const fields: LogFields = {
        operation,
        method: request.method,
        statusCode: response.statusCode,
        correlationId:
          headerText(response.getHeader('X-Correlation-Id')) ??
          headerText(request.header('x-correlation-id')),
        ...observation,
        durationMs: Math.round(performance.now() - startedAt),
      };
      this.log.write(levelOf(response.statusCode), 'http.request', fields);
    });

    return next.handle().pipe(
      tap((value: unknown) => {
        Object.assign(observation, responseObservation(value));
      }),
      catchError((error: unknown) => {
        observation.errorCode = apiErrorCode(error);
        observation.result = observation.errorCode;
        return throwError(() => error);
      }),
    );
  }
}

export function apiErrorCode(error: unknown): string {
  if (error instanceof ApplicationError) {
    return error.code;
  }
  if (error instanceof ConcurrencyConflictError) {
    return 'CONCURRENCY_CONFLICT';
  }
  if (error instanceof PersistenceUnavailableError) {
    return 'SERVICE_UNAVAILABLE';
  }
  if (error instanceof HttpException) {
    return error.getStatus() >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
  return 'INTERNAL_ERROR';
}

function requestObservation(request: Request): Observation {
  const body: unknown = request.body;
  const params = request.params;
  return {
    transactionId: shortText(params.transactionId),
    walletId: shortText(params.walletId) ?? fieldOf(body, 'walletId'),
    providerId: shortText(params.providerId) ?? fieldOf(body, 'providerId'),
    kind: fieldOf(body, 'kind'),
  };
}

function responseObservation(value: unknown): Observation {
  const observation: Observation = {};
  const transactionId = fieldOf(value, 'transactionId');
  if (transactionId !== undefined) {
    observation.transactionId = transactionId;
  }
  const status = fieldOf(value, 'status');
  if (status !== undefined) {
    observation.result = status;
  }
  if (isRecord(value) && typeof value.idempotentReplay === 'boolean') {
    observation.idempotentReplay = value.idempotentReplay;
  }
  return observation;
}

function fieldOf(value: unknown, key: string): string | undefined {
  return isRecord(value) ? shortText(value[key]) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== ''
    ? value.slice(0, MAX_FIELD_LENGTH)
    : undefined;
}

function headerText(value: unknown): string | undefined {
  return shortText(value);
}

function levelOf(statusCode: number): LogLevel {
  if (statusCode >= 500) {
    return 'error';
  }
  return statusCode >= 400 ? 'warn' : 'info';
}
