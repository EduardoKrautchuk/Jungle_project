import { Injectable, type CanActivate } from '@nestjs/common';

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
