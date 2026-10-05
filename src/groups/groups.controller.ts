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
import { Feature, Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, RequiresFeature, Roles } from '../common/decorators';
import { DeleteQuery } from '../common/deletion';
import { CreateGroupDto, SetIdsDto, UpdateGroupDto } from './groups.dto';
import { GroupsService } from './groups.service';

@ApiTags('Groupes')
@ApiBearerAuth()
@Roles(Role.Admin)
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  /** Administrateur : tous les groupes. Chef d'équipe : ses groupes. */
  @Roles(Role.Admin, Role.TeamLead)
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.groups.list(user, includeInactive);
  }

  /** Données liées qu'une suppression définitive emporterait. */
  @Get(':id/impact')
  impact(@Param('id', ParseUUIDPipe) id: string) {
    return this.groups.describeImpact(id);
  }

  @Roles(Role.Admin, Role.TeamLead)
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.groups.get(user, id);
  }

  @RequiresFeature(Feature.Groups)
  @Post()
  create(@Body() dto: CreateGroupDto) {
    return this.groups.create(dto);
  }

  @RequiresFeature(Feature.Groups)
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto) {
    return this.groups.update(id, dto);
  }

  /**
   * Suppression définitive. Refusée (409 HAS_DEPENDENCIES) si des agents, missions
   * ou zones sont liés, sauf avec `force=true` : les missions sont alors supprimées.
   * Préférez la désactivation (`PATCH { isActive: false }`).
   */
  @RequiresFeature(Feature.Groups)
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Query() query: DeleteQuery) {
    return this.groups.remove(id, query.force);
  }

  /** Remplace la liste des agents du groupe. */
  @RequiresFeature(Feature.Groups)
  @Put(':id/members')
  setMembers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetIdsDto) {
    return this.groups.setMembers(id, dto.ids);
  }

  /** Remplace la liste des zones attribuées au groupe. */
  @RequiresFeature(Feature.Groups)
  @Put(':id/zones')
  setZones(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetIdsDto) {
    return this.groups.setZones(id, dto.ids);
  }
}
