import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user';
import { AllowWhenSuspended, CurrentUser, Roles } from '../common/decorators';
import {
  CurrentAdmin,
  PlatformRoute,
  type PlatformUser,
} from '../platform/platform-auth';
import { clientIp } from '../platform/platform-security';
import {
  CreateTicketDto,
  PlatformTicketStatusDto,
  PlatformTicketsQuery,
  SupportMessageDto,
} from './support.dto';
import { SupportService } from './support.service';

/**
 * Support de la structure : demandes d'aide à l'éditeur. Ouvert même abonnement suspendu,
 * c'est souvent là qu'on en a besoin.
 */
@ApiTags('Support')
@ApiBearerAuth()
@AllowWhenSuspended()
@Roles(Role.Admin, Role.TeamLead)
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.support.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.support.create(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(user, id);
  }

  @Post(':id/messages')
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupportMessageDto,
  ) {
    return this.support.reply(user, id, dto);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.close(user, id);
  }
}

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : demandes d'aide de toutes les structures. */
@ApiTags('Plateforme — support')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform/support')
export class PlatformSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query() query: PlatformTicketsQuery) {
    return this.support.platformList(query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.support.platformGet(id);
  }

  @Post(':id/messages')
  reply(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupportMessageDto,
    @Req() req: Request,
  ) {
    return this.support.platformReply(admin, id, dto, clientIp(req));
  }

  @Patch(':id')
  setStatus(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlatformTicketStatusDto,
    @Req() req: Request,
  ) {
    return this.support.platformSetStatus(admin, id, dto.status, clientIp(req));
  }
}
