import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { DeleteQuery } from '../common/deletion';
import { SetIdsDto } from '../groups/groups.dto';
import { CreateZoneDto, UpdateZoneDto } from './zones.dto';
import { ZonesService } from './zones.service';

@ApiTags('Zones')
@ApiBearerAuth()
@Roles(Role.Admin)
@Controller('zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  /** Administrateur : toutes les zones. Chef d'équipe : les zones de ses groupes. */
  @Roles(Role.Admin, Role.TeamLead)
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.zones.list(user, includeInactive);
  }

  /** Agent : zones qu'il peut choisir, avec les places restantes (RG-03, RG-06). */
  @Roles(Role.Agent)
  @Get('available')
  available(@CurrentUser() user: AuthUser) {
    return this.zones.availableFor(user);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.zones.get(id);
  }

  @Post()
  create(@Body() dto: CreateZoneDto) {
    return this.zones.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateZoneDto) {
    return this.zones.update(id, dto);
  }

  /** Données liées qu'une suppression définitive emporterait. */
  @Get(':id/impact')
  impact(@Param('id', ParseUUIDPipe) id: string) {
    return this.zones.describeImpact(id);
  }

  /**
   * Suppression définitive. Refusée (409 HAS_DEPENDENCIES) si la zone a un historique,
   * sauf avec `force=true`. Préférez la fermeture (`PATCH { isActive: false }`).
   */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Query() query: DeleteQuery) {
    return this.zones.remove(id, query.force);
  }

  @Get(':id/agents')
  listAgents(@Param('id', ParseUUIDPipe) id: string) {
    return this.zones.listAgents(id);
  }

  /** Agents autorisés sur une zone réservée, sans groupes (RG-15). */
  @Put(':id/agents')
  setAgents(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetIdsDto) {
    return this.zones.setAgents(id, dto.ids);
  }
}
