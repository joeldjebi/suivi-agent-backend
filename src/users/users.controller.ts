import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { DeleteQuery } from '../common/deletion';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Utilisateurs')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Administrateur : tous les utilisateurs. Chef d'équipe : les agents de ses groupes. */
  @Roles(Role.Admin, Role.TeamLead)
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListUsersQuery) {
    return this.users.list(user, query);
  }

  /** Chiffres de la page Utilisateurs : rôles, statuts, activité des agents. */
  @Roles(Role.Admin, Role.TeamLead)
  @Get('stats')
  stats(@CurrentUser() user: AuthUser) {
    return this.users.stats(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(user, id);
  }

  /** Photo de profil (soi-même, ses agents pour un chef, tous pour l'administrateur). */
  @Get(':id/avatar')
  async avatar(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { data, mime, version } = await this.users.avatar(user, id);
    res.set({
      'Cache-Control': 'private, max-age=86400',
      ETag: `"avatar-${id}-${version}"`,
    });
    return new StreamableFile(data, { type: mime });
  }

  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Roles(Role.Admin)
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(user, id, dto);
  }

  /** Données liées qu'une suppression définitive emporterait. */
  @Roles(Role.Admin)
  @Get(':id/impact')
  impact(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.describeImpact(id);
  }

  /**
   * Suppression définitive. Refusée (409 HAS_DEPENDENCIES) si l'utilisateur a un
   * historique, sauf avec `force=true`. Préférez la désactivation (`PATCH { isActive: false }`).
   */
  @Roles(Role.Admin)
  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteQuery,
  ) {
    return this.users.remove(user, id, query.force);
  }
}
