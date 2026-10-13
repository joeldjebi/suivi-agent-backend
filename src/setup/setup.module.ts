import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UsersModule } from '../users/users.module';
import { ZonesModule } from '../zones/zones.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [ZonesModule, MissionsModule, UsersModule, SubscriptionsModule],
  controllers: [SetupController],
  providers: [SetupService],
})
export class SetupModule {}
