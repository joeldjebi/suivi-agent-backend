import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { Feature } from '@suivi/shared';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { DbService } from './db.service';

type MulticastMessage = import('firebase-admin/messaging').MulticastMessage;

/** Notification à afficher sur le téléphone (titre, texte) et données pour l'app. */
export interface PushMessage {
  title: string;
  body?: string | null;
  /** Type de notification (zone_request.created…) : l'app ouvre le bon écran */
  type: string;
  data?: Record<string, unknown>;
}

/** Envoi refusé pour un téléphone (code Firebase, ex. messaging/third-party-auth-error). */
export interface PushFailure {
  token?: string;
  platform: string;
  code: string;
  message: string;
}

/** Envoi effectif ; renvoie les jetons à oublier (application désinstallée…) et les refus. */
export interface PushTransport {
  send(
    tokens: { token: string; platform: string }[],
    message: PushMessage,
  ): Promise<{ invalid: string[]; failures?: PushFailure[] }>;
}

/** Résultat de l'envoi pour une personne. */
export interface PushDelivery {
  status: 'sent' | 'failed' | 'no_device';
  code?: string;
}

/** Explication des refus courants, pour le journal du serveur. */
const FAILURE_HINTS: Record<string, string> = {
  'messaging/third-party-auth-error':
    'Apple refuse la clé APNs (clé révoquée, mauvais Key ID ou Team ID, ou clé de développement/production inversée)',
  'messaging/registration-token-not-registered':
    'téléphone désinscrit (app désinstallée ou jeton périmé) : jeton oublié',
  'messaging/invalid-registration-token': 'jeton invalide : jeton oublié',
  'messaging/mismatched-credential':
    'le jeton appartient à un autre projet Firebase que la clé du serveur',
  'messaging/invalid-argument': 'message refusé (contenu ou jeton mal formé)',
  'messaging/quota-exceeded': 'quota Firebase dépassé',
};

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

/** Adresse de la version web : ouverte au toucher d'une notification du navigateur. */
const WEB_APP_URL = (
  process.env.WEB_APP_URL ?? 'https://app.performx.online'
).replace(/\/$/, '');

/** Firebase Cloud Messaging (Android et iPhone, via la clé APNs du projet Firebase). */
export class FirebaseTransport implements PushTransport {
  constructor(
    private readonly messaging: import('firebase-admin/messaging').Messaging,
  ) {}

  async send(
    tokens: { token: string; platform: string }[],
    message: PushMessage,
  ) {
    const data = stringify({ ...(message.data ?? {}), type: message.type });
    const category = PUSH_CATEGORIES[message.type];
    // Android n'affiche pas de boutons sur une notification envoyée telle quelle : les
    // notifications à boutons partent en données, l'app les affiche elle-même.
    const actionable = category
      ? tokens.filter((t) => t.platform === 'android')
      : [];
    const standard = tokens.filter((t) => !actionable.includes(t));
    const batches: { tokens: typeof tokens; message: MulticastMessage }[] = [];
    if (standard.length)
      batches.push({
        tokens: standard,
        message: {
          tokens: standard.map((t) => t.token),
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
          // Version web : icône de l'app, et le toucher ouvre l'app.
          webpush: {
            notification: { icon: `${WEB_APP_URL}/icons/Icon-192.png` },
            fcmOptions: { link: WEB_APP_URL },
          },
        },
      });
    if (actionable.length)
      batches.push({
        tokens: actionable,
        message: {
          tokens: actionable.map((t) => t.token),
          data: {
            ...data,
            title: message.title,
            ...(message.body ? { body: message.body } : {}),
            category: category,
          },
          android: { priority: 'high' },
        },
      });
    const invalid: string[] = [];
    const failures: PushFailure[] = [];
    for (const batch of batches) {
      const response = await this.messaging.sendEachForMulticast(batch.message);
      response.responses.forEach((r, i) => {
        if (!r.error) return;
        const code = r.error.code ?? 'inconnu';
        failures.push({
          token: batch.tokens[i].token,
          platform: batch.tokens[i].platform,
          code,
          message: r.error.message ?? '',
        });
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        )
          invalid.push(batch.tokens[i].token);
      });
    }
    return { invalid, failures };
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
    private readonly subscriptions: SubscriptionsService,
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

  /** Refus regroupés par plateforme et code : « 1 iPhone sur 3 — Apple refuse la clé… ». */
  private logFailures(type: string, total: number, failures: PushFailure[]) {
    const groups = new Map<string, PushFailure[]>();
    for (const f of failures) {
      const key = `${f.platform} ${f.code}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const [, list] of groups) {
      const { platform, code, message } = list[0];
      const device =
        platform === 'ios'
          ? 'iPhone'
          : platform === 'web'
            ? 'navigateur'
            : 'Android';
      this.logger.warn(
        `Push « ${type} » refusé pour ${list.length} ${device} sur ${total} téléphone(s) : ${code}` +
          ` — ${FAILURE_HINTS[code] ?? message}`,
      );
    }
  }

  get enabled() {
    return this.transport !== null;
  }

  /** Envoi sans suivi (notifications ordinaires de l'app) ; les erreurs vont au journal. */
  async sendToUsers(
    tenantId: string,
    userIds: string[],
    message: PushMessage,
  ): Promise<void> {
    await this.deliver(tenantId, userIds, message);
  }

  /**
   * Envoi aux téléphones de ces utilisateurs, si la formule de leur structure inclut les
   * notifications push (sauf avis sur l'abonnement lui-même, toujours envoyés) ; les jetons
   * périmés sont oubliés. Rend le résultat par personne : envoyé si au moins un de ses
   * téléphones l'a accepté, sinon échec (code du refus) ou pas de téléphone.
   */
  async deliver(
    tenantId: string,
    userIds: string[],
    message: PushMessage,
  ): Promise<Map<string, PushDelivery>> {
    const result = new Map<string, PushDelivery>();
    const transport = this.transport;
    if (!userIds.length) return result;
    const fail = (code: string) => {
      for (const id of userIds) result.set(id, { status: 'failed', code });
      return result;
    };
    if (!transport) return fail('push_unavailable');
    try {
      const billing =
        message.type.startsWith('subscription.') ||
        message.type.startsWith('invoice.');
      if (!billing) {
        const { features } = await this.subscriptions.summary(tenantId);
        if (!features.includes(Feature.PushNotifications))
          return fail('push_not_in_plan');
      }
      const tokens = await this.db.runAsSystem(() =>
        this.db.manager.query<
          { token: string; platform: string; userId: string }[]
        >(
          `SELECT token, platform, user_id AS "userId" FROM push_devices WHERE user_id = ANY($1)`,
          [userIds],
        ),
      );
      for (const id of userIds) result.set(id, { status: 'no_device' });
      if (!tokens.length) return result;
      const { invalid, failures = [] } = await transport.send(tokens, message);
      this.logFailures(message.type, tokens.length, failures);
      const failed = new Map(failures.map((f) => [f.token, f.code]));
      for (const t of tokens) {
        const code = failed.get(t.token);
        const current = result.get(t.userId)!;
        if (code === undefined) result.set(t.userId, { status: 'sent' });
        else if (current.status !== 'sent')
          result.set(t.userId, { status: 'failed', code });
      }
      if (invalid.length)
        await this.db.runAsSystem(() =>
          this.db.manager.query(
            `DELETE FROM push_devices WHERE token = ANY($1)`,
            [invalid],
          ),
        );
      return result;
    } catch (error) {
      this.logger.warn(`Envoi push échoué : ${(error as Error).message}`);
      return fail('send_error');
    }
  }
}
