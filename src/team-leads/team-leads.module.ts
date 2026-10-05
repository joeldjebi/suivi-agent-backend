import { Module } from '@nestjs/common';
import { TeamLeadsController } from './team-leads.controller';
import { TeamLeadsService } from './team-leads.service';

@Module({ controllers: [TeamLeadsController], providers: [TeamLeadsService] })
export class TeamLeadsModule {}
