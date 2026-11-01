import {
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { AppModule } from '../../../src/app.module.js';

class CrashAfterCommitInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const crash = request.header('x-test-crash-after-commit') === '1';
    return next.handle().pipe(
      tap(() => {
        if (crash) {
          process.stdout.write('CRASHING after-commit-before-response\n');
          process.kill(process.pid, 'SIGKILL');
        }
      }),
    );
  }
}

const app = await NestFactory.create(AppModule.forRoot('test'), {
  logger: ['error'],
});
app.useGlobalInterceptors(new CrashAfterCommitInterceptor());
app.enableShutdownHooks();
await app.listen(0, '127.0.0.1');
process.stdout.write(`READY ${await app.getUrl()}\n`);
