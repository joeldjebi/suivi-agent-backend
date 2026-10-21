import { Module } from '@nestjs/common';
import { AppService } from '../app.service';
import { PlatformModule } from '../platform/platform.module';
import { SupervisionController } from './supervision.controller';
import { SupervisionService } from './supervision.service';

@Module({
  imports: [PlatformModule],
  controllers: [SupervisionController],
  providers: [SupervisionService, AppService],
})
export class SupervisionModule {}
