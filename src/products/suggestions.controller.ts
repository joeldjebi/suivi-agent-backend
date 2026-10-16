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
import {
  AcceptSuggestionDto,
  CreateSuggestionDto,
  ListSuggestionsQuery,
  RejectSuggestionDto,
} from './suggestions.dto';
import { SuggestionsService } from './suggestions.service';

/**
 * Produits concurrents signalés depuis le terrain : l'agent signale, l'administrateur ajoute
 * au catalogue ou refuse. Formules avec les relevés produits.
 */
@ApiTags('Produits')
@ApiBearerAuth()
@RequiresFeature(Feature.ProductAudits)
@Roles(Role.Admin, Role.TeamLead, Role.Agent)
@Controller('product-suggestions')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  /** Signaler un produit concurrent vu dans un commerce (idempotent sur clientId). */
  @Roles(Role.Agent, Role.TeamLead)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSuggestionDto) {
    return this.suggestions.create(user, dto);
  }

  /** Agent : les siens ; chef : ceux de son équipe ; administrateur : tous. À traiter d'abord. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListSuggestionsQuery) {
    return this.suggestions.list(user, q);
  }

  /** Ajout au catalogue (produit concurrent) ou rattachement à un produit existant. */
  @Roles(Role.Admin)
  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptSuggestionDto,
  ) {
    return this.suggestions.accept(user, id, dto);
  }

  /** Refus avec motif : l'agent est prévenu. */
  @Roles(Role.Admin)
  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectSuggestionDto,
  ) {
    return this.suggestions.reject(user, id, dto.reason);
  }
}
