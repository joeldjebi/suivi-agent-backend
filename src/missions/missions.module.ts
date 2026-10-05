import { Module } from '@nestjs/common';
import { MissionTypesService } from './mission-types.service';
import {
  MissionsController,
  MissionTypesController,
} from './missions.controller';
import { MissionsService } from './missions.service';

@Module({
  controllers: [MissionTypesController, MissionsController],
  providers: [MissionTypesService, MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
