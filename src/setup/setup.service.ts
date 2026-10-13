import { Injectable } from '@nestjs/common';
import { Feature, ProgressMethod, Role } from '@suivi/shared';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/auth-user';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { MissionTypesService } from '../missions/mission-types.service';
import { MissionsService } from '../missions/missions.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsersService } from '../users/users.service';
import { ZonesService } from '../zones/zones.service';
import {
  ACTIVITIES,
  AREA_BY_KEY,
  CITIES,
  circle,
  type Area,
} from './setup.catalog';
import type { ApplySetupDto } from './setup.dto';

export interface SetupResult {
  zones: { created: string[]; skipped: { name: string; reason: string }[] };
  missionTypes: string[];
  missions: string[];
  agents: {
    created: { name: string; phone: string }[];
    skipped: { name: string; reason: string }[];
  };
  agentPassword: string | null;
}

/**
 * Assistant de démarrage : en trois réponses (métier, communes, agents), la structure est
 * prête : zones, formulaires adaptés au métier, première mission de la semaine et comptes
 * des agents. Chaque élément est créé à part : un refus (numéro déjà pris, zone qui
 * chevauche) n'empêche pas les autres.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly db: DbService,
    private readonly zones: ZonesService,
    private readonly types: MissionTypesService,
    private readonly missions: MissionsService,
    private readonly users: UsersService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  catalog() {
    return {
      activities: ACTIVITIES.map((a) => ({
        key: a.key,
        label: a.label,
        description: a.description,
        examples: a.examples,
        fields: a.missionTypes[0].fields.map((f) => ({
          label: f.label,
          type: f.type,
        })),
      })),
      cities: CITIES,
    };
  }

  /** L'assistant s'ouvre tant que la structure est vide et qu'il n'a été ni fait ni ignoré. */
  async status() {
    const [row] = await this.db.manager.query<
      {
        zones: boolean;
        types: boolean;
        agents: boolean;
        wizard: string | null;
      }[]
    >(
      `SELECT EXISTS (SELECT 1 FROM zones) AS zones,
              EXISTS (SELECT 1 FROM mission_types) AS types,
              EXISTS (SELECT 1 FROM users WHERE role = 'agent') AS agents,
              (SELECT onboarding->>'wizard' FROM tenant_settings) AS wizard`,
    );
    return {
      suggested: !row.wizard && !row.zones && !row.types,
      done: row.wizard === 'done',
      hasZones: row.zones,
      hasAgents: row.agents,
    };
  }

  /** Masque l'assistant (« Je configurerai plus tard »). */
  async skip() {
    await this.mark('skipped');
    return this.status();
  }

  private async mark(state: 'done' | 'skipped') {
    await this.db.manager.query(
      `UPDATE tenant_settings
       SET onboarding = coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('wizard', $1::text)
       WHERE tenant_id = $2`,
      [state, this.db.tenantId],
    );
  }

  /** Tente une création : un échec annule cette seule étape (point de sauvegarde). */
  private async attempt<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const m = this.db.manager;
    const savepoint = `setup_${randomUUID().replace(/-/g, '')}`;
    await m.query(`SAVEPOINT ${savepoint}`);
    try {
      const value = await fn();
      await m.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { ok: true, value };
    } catch (error) {
      await m.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      const response = (
        error as { getResponse?: () => unknown }
      ).getResponse?.();
      const reason =
        (response as { message?: string } | undefined)?.message ??
        (error as Error).message;
      return { ok: false, reason: String(reason) };
    }
  }

  async apply(user: AuthUser, dto: ApplySetupDto): Promise<SetupResult> {
    const activities = ACTIVITIES.filter((a) => dto.activities.includes(a.key));
    const { features } = await this.subscriptions.summary(this.db.tenantId);
    const result: SetupResult = {
      zones: { created: [], skipped: [] },
      missionTypes: [],
      missions: [],
      agents: { created: [], skipped: [] },
      agentPassword: null,
    };

    // 1. Zones : communes du catalogue et secteurs choisis sur la carte.
    const wanted: { name: string; area: Area }[] = [];
    for (const key of new Set(dto.areaKeys)) {
      const area = AREA_BY_KEY.get(key);
      if (!area) throw badRequest('UNKNOWN_AREA', `Commune inconnue : ${key}`);
      wanted.push({ name: area.name, area: area.area });
    }
    for (const c of dto.customAreas ?? [])
      wanted.push({
        name: c.name.trim(),
        area: circle(c.lat, c.lng, c.radiusM),
      });
    if (!wanted.length)
      throw badRequest(
        'NO_AREA',
        'Choisissez au moins une commune ou un secteur',
      );

    const existing = await this.db.manager.query<
      { id: string; name: string }[]
    >(`SELECT id, name FROM zones WHERE is_active`);
    const zoneIds: string[] = [];
    for (const w of wanted) {
      const same = existing.find(
        (z) =>
          z.name.toLocaleLowerCase('fr') === w.name.toLocaleLowerCase('fr'),
      );
      if (same) {
        zoneIds.push(same.id);
        result.zones.skipped.push({ name: w.name, reason: 'Existe déjà' });
        continue;
      }
      const created = await this.attempt(() =>
        this.zones.create({ name: w.name, area: w.area }),
      );
      if (created.ok) {
        zoneIds.push(created.value.id);
        result.zones.created.push(w.name);
      } else
        result.zones.skipped.push({ name: w.name, reason: created.reason });
    }

    // 2. Pour chaque métier : son formulaire et sa mission de la semaine (formule avec missions).
    const types = features.includes(Feature.Missions)
      ? await this.db.manager.query<{ id: string; name: string }[]>(
          `SELECT id, name FROM mission_types WHERE is_active`,
        )
      : [];
    for (const activity of features.includes(Feature.Missions)
      ? activities
      : []) {
      let typeId: string | null = null;
      for (const t of activity.missionTypes) {
        const same = types.find((x) => x.name === t.name);
        if (same) {
          typeId ??= same.id;
          continue;
        }
        const created = await this.attempt(() =>
          this.types.create({
            name: t.name,
            description: t.description,
            fields: t.fields,
          }),
        );
        if (created.ok) {
          typeId ??= created.value.id;
          types.push({ id: created.value.id, name: t.name });
          result.missionTypes.push(t.name);
        }
      }
      // Mission déjà créée par un passage précédent : pas de doublon.
      const [already] = await this.db.manager.query<unknown[]>(
        `SELECT 1 FROM missions WHERE is_active AND title = $1 LIMIT 1`,
        [activity.mission.title],
      );
      if (typeId && zoneIds.length && dto.createMission !== false && !already) {
        const agents = Math.max(1, dto.agents?.length ?? 1);
        const due = new Date();
        due.setDate(due.getDate() + 7);
        due.setHours(23, 59, 0, 0);
        const mission = await this.attempt(() =>
          this.missions.create(user, {
            typeId: typeId,
            title: activity.mission.title,
            description: activity.mission.description,
            zoneIds,
            progressMethod: ProgressMethod.Count,
            targetValue: activity.mission.perAgent * agents,
            dueDate: due.toISOString(),
          }),
        );
        if (mission.ok) result.missions.push(activity.mission.title);
      }
    }

    // 3. Agents : nom et téléphone suffisent, un mot de passe de départ commun.
    if (dto.agents?.length) {
      const password = dto.agentPassword ?? starterPassword();
      result.agentPassword = password;
      for (const a of dto.agents) {
        const name = `${a.firstName.trim()} ${a.lastName.trim()}`;
        const created = await this.attempt(() =>
          this.users.create({
            // Les agents se connectent avec leur numéro : adresse technique, jamais utilisée.
            email: `agent-${randomUUID().slice(0, 12)}@agents.suivi-agent.ci`,
            password,
            firstName: a.firstName.trim(),
            lastName: a.lastName.trim(),
            phone: a.phone,
            role: Role.Agent,
          }),
        );
        if (created.ok)
          result.agents.created.push({
            name,
            phone: created.value.phone ?? a.phone,
          });
        else result.agents.skipped.push({ name, reason: created.reason });
      }
    }

    await this.mark('done');
    return result;
  }
}

/** Mot de passe facile à dicter : « Suivi-4827 » + 2 lettres. */
function starterPassword() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const two = Array.from(
    { length: 2 },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join('');
  return `Suivi-${digits}${two}`;
}
