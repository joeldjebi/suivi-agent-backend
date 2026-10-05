import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import {
  CurrentAdmin,
  PlatformRoute,
  type PlatformUser,
} from '../platform/platform-auth';
import {
  CreateSlideDto,
  OnboardingSettingsDto,
  ReorderSlidesDto,
  UpdateSlideDto,
} from './app-onboarding.dto';
import {
  AppOnboardingService,
  MAX_LOTTIE_BYTES,
} from './app-onboarding.service';

/** Onboarding de l'app mobile, lu avant la connexion. */
@ApiTags('Onboarding de l’app mobile')
@Public()
@Controller('public/app-onboarding')
export class PublicAppOnboardingController {
  constructor(private readonly onboarding: AppOnboardingService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  get() {
    return this.onboarding.publicOnboarding();
  }

  /** Animation importée ; l'adresse change à chaque modification (paramètre « v »). */
  @Get('slides/:id/lottie')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  lottie(@Param('id', ParseUUIDPipe) id: string) {
    return this.onboarding.lottie(id);
  }
}

const hidden = process.env.NODE_ENV === 'production';

/** Console éditeur : pages, animations, ordre et nouvelle version de l'onboarding. */
@ApiTags('Plateforme — onboarding de l’app')
@ApiExcludeController(hidden)
@PlatformRoute()
@Controller('platform/app-onboarding')
export class PlatformAppOnboardingController {
  constructor(private readonly onboarding: AppOnboardingService) {}

  @Get()
  editor() {
    return this.onboarding.editor();
  }

  @Put()
  settings(
    @CurrentAdmin() admin: PlatformUser,
    @Body() dto: OnboardingSettingsDto,
  ) {
    return this.onboarding.setEnabled(admin, dto.enabled);
  }

  @Post('slides')
  create(@CurrentAdmin() admin: PlatformUser, @Body() dto: CreateSlideDto) {
    return this.onboarding.create(admin, dto);
  }

  @Patch('slides/:id')
  update(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSlideDto,
  ) {
    return this.onboarding.update(admin, id, dto);
  }

  @Delete('slides/:id')
  remove(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.onboarding.remove(admin, id);
  }

  @Put('order')
  reorder(@CurrentAdmin() admin: PlatformUser, @Body() dto: ReorderSlidesDto) {
    return this.onboarding.reorder(admin, dto);
  }

  @Put('slides/:id/lottie')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_LOTTIE_BYTES * 2 } }),
  )
  setLottie(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.onboarding.setLottie(admin, id, file);
  }

  @Delete('slides/:id/lottie')
  clearLottie(
    @CurrentAdmin() admin: PlatformUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.onboarding.clearLottie(admin, id);
  }

  /** Remontrer l'onboarding une fois à tous les utilisateurs de l'app. */
  @Post('republish')
  @HttpCode(200)
  republish(@CurrentAdmin() admin: PlatformUser) {
    return this.onboarding.republish(admin);
  }

  @Post('restore-defaults')
  @HttpCode(200)
  restoreDefaults(@CurrentAdmin() admin: PlatformUser) {
    return this.onboarding.restoreDefaults(admin);
  }
}
