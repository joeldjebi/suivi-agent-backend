import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import {
  PlatformLandingController,
  PublicLandingController,
} from './landing.controller';
import { LandingService } from './landing.service';

@Module({
  imports: [PlatformModule],
  controllers: [PublicLandingController, PlatformLandingController],
  providers: [LandingService],
})
export class LandingModule {}
