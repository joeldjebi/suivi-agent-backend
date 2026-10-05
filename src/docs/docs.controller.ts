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
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth-user';
import { AllowWhenSuspended, CurrentUser } from '../common/decorators';
import {
  CurrentAdmin,
  PlatformRoute,
  type PlatformUser,
} from '../platform/platform-auth';
import { DocArticleDto, UpdateDocArticleDto } from './docs.dto';
import { DocsService } from './docs.service';

/** Manuel d'utilisation, pour les comptes connectés (jamais public). */
@ApiTags('Documentation')
@ApiBearerAuth()
@AllowWhenSuspended()
@Controller('documentation')
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.docs.list(user.role);
  }

  @Get(':slug')
  get(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.docs.get(user.role, slug);
  }
}

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : rédaction du manuel. */
@ApiTags('Plateforme — documentation')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform/documentation')
export class PlatformDocsController {
  constructor(private readonly docs: DocsService) {}

  @Get()
  list() {
    return this.docs.platformList();
  }

  @Post()
  create(@CurrentAdmin() admin: PlatformUser, @Body() dto: DocArticleDto) {
    return this.docs.create(admin, dto);
  }

  @Patch(':id')
  update(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocArticleDto,
  ) {
    return this.docs.update(admin, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.docs.remove(id);
  }

  @Post('restore-defaults')
  @HttpCode(200)
  restore() {
    return this.docs.restoreDefaults();
  }
}
