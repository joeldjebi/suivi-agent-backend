import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { PlatformVideoController, PublicVideoController } from './video.controller';
import { VideoService } from './video.service';

@Module({
  imports: [PlatformModule],
  controllers: [PublicVideoController, PlatformVideoController],
  providers: [VideoService],
})
export class VideoModule {}
