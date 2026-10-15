import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module';
import { FormStatsController } from './form-stats.controller';
import { FormStatsService } from './form-stats.service';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({
  imports: [OutletsModule],
  controllers: [InsightsController, FormStatsController],
  providers: [InsightsService, FormStatsService],
})
export class InsightsModule {}
