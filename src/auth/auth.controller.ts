import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth-user';
import { AllowWhenSuspended, CurrentUser, Public } from '../common/decorators';
import {
  ChangePasswordDto,
  UpdateProfileDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  TokensDto,
} from './auth.dto';
import { AuthService, MAX_AVATAR_BYTES } from './auth.service';

@ApiTags('Authentification')
@AllowWhenSuspended()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Inscription d'une structure et de son premier administrateur. */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<TokensDto> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Ip() ip: string): Promise<TokensDto> {
    return this.auth.login(dto, ip);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<TokensDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  /** Profil de l'utilisateur connecté, sa structure et ses paramètres. */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  /** Prénom, nom, email de l'utilisateur connecté. Renvoie le profil à jour. */
  @ApiBearerAuth()
  @Patch('me')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user, dto);
  }

  /** Photo de profil : PNG, JPEG ou WebP, 1 Mo maximum. */
  @ApiBearerAuth()
  @Put('me/avatar')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_AVATAR_BYTES * 2 } }),
  )
  setAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.auth.setAvatar(user, file);
  }

  @ApiBearerAuth()
  @Delete('me/avatar')
  deleteAvatar(@CurrentUser() user: AuthUser) {
    return this.auth.deleteAvatar(user);
  }

  /**
   * Nouveau mot de passe : les autres appareils sont déconnectés ;
   * celui-ci reçoit de nouveaux jetons et reste connecté.
   */
  @ApiBearerAuth()
  @Patch('password')
  @HttpCode(200)
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<TokensDto> {
    return this.auth.changePassword(user, dto);
  }
}
