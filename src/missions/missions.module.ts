import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module';
import { PhotosModule } from '../photos/photos.module';
import { MissionTypesService } from './mission-types.service';
import {
  MissionsController,
  MissionTypesController,
} from './missions.controller';
import { MissionsService } from './missions.service';

@Module({
  imports: [PhotosModule, OutletsModule],
  controllers: [MissionTypesController, MissionsController],
  providers: [MissionTypesService, MissionsService],
  exports: [MissionsService, MissionTypesService],
})
export class MissionsModule {}
