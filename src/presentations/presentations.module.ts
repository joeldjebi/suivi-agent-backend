import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import {
  PlatformPresentationsController,
  PublicPresentationsController,
} from './presentations.controller';
import { PresentationsService } from './presentations.service';

@Module({
  imports: [PlatformModule, SubscriptionsModule],
  controllers: [PublicPresentationsController, PlatformPresentationsController],
  providers: [PresentationsService],
})
export class PresentationsModule {}
