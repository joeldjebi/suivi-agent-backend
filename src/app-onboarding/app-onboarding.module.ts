import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import {
  PlatformAppOnboardingController,
  PublicAppOnboardingController,
} from './app-onboarding.controller';
import { AppOnboardingService } from './app-onboarding.service';

@Module({
  imports: [PlatformModule],
  controllers: [PublicAppOnboardingController, PlatformAppOnboardingController],
  providers: [AppOnboardingService],
})
export class AppOnboardingModule {}
