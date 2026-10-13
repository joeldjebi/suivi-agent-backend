import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module';
import { ZonesController } from './zones.controller';
import { PlacesService } from './places.service';
import { ZonesService } from './zones.service';

@Module({
  imports: [MissionsModule],
  controllers: [ZonesController],
  providers: [ZonesService, PlacesService],
  exports: [ZonesService],
})
export class ZonesModule {}
