import { Injectable } from '@nestjs/common';
import { SocketEvent } from '@suivi/shared';
import { Notification } from '../entities';
import { DbService } from './db.service';
import { RealtimeService, rooms } from './realtime.service';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

/**
 * Notifications enregistrées en base et poussées en temps réel.
 * L'envoi push (Firebase Cloud Messaging) sera branché ici avec l'app mobile.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  async notify(userIds: string[], input: NotificationInput): Promise<void> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return;
    const tenantId = this.db.tenantId;
    const saved = await this.db.manager.save(
      Notification,
      unique.map((userId) => ({
        tenantId,
        userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        data: input.data ?? {},
      })),
    );
    this.db.afterCommit(() => {
      for (const notification of saved) {
        this.realtime.emit(
          [rooms.user(notification.userId)],
          SocketEvent.Notification,
          notification,
        );
      }
    });
  }
}
