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
import { MAX_PHOTO_BYTES, PhotosService } from './photos.service';

@ApiTags('Photos des formulaires')
@ApiBearerAuth()
@Controller('photos')
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  /** Photo prise par l'agent pour un formulaire : JPEG, PNG ou WebP, 5 Mo maximum. */
  @Roles(Role.Agent)
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
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_PHOTO_BYTES * 2 } }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadPhotoDto,
  ) {
    return this.photos.upload(user, file, dto);
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
