import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsNull } from 'typeorm';
import type { AuthUser } from '../common/auth-user';
import { notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { AllowWhenSuspended, CurrentUser } from '../common/decorators';
import { Notification } from '../entities';

@ApiTags('Notifications')
@ApiBearerAuth()
// Ouvertes même abonnement suspendu : c'est là que la structure en apprend la raison.
@AllowWhenSuspended()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly db: DbService) {}

  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('unreadOnly', new ParseBoolPipe({ optional: true }))
    unreadOnly?: boolean,
  ) {
    return this.db.manager.find(Notification, {
      where: { userId: user.id, ...(unreadOnly ? { readAt: IsNull() } : {}) },
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.db.manager.update(
      Notification,
      { id, userId: user.id },
      { readAt: new Date() },
    );
    if (!result.affected) throw notFound('Notification');
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@CurrentUser() user: AuthUser) {
    await this.db.manager.update(
      Notification,
      { userId: user.id, readAt: IsNull() },
      { readAt: new Date() },
    );
  }
}
