import { Module } from '@nestjs/common';
import { LiveService } from './live.service';
import { PositionsController } from './positions.controller';
import { PositionsService } from './positions.service';

@Module({
  controllers: [PositionsController],
  providers: [LiveService, PositionsService],
  exports: [LiveService, PositionsService],
})
export class PositionsModule {}
