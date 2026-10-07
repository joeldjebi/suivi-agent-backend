import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { DbService } from './db.service';

/** Notification à afficher sur le téléphone (titre, texte) et données pour l'app. */
export interface PushMessage {
  title: string;
  body?: string | null;
  /** Type de notification (zone_request.created…) : l'app ouvre le bon écran */
  type: string;
  data?: Record<string, unknown>;
}

/** Envoi effectif ; renvoie les jetons à oublier (application désinstallée…). */
export interface PushTransport {
  send(
    tokens: { token: string; platform: string }[],
    message: PushMessage,
  ): Promise<{ invalid: string[] }>;
}

/** Catégorie iOS des notifications qui portent des boutons d'action. */
export const PUSH_CATEGORIES: Record<string, string> = {
  'zone_request.created': 'ZONE_REQUEST',
  'zone_request.reminder': 'ZONE_REQUEST',
};

/** Les données FCM sont des chaînes. */
function stringify(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

/** Firebase Cloud Messaging (Android et iPhone, via la clé APNs du projet Firebase). */
class FirebaseTransport implements PushTransport {
  constructor(
    private readonly messaging: import('firebase-admin/messaging').Messaging,
  ) {}

  async send(
    tokens: { token: string; platform: string }[],
    message: PushMessage,
  ) {
    const data = stringify({ ...(message.data ?? {}), type: message.type });
    const category = PUSH_CATEGORIES[message.type];
    const response = await this.messaging.sendEachForMulticast({
      tokens: tokens.map((t) => t.token),
      notification: {
        title: message.title,
        ...(message.body ? { body: message.body } : {}),
      },
      data,
      android: {
        priority: 'high',
        notification: { channelId: 'suivi_agent', sound: 'default' },
      },
      apns: {
        payload: {
          aps: { sound: 'default', ...(category ? { category } : {}) },
        },
      },
    });
    const invalid: string[] = [];
    response.responses.forEach((r, i) => {
      const code = r.error?.code ?? '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      )
        invalid.push(tokens[i].token);
    });
    return { invalid };
  }
}

/**
 * Notifications push : chaque notification de l'app est aussi envoyée sur les téléphones
 * de ses destinataires, même app fermée. Sans clé Firebase (FIREBASE_SERVICE_ACCOUNT_FILE
 * ou FIREBASE_SERVICE_ACCOUNT), l'envoi est simplement désactivé.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);

  /** Remplaçable dans les tests. */
  transport: PushTransport | null = null;

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const file = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT_FILE');
    const inline = this.config.get<string>('FIREBASE_SERVICE_ACCOUNT');
    if (!file && !inline) {
      this.logger.log('Notifications push désactivées (aucune clé Firebase)');
      return;
    }
    try {
      const credentials = JSON.parse(
        inline ?? readFileSync(file!, 'utf8'),
      ) as Record<string, string>;
      const { cert, getApps, initializeApp } =
        await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');
      const app =
        getApps().find((a) => a.name === 'suivi-agent') ??
        initializeApp({ credential: cert(credentials) }, 'suivi-agent');
      this.transport = new FirebaseTransport(getMessaging(app));
      this.logger.log(
        `Notifications push activées (projet ${credentials.project_id})`,
      );
    } catch (error) {
      this.logger.error(
        `Clé Firebase illisible : notifications push désactivées (${(error as Error).message})`,
      );
    }
  }

  get enabled() {
    return this.transport !== null;
  }

  /** Envoi aux téléphones de ces utilisateurs ; les jetons périmés sont oubliés. */
  async sendToUsers(userIds: string[], message: PushMessage): Promise<void> {
    const transport = this.transport;
    if (!transport || !userIds.length) return;
    try {
      const tokens = await this.db.runAsSystem(() =>
        this.db.manager.query<{ token: string; platform: string }[]>(
          `SELECT token, platform FROM push_devices WHERE user_id = ANY($1)`,
          [userIds],
        ),
      );
      if (!tokens.length) return;
      const { invalid } = await transport.send(tokens, message);
      if (invalid.length)
        await this.db.runAsSystem(() =>
          this.db.manager.query(
            `DELETE FROM push_devices WHERE token = ANY($1)`,
            [invalid],
          ),
        );
    } catch (error) {
      this.logger.warn(`Envoi push échoué : ${(error as Error).message}`);
    }
  }
}
