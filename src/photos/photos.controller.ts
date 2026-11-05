import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Role } from '@suivi/shared';
import type { Response } from 'express';
import type { AuthUser } from '../common/auth-user';
import { CurrentUser, Roles } from '../common/decorators';
import { UploadPhotoDto } from './photos.dto';
import { PhotoAiService } from '../photo-ai/photo-ai.service';
import { MAX_PHOTO_BYTES, PhotosService } from './photos.service';

@ApiTags('Photos des formulaires')
@ApiBearerAuth()
@Controller('photos')
export class PhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly ai: PhotoAiService,
  ) {}

  /**
   * Photo prise sur le terrain (formulaire, fiche de point de vente) : JPEG, PNG ou WebP,
   * 5 Mo maximum. Le chef d'équipe en prend aussi pour les points de vente.
   */
  @Roles(Role.Agent, Role.TeamLead)
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        clientId: { type: 'string', format: 'uuid' },
        takenAt: { type: 'string', format: 'date-time' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        accuracy: { type: 'number' },
        kind: { type: 'string', enum: ['shelf'] },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES * 2 } }),
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadPhotoDto,
  ) {
    const photo = await this.photos.upload(user, file, dto);
    // Photo de rayon : analysée par l'IA photo (si la formule l'inclut), sans attendre.
    if (photo.kind === 'shelf') await this.ai.enqueueShelfPhoto(user, photo.id);
    return { id: photo.id };
  }

  @Get(':id')
  async file(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { data, mime } = await this.photos.file(user, id);
    // Une photo ne change jamais.
    res.set({ 'Cache-Control': 'private, max-age=31536000, immutable' });
    return new StreamableFile(data, { type: mime });
  }
}
