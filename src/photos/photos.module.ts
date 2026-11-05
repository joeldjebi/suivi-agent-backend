import { Module } from '@nestjs/common';
import { PhotoAiController } from '../photo-ai/photo-ai.controller';
import { PhotoAiService } from '../photo-ai/photo-ai.service';
import { PHOTO_AI_PROVIDER, providersFromEnv } from '../photo-ai/providers';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

/** Photos du terrain, et leur analyse par l'IA photo (fournisseur choisi par la configuration). */
@Module({
  controllers: [PhotosController, PhotoAiController],
  providers: [
    PhotosService,
    PhotoAiService,
    { provide: PHOTO_AI_PROVIDER, useFactory: providersFromEnv },
  ],
  exports: [PhotosService, PhotoAiService],
})
export class PhotosModule {}
