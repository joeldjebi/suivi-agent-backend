import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module';
import { PayrollModule } from '../payroll/payroll.module';
import { DaysModule } from '../days/days.module';
import { MissionsModule } from '../missions/missions.module';
import { PositionsModule } from '../positions/positions.module';
import { ReportsModule } from '../reports/reports.module';
import { ZoneRequestsModule } from '../zone-requests/zone-requests.module';
import { JobsService } from './jobs.service';

@Module({
  imports: [
    DaysModule,
    MissionsModule,
    OutletsModule,
    PayrollModule,
    PositionsModule,
    ReportsModule,
    ZoneRequestsModule,
  ],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
