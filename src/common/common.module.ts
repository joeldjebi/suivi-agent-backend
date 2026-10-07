import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { AlertsService } from './alerts.service';
import { DbService } from './db.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';
import { RedisService } from './redis.service';
import { SessionRevocationService } from './session-revocation.service';
import { ZoneExitsService } from './zone-exits.service';

@Global()
@Module({
  providers: [
    AlertsService,
    SessionRevocationService,
    AccessService,
    DbService,
    NotificationsService,
    PushService,
    RealtimeService,
    RedisService,
    ZoneExitsService,
  ],
  exports: [
    AlertsService,
    SessionRevocationService,
    AccessService,
    DbService,
    NotificationsService,
    PushService,
    RealtimeService,
    RedisService,
    ZoneExitsService,
  ],
})
export class CommonModule {}
