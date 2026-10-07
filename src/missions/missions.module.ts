import { Module } from '@nestjs/common';
import { PhotosModule } from '../photos/photos.module';
import { MissionTypesService } from './mission-types.service';
import {
  MissionsController,
  MissionTypesController,
} from './missions.controller';
import { MissionsService } from './missions.service';

@Module({
  imports: [PhotosModule],
  controllers: [MissionTypesController, MissionsController],
  providers: [MissionTypesService, MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
