import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApprovalMode, Feature, Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { AllowWhenSuspended, Roles } from '../common/decorators';
import { isValidTimeZone } from '../common/time.util';
import { TenantSettings } from '../entities';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UpdateSettingsDto } from './settings.dto';

@ApiTags('Paramètres de la structure')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @AllowWhenSuspended()
  @Get()
  get(): Promise<TenantSettings> {
    return this.access.settings();
  }

  @Roles(Role.Admin)
  @Patch()
  async update(@Body() dto: UpdateSettingsDto): Promise<TenantSettings> {
    if (dto.timezone && !isValidTimeZone(dto.timezone)) {
      throw badRequest(
        'INVALID_TIMEZONE',
        `Fuseau horaire inconnu : ${dto.timezone}`,
      );
    }
    // Groupes et validation des zones : formules Avancée et Entreprise.
    if (dto.useGroups)
      await this.subscriptions.assertFeature(this.db.tenantId, Feature.Groups);
    if (dto.approvalMode && dto.approvalMode !== ApprovalMode.Automatic)
      await this.subscriptions.assertFeature(
        this.db.tenantId,
        Feature.ManualApproval,
      );
    if (Object.keys(dto).length) {
      await this.db.manager.update(
        TenantSettings,
        { tenantId: this.db.tenantId },
        { ...dto },
      );
    }
    return this.access.settings();
  }
}
