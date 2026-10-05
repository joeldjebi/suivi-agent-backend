import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import {
  PlatformSupportController,
  SupportController,
} from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [PlatformModule],
  controllers: [SupportController, PlatformSupportController],
  providers: [SupportService],
})
export class SupportModule {}
