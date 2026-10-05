import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { DocsController, PlatformDocsController } from './docs.controller';
import { DocsService } from './docs.service';

@Module({
  imports: [PlatformModule],
  controllers: [DocsController, PlatformDocsController],
  providers: [DocsService],
})
export class DocsModule {}
