import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Feature, Role } from '@suivi/shared';
import type { Response } from 'express';
import {
  AllowWhenSuspended,
  RequiresFeature,
  Roles,
} from '../common/decorators';
import { BrandingDto, UpdateBrandingDto } from './branding.dto';
import { BrandingService, MAX_LOGO_BYTES } from './branding.service';

/**
 * Personnalisation de l'app mobile. Elle n'est servie qu'aux utilisateurs connectés :
 * l'écran de connexion de l'app garde l'apparence par défaut.
 */
@ApiTags("Personnalisation de l'app")
@ApiBearerAuth()
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @AllowWhenSuspended()
  @Get()
  get(): Promise<BrandingDto> {
    return this.branding.get();
  }

  @Roles(Role.Admin)
  @RequiresFeature(Feature.Branding)
  @Patch()
  update(@Body() dto: UpdateBrandingDto): Promise<BrandingDto> {
    return this.branding.update(dto);
  }

  /** Logo de la structure : PNG, JPEG ou WebP, 512 Ko maximum. */
  @Roles(Role.Admin)
  @RequiresFeature(Feature.Branding)
  @Put('logo')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_LOGO_BYTES * 2 } }),
  )
  setLogo(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<BrandingDto> {
    return this.branding.setLogo(file);
  }

  @Roles(Role.Admin)
  @RequiresFeature(Feature.Branding)
  @Delete('logo')
  deleteLogo(): Promise<BrandingDto> {
    return this.branding.deleteLogo();
  }

  @AllowWhenSuspended()
  @Get('logo')
  async logo(
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { data, mime, version } = await this.branding.logo();
    res.set({
      'Cache-Control': 'private, max-age=86400',
      ETag: `"logo-${version}"`,
    });
    return new StreamableFile(data, { type: mime });
  }
}
