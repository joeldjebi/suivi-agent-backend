import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({
  imports: [MissionsModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
