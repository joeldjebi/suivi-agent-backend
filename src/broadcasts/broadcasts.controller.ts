import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import {
  BroadcastPreviewDto,
  ListBroadcastsQuery,
  ResendBroadcastDto,
  SendBroadcastDto,
} from './broadcasts.dto';
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
  list(@Query() query: ListBroadcastsQuery) {
    return this.broadcasts.list(query);
  }

  /** Un envoi et le suivi de chaque destinataire. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.get(id);
  }

  /** Renvoi sur les téléphones des destinataires choisis. */
  @Post(':id/resend')
  resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResendBroadcastDto,
  ) {
    return this.broadcasts.resend(id, dto.userIds);
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
