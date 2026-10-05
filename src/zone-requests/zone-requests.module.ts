import { Module } from '@nestjs/common';
import { ZonesModule } from '../zones/zones.module';
import { ZoneRequestsController } from './zone-requests.controller';
import { ZoneRequestsService } from './zone-requests.service';

@Module({
  imports: [ZonesModule],
  controllers: [ZoneRequestsController],
  providers: [ZoneRequestsService],
  exports: [ZoneRequestsService],
})
export class ZoneRequestsModule {}
