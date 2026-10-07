import { Global, Module } from '@nestjs/common';
import {
  AppVersionController,
  AppVersionGuard,
  AppVersionService,
} from './app-version';

@Global()
@Module({
  controllers: [AppVersionController],
  providers: [AppVersionService, AppVersionGuard],
  exports: [AppVersionService, AppVersionGuard],
})
export class AppVersionModule {}
