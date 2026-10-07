import { Module } from '@nestjs/common';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';

@Module({
  controllers: [BroadcastsController],
  providers: [BroadcastsService],
})
export class BroadcastsModule {}
