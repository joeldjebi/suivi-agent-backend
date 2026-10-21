import { Injectable } from '@nestjs/common';
import { Feature, type LandingContent } from '@suivi/shared';
import { randomBytes, randomInt } from 'node:crypto';
import { hashPassword } from '../auth/auth.service';
import { conflict, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { RedisService } from '../common/redis.service';
import { SessionRevocationService } from '../common/session-revocation.service';
import { DEFAULT_LANDING } from '../landing/landing.defaults';
import { normalizeFooter } from '../landing/landing.sanitize';
import type { PlatformUser } from '../platform/platform-auth';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type {
  PresentationContentDto,
  SavePresentationDto,
} from './presentations.dto';
import { createDemoStructure } from './demo-structure';

export type PresentationContent = PresentationContentDto;

/** Lien de partage : 32 octets aléatoires en base64url (43 caractères). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const COLUMNS = `p.id, p.content, p.tenant_id AS "tenantId", t.name AS "tenantName",
  p.share_token AS "shareToken", p.shared_at AS "sharedAt", p.view_count AS "viewCount",
  p.last_viewed_at AS "lastViewedAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  CASE WHEN pa.id IS NULL THEN NULL ELSE pa.first_name || ' ' || pa.last_name END AS "createdByName",
  p.demo_tenant_id AS "demoTenantId", d.name AS "demoTenantName", p.demo_admin_email AS "demoAdminEmail",
  p.demo_created_at AS "demoCreatedAt"`;
const FROM = `FROM client_presentations p
  LEFT JOIN tenants t ON t.id = p.tenant_id
  LEFT JOIN tenants d ON d.id = p.demo_tenant_id
  LEFT JOIN platform_admins pa ON pa.id = p.created_by`;

/**
 * Présentations clients de la console éditeur : un modèle unique (diaporama, fiches par
 * rôle, déroulé, liste de démarrage) personnalisé par les informations de chaque client.
 */
@Injectable()
export class PresentationsService {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
    private readonly redis: RedisService,
    private readonly revocation: SessionRevocationService,
  ) {}

  /**
   * Coupe toutes les sessions des comptes d'une structure de démo : jetons de
   * renouvellement révoqués tout de suite, jetons d'accès refusés après validation (401,
   * l'app revient à la connexion) et connexions en direct fermées.
   */
  private async couperSessions(tenantId: string) {
    const users = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM users WHERE tenant_id = $1`,
      [tenantId],
    );
    await this.db.manager.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`,
      [tenantId],
    );
    this.db.afterCommit(() => {
      for (const { id } of users) void this.revocation.revoke(id);
    });
  }

  private log(
    admin: PlatformUser,
    action: string,
    tenantId: string | null,
    details: object = {},
  ) {
    return this.db.manager.query(
      `INSERT INTO platform_audit (admin_id, action, tenant_id, details) VALUES ($1, $2, $3, $4)`,
      [admin.id, action, tenantId, JSON.stringify(details)],
    );
  }

  private async adminFirstName(admin: PlatformUser) {
    const [row] = await this.db.manager.query<{ firstName: string }[]>(
      `SELECT first_name AS "firstName" FROM platform_admins WHERE id = $1`,
      [admin.id],
    );
    return row?.firstName ?? '';
  }

  async list() {
    return this.db.manager.query<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} ${FROM} ORDER BY p.updated_at DESC`,
    );
  }

  async get(id: string) {
    const [row] = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} ${FROM} WHERE p.id = $1`,
      [id],
    );
    if (!row) throw notFound('Présentation');
    return row;
  }

  /**
   * Valeurs de départ du formulaire : contacts d'assistance du site, et, pour une structure
   * existante, son nom, ses zones, ses effectifs, ses produits, ses fonctions et sa couleur.
   */
  async defaults(admin: PlatformUser, tenantId?: string) {
    const [landing] = await this.db.manager.query<
      { published: LandingContent | null }[]
    >(`SELECT published FROM landing_pages WHERE id = 1`);
    const { footer } = normalizeFooter(landing?.published ?? DEFAULT_LANDING);
    const content: PresentationContent = {
      clientName: '',
      trade: '',
      city: 'Abidjan',
      areas: [],
      agents: 10,
      leads: 2,
      products: [],
      outletWord: 'points de vente',
      modules: { missions: true, outlets: true, orders: true, pay: true },
      agentName: 'Koffi',
      presenter: await this.adminFirstName(admin),
      meetingDate: null,
      color: '#2563EB',
      supportEmail: footer.emails[0] ?? '',
      supportPhone: footer.phones[0] ?? '',
    };
    if (!tenantId) return content;

    const m = this.db.manager;
    const [tenant] = await m.query<
      { name: string; displayName: string | null; color: string | null }[]
    >(
      `SELECT t.name, b.display_name AS "displayName", b.primary_color AS color
       FROM tenants t LEFT JOIN tenant_branding b ON b.tenant_id = t.id WHERE t.id = $1`,
      [tenantId],
    );
    if (!tenant) throw notFound('Structure');
    const [counts] = await m.query<{ agents: number; leads: number }[]>(
      `SELECT count(*) FILTER (WHERE role = 'agent')::int AS agents,
              count(*) FILTER (WHERE role = 'team_lead')::int AS leads
       FROM users WHERE tenant_id = $1 AND is_active`,
      [tenantId],
    );
    const zones = await m.query<{ name: string }[]>(
      `SELECT name FROM zones WHERE tenant_id = $1 AND is_active ORDER BY name LIMIT 12`,
      [tenantId],
    );
    const products = await m.query<{ name: string }[]>(
      `SELECT name FROM products WHERE tenant_id = $1 AND is_active ORDER BY name LIMIT 10`,
      [tenantId],
    );
    const { features } = await this.subscriptions.summary(tenantId);
    return {
      ...content,
      clientName: (tenant.displayName || tenant.name).slice(0, 80),
      areas: zones.map((z) => z.name.slice(0, 40)),
      agents: counts.agents || content.agents,
      leads: counts.leads || content.leads,
      products: products.map((p) => p.name.slice(0, 60)),
      modules: {
        missions: features.includes(Feature.Missions),
        outlets: features.includes(Feature.PointsOfSale),
        orders: features.includes(Feature.Orders),
        pay: features.includes(Feature.Payroll),
      },
      color: (tenant.color ?? content.color).toUpperCase(),
    };
  }

  private async assertTenant(tenantId: string | null | undefined) {
    if (!tenantId) return;
    const [found] = await this.db.manager.query<unknown[]>(
      `SELECT 1 FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (!found) throw notFound('Structure');
  }

  async create(admin: PlatformUser, dto: SavePresentationDto) {
    await this.assertTenant(dto.tenantId);
    const [{ id }] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO client_presentations (content, tenant_id, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [JSON.stringify(dto.content), dto.tenantId ?? null, admin.id],
    );
    await this.log(admin, 'presentation.create', dto.tenantId ?? null, {
      clientName: dto.content.clientName,
    });
    return this.get(id);
  }

  async update(admin: PlatformUser, id: string, dto: SavePresentationDto) {
    await this.get(id);
    await this.assertTenant(dto.tenantId);
    await this.db.manager.query(
      `UPDATE client_presentations
       SET content = $2, tenant_id = CASE WHEN $4 THEN $3::uuid ELSE tenant_id END, updated_at = now()
       WHERE id = $1`,
      [
        id,
        JSON.stringify(dto.content),
        dto.tenantId ?? null,
        dto.tenantId !== undefined,
      ],
    );
    return this.get(id);
  }

  async remove(admin: PlatformUser, id: string) {
    const row = await this.get(id);
    await this.db.manager.query(
      `DELETE FROM client_presentations WHERE id = $1`,
      [id],
    );
    await this.log(
      admin,
      'presentation.delete',
      (row.tenantId as string | null) ?? null,
      { clientName: (row.content as PresentationContent).clientName },
    );
  }

  /** Active le lien de partage (le même tant qu'il n'est pas retiré). */
  async share(admin: PlatformUser, id: string) {
    const row = await this.get(id);
    if (row.shareToken) return row;
    await this.db.manager.query(
      `UPDATE client_presentations SET share_token = $2, shared_at = now() WHERE id = $1`,
      [id, randomBytes(32).toString('base64url')],
    );
    await this.log(
      admin,
      'presentation.share',
      (row.tenantId as string | null) ?? null,
      { clientName: (row.content as PresentationContent).clientName },
    );
    return this.get(id);
  }

  /** Retire le lien : l'ancien ne fonctionne plus, un nouveau partage en crée un autre. */
  async unshare(admin: PlatformUser, id: string) {
    const row = await this.get(id);
    await this.db.manager.query(
      `UPDATE client_presentations SET share_token = NULL, shared_at = NULL WHERE id = $1`,
      [id],
    );
    await this.log(
      admin,
      'presentation.unshare',
      (row.tenantId as string | null) ?? null,
      { clientName: (row.content as PresentationContent).clientName },
    );
    return this.get(id);
  }

  // ------------------------------------------------------- structure de démo

  /** Mot de passe lisible, commun à tous les comptes de la démo. */
  private demoPassword() {
    return `Demo-${randomBytes(3).toString('hex')}-${randomInt(100, 1000)}`;
  }

  /** Bloc de numéros libre : « 0798 » + 4 chiffres, puis le rang du compte. */
  private async freePhoneBlock() {
    for (let i = 0; i < 20; i++) {
      const block = `0798${String(randomInt(0, 10000)).padStart(4, '0')}`;
      const [taken] = await this.db.manager.query<unknown[]>(
        `SELECT 1 FROM users WHERE phone LIKE $1 LIMIT 1`,
        [`+225${block}%`],
      );
      if (!taken) return block;
    }
    throw conflict('DEMO_PHONES', 'Aucun bloc de numéros libre, réessayez');
  }

  /**
   * Crée la structure de démonstration du client : son nom, sa couleur, ses quartiers, ses
   * produits, une équipe à sa taille et quelques jours d'activité. Le mot de passe des
   * comptes n'est montré qu'ici (et à chaque réinitialisation).
   */
  async createDemo(admin: PlatformUser, id: string) {
    const row = await this.get(id);
    if (row.demoTenantId)
      throw conflict(
        'DEMO_EXISTS',
        'Cette présentation a déjà sa structure de démo : supprimez-la pour la recréer',
      );
    const content = row.content as PresentationContent;
    const code = randomBytes(3).toString('hex');
    const password = this.demoPassword();
    const [{ id: tenantId }] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO tenants (name, notes) VALUES ($1, $2) RETURNING id`,
      [
        `${content.clientName} · Démo`.slice(0, 120),
        `Structure de démonstration créée depuis la présentation de ${content.clientName}.`,
      ],
    );
    const result = await createDemoStructure(
      this.db.manager,
      this.redis.client,
      {
        tenantId,
        code,
        content,
        passwordHash: await hashPassword(password),
        phoneBlock: await this.freePhoneBlock(),
      },
    );
    const adminEmail = result.accounts[0].email;
    await this.db.manager.query(
      `UPDATE client_presentations SET demo_tenant_id = $2, demo_admin_email = $3, demo_created_at = now() WHERE id = $1`,
      [id, tenantId, adminEmail],
    );
    await this.log(admin, 'presentation.demo.create', tenantId, {
      clientName: content.clientName,
    });
    return {
      presentation: await this.get(id),
      password,
      accounts: result.accounts,
      activity: {
        zones: result.zones,
        days: result.days,
        positions: result.positions,
        submissions: result.submissions,
      },
    };
  }

  /** Comptes de la structure de démo (sans mot de passe). */
  async demo(id: string) {
    const row = await this.get(id);
    if (!row.demoTenantId) throw notFound('Structure de démo');
    const accounts = await this.db.manager.query<Record<string, unknown>[]>(
      `SELECT u.role, u.first_name || ' ' || u.last_name AS name, u.email, u.phone, g.name AS "group"
       FROM users u LEFT JOIN groups g ON g.id = coalesce(u.group_id, (SELECT id FROM groups WHERE leader_id = u.id LIMIT 1))
       WHERE u.tenant_id = $1
       ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'team_lead' THEN 1 ELSE 2 END, u.phone NULLS FIRST`,
      [row.demoTenantId],
    );
    return { tenantId: row.demoTenantId, accounts };
  }

  /** Nouveau mot de passe pour tous les comptes de la démo (oublié, ou après une démo). */
  async resetDemoPassword(admin: PlatformUser, id: string) {
    const row = await this.get(id);
    if (!row.demoTenantId) throw notFound('Structure de démo');
    const password = this.demoPassword();
    await this.db.manager.query(
      `UPDATE users SET password_hash = $2 WHERE tenant_id = $1`,
      [row.demoTenantId, await hashPassword(password)],
    );
    // Comme pour un changement de mot de passe : les sessions ouvertes avant sont coupées.
    await this.couperSessions(row.demoTenantId as string);
    await this.log(
      admin,
      'presentation.demo.password',
      row.demoTenantId as string,
    );
    return { password, ...(await this.demo(id)) };
  }

  /** Supprime la structure de démo et toutes ses données. */
  async deleteDemo(admin: PlatformUser, id: string) {
    const row = await this.get(id);
    const tenantId = row.demoTenantId as string | null;
    if (!tenantId) throw notFound('Structure de démo');
    await this.couperSessions(tenantId);
    await this.db.manager.query(`DELETE FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    await this.db.manager.query(
      `UPDATE client_presentations SET demo_admin_email = NULL, demo_created_at = NULL WHERE id = $1`,
      [id],
    );
    this.db.afterCommit(() => {
      void this.redis.client.del(`live:${tenantId}`);
    });
    await this.log(admin, 'presentation.demo.delete', null, {
      clientName: (row.content as PresentationContent).clientName,
    });
    return this.get(id);
  }

  /** Présentation ouverte par son lien de partage : seulement son contenu. */
  async shared(token: string) {
    if (!TOKEN.test(token)) throw notFound('Présentation');
    const [row] = await this.db.manager.query<
      { content: PresentationContent; updatedAt: Date }[]
    >(
      `WITH opened AS (
         UPDATE client_presentations SET view_count = view_count + 1, last_viewed_at = now()
         WHERE share_token = $1 RETURNING content, updated_at)
       SELECT content, updated_at AS "updatedAt" FROM opened`,
      [token],
    );
    if (!row) throw notFound('Présentation');
    return row;
  }
}
