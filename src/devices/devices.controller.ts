import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth-user';
import { DbService } from '../common/db.service';
import { AllowWhenSuspended, CurrentUser } from '../common/decorators';
import { RegisterDeviceDto } from './devices.dto';

/**
 * Téléphones joignables par notification push. L'app enregistre son jeton à la connexion
 * (et quand Firebase le renouvelle), et le retire à la déconnexion.
 */
@ApiTags('Notifications push')
@ApiBearerAuth()
@AllowWhenSuspended()
@Controller('devices')
export class DevicesController {
  constructor(private readonly db: DbService) {}

  @Post()
  @HttpCode(204)
  async register(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceDto,
  ): Promise<void> {
    // Un jeton n'appartient qu'au dernier compte connecté sur ce téléphone.
    await this.db.manager.query(
      `INSERT INTO push_devices (tenant_id, user_id, token, platform, app_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET tenant_id = excluded.tenant_id, user_id = excluded.user_id,
         platform = excluded.platform, app_version = excluded.app_version, last_seen_at = now()`,
      [user.tenantId, user.id, dto.token, dto.platform, dto.appVersion ?? null],
    );
  }

  /** Déconnexion : ce téléphone ne reçoit plus les notifications de ce compte. */
  @Delete(':token')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.db.manager.query(
      `DELETE FROM push_devices WHERE token = $1 AND user_id = $2`,
      [token, user.id],
    );
  }
}
