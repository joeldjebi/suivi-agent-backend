import { Injectable } from '@nestjs/common';
import { SocketEvent } from '@suivi/shared';
import { Notification } from '../entities';
import { DbService } from './db.service';
import { PushService } from './push.service';
import { RealtimeService, rooms } from './realtime.service';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

/**
 * Notifications enregistrées en base, poussées en temps réel aux écrans ouverts et envoyées
 * en notification push sur les téléphones (même app fermée).
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
  ) {}

  /**
   * `push: false` : l'appelant envoie lui-même sur les téléphones et suit le résultat
   * (notifications aux équipes). Rend les notifications enregistrées.
   */
  async notify(
    userIds: string[],
    input: NotificationInput,
    options: { push?: boolean } = {},
  ): Promise<Notification[]> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return [];
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
      // Push : une fois les données enregistrées, sans retarder la requête.
      if (options.push !== false)
        void this.push.sendToUsers(tenantId, unique, {
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data,
        });
    });
    return saved;
  }
}
