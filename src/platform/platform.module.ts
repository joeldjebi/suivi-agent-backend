import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from '../auth/auth.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PlatformJwtStrategy } from './platform-auth';
import {
  PlatformAuthController,
  PlatformController,
} from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformTenantService } from './platform-tenant.service';
import { LoginThrottle, PlatformIpGuard } from './platform-security';

@Module({
  imports: [PassportModule, AuthModule, SubscriptionsModule],
  controllers: [PlatformAuthController, PlatformController],
  providers: [
    PlatformService,
    PlatformTenantService,
    PlatformJwtStrategy,
    PlatformIpGuard,
    LoginThrottle,
  ],
})
export class PlatformModule {}
