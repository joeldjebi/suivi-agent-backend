import { Injectable } from '@nestjs/common';
import {
  Feature,
  OnboardingStep,
  type OnboardingState,
  type OnboardingStepState,
} from '@suivi/shared';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { MANUAL_STEPS, type UpdateOnboardingDto } from './onboarding.dto';

interface Stored {
  checked?: OnboardingStep[];
  dismissed?: boolean;
}

/**
 * Guide « Bien démarrer » : les étapes se cochent d'elles-mêmes d'après les données de la
 * structure (zones, agents, première journée…), sauf les prérequis et les réglages, validés
 * par l'administrateur. Les étapes hors formule ne sont pas proposées.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async state(): Promise<OnboardingState> {
    const tenantId = this.db.tenantId;
    const { features } = await this.subscriptions.summary(tenantId);
    const stored = await this.stored();
    const [row] = await this.db.manager.query<
      {
        zones: boolean;
        teams: boolean;
        agents: boolean;
        app: boolean;
        missions: boolean;
        payroll: boolean;
        first_day: boolean;
        use_groups: boolean;
      }[]
    >(
      `SELECT
         EXISTS (SELECT 1 FROM zones WHERE is_active) AS zones,
         EXISTS (SELECT 1 FROM groups WHERE is_active)
           OR EXISTS (SELECT 1 FROM users WHERE role = 'team_lead' AND is_active) AS teams,
         EXISTS (SELECT 1 FROM users WHERE role = 'agent' AND is_active) AS agents,
         EXISTS (SELECT 1 FROM refresh_tokens r JOIN users u ON u.id = r.user_id
                 WHERE u.role = 'agent') AS app,
         EXISTS (SELECT 1 FROM mission_types WHERE is_active) AS missions,
         EXISTS (SELECT 1 FROM pay_grids WHERE is_active) AS payroll,
         EXISTS (SELECT 1 FROM work_days) AS first_day,
         (SELECT use_groups FROM tenant_settings) AS use_groups`,
    );
    const checked = new Set(stored.checked ?? []);
    const manual = (key: OnboardingStep): OnboardingStepState => ({
      key,
      done: checked.has(key),
      manual: true,
    });
    const auto = (key: OnboardingStep, done: boolean): OnboardingStepState => ({
      key,
      done,
      manual: false,
    });
    const teamsInPlan =
      features.includes(Feature.TeamLeads) ||
      (features.includes(Feature.Groups) && row.use_groups);

    const steps: OnboardingStepState[] = [
      manual(OnboardingStep.Prerequisites),
      manual(OnboardingStep.Settings),
      auto(OnboardingStep.Zones, row.zones),
      ...(teamsInPlan ? [auto(OnboardingStep.Teams, row.teams)] : []),
      auto(OnboardingStep.Agents, row.agents),
      ...(features.includes(Feature.Missions)
        ? [auto(OnboardingStep.Missions, row.missions)]
        : []),
      ...(features.includes(Feature.Payroll)
        ? [auto(OnboardingStep.Payroll, row.payroll)]
        : []),
      auto(OnboardingStep.App, row.app),
      auto(OnboardingStep.FirstDay, row.first_day),
    ];
    return {
      steps,
      dismissed: !!stored.dismissed,
      completed: steps.every((s) => s.done),
    };
  }

  async update(dto: UpdateOnboardingDto): Promise<OnboardingState> {
    if (dto.step && dto.done === undefined)
      throw badRequest('INVALID_STEP', 'Précisez si l’étape est faite');
    const stored = await this.stored();
    if (dto.step && MANUAL_STEPS.includes(dto.step)) {
      const checked = new Set(stored.checked ?? []);
      if (dto.done) checked.add(dto.step);
      else checked.delete(dto.step);
      stored.checked = [...checked];
    }
    if (dto.dismissed !== undefined) stored.dismissed = dto.dismissed;
    await this.db.manager.query(
      `UPDATE tenant_settings SET onboarding = $1 WHERE tenant_id = $2`,
      [JSON.stringify(stored), this.db.tenantId],
    );
    return this.state();
  }

  private async stored(): Promise<Stored> {
    const [row] = await this.db.manager.query<{ onboarding: Stored }[]>(
      `SELECT onboarding FROM tenant_settings WHERE tenant_id = $1`,
      [this.db.tenantId],
    );
    return row?.onboarding ?? {};
  }
}
