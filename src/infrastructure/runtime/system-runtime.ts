import type { Clock, IdGenerator } from '../../application/ports/runtime.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
