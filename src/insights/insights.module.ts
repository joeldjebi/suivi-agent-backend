import { Module } from '@nestjs/common';
import { OutletsModule } from '../outlets/outlets.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

@Module({
  imports: [OutletsModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
