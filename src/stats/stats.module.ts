import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [MissionsModule],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
