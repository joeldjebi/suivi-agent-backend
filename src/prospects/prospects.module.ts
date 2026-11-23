import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { ProspectsController } from './prospects.controller';
import { ProspectsService } from './prospects.service';

@Module({
  imports: [PlatformModule],
  controllers: [ProspectsController],
  providers: [ProspectsService],
})
export class ProspectsModule {}
