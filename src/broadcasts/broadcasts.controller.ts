import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { BroadcastPreviewDto, SendBroadcastDto } from './broadcasts.dto';
import { BroadcastsService } from './broadcasts.service';

/** Notifications de l'administrateur aux agents et chefs d'équipe (formule avec push). */
@ApiTags('Notifications aux équipes')
@ApiBearerAuth()
@Roles(Role.Admin)
@RequiresFeature(Feature.PushNotifications)
@Controller('broadcasts')
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get()
  list() {
    return this.broadcasts.list();
  }

  /** Destinataires d'une audience, avant envoi. */
  @Post('preview')
  preview(@Body() dto: BroadcastPreviewDto) {
    return this.broadcasts.preview(dto.audience);
  }

  @Post()
  send(@CurrentUser() user: AuthUser, @Body() dto: SendBroadcastDto) {
    return this.broadcasts.send(user, dto);
  }
}
