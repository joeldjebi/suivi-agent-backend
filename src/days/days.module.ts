import { Module } from '@nestjs/common';
import { PositionsModule } from '../positions/positions.module';
import { ZoneRequestsModule } from '../zone-requests/zone-requests.module';
import { DaysController } from './days.controller';
import { DaysService } from './days.service';

@Module({
  imports: [PositionsModule, ZoneRequestsModule],
  controllers: [DaysController],
  providers: [DaysService],
  exports: [DaysService],
})
export class DaysModule {}
