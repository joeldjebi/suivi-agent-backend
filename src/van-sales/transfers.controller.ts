import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { TransfersService } from './transfers.service';
import {
  AcceptTransferDto,
  CreateTransferDto,
  TransferDecisionDto,
  TransferHandoverDto,
  TransfersQuery,
} from './van-sales.dto';

/**
 * Dépannage partagé entre camions : demande diffusée aux collègues proches, parts prises par
 * un ou plusieurs collègues (accord du chef pour une autre équipe), remise sur place avec le
 * code du demandeur scanné.
 */
@ApiTags('Vente en camionnette — dépannage')
@ApiBearerAuth()
@RequiresFeature(Feature.VanSales)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('van-sales/transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /** Demandes en cours (ou des 30 derniers jours) : les miennes, mes parts, mon équipe. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: TransfersQuery) {
    return this.transfers.list(user, q);
  }

  /** Demandes de collègues que je peux aider (j'ai au moins un produit), les plus proches d'abord. */
  @Roles(Role.Agent)
  @Get('nearby')
  nearby(@CurrentUser() user: AuthUser) {
    return this.transfers.nearby(user);
  }

  /** Demande de dépannage : ce qu'il me faut, envoyé aux collègues proches. Idempotente. */
  @Roles(Role.Agent)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTransferDto) {
    return this.transfers.create(user, dto);
  }

  /** Remise sur place : code du demandeur scanné, quantités remises (au plus ma part). */
  @Roles(Role.Agent)
  @Post('handover')
  handover(@CurrentUser() user: AuthUser, @Body() dto: TransferHandoverDto) {
    return this.transfers.handover(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(user, id);
  }

  /** Je prends une part de la demande (tout ou partie de ce qui reste). */
  @Roles(Role.Agent)
  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptTransferDto,
  ) {
    return this.transfers.accept(user, id, dto);
  }

  /** Le demandeur clôt sa demande (« j'ai ce qu'il me faut »). */
  @Roles(Role.Agent)
  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.close(user, id);
  }

  /** Part d'un collègue d'une autre équipe : accord de son chef. */
  @Roles(Role.Admin, Role.TeamLead)
  @Post('legs/:legId/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthUser,
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: TransferDecisionDto,
  ) {
    return this.transfers.decideLeg(user, legId, true, dto.note);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Post('legs/:legId/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: TransferDecisionDto,
  ) {
    return this.transfers.decideLeg(user, legId, false, dto.note);
  }

  /** Le collègue abandonne sa part : elle redevient disponible pour les autres. */
  @Roles(Role.Agent)
  @Post('legs/:legId/release')
  @HttpCode(200)
  release(
    @CurrentUser() user: AuthUser,
    @Param('legId', ParseUUIDPipe) legId: string,
    @Body() dto: TransferDecisionDto,
  ) {
    return this.transfers.releaseLeg(user, legId, dto.note);
  }
}
