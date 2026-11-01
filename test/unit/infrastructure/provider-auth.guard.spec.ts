import { describe, expect, it } from 'bun:test';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { ProviderAuthGuard } from '../../../src/infrastructure/http/auth/provider-auth.guard.js';
import { HealthController } from '../../../src/infrastructure/http/health.controller.js';
import { WageringController } from '../../../src/infrastructure/http/wagering.controller.js';
import { WalletsController } from '../../../src/infrastructure/http/wallets.controller.js';

const guardsOf = (target: object): unknown =>
  Reflect.getMetadata(GUARDS_METADATA, target);

describe('ProviderAuthGuard', () => {
  it('is the explicit no-op extension point while authentication is out of scope', () => {
    expect(new ProviderAuthGuard().canActivate()).toBe(true);
  });

  it('guards the financial controllers and leaves health open', () => {
    expect(guardsOf(WageringController)).toEqual([ProviderAuthGuard]);
    expect(guardsOf(WalletsController)).toEqual([ProviderAuthGuard]);
    expect(guardsOf(HealthController)).toBeUndefined();
  });
});
