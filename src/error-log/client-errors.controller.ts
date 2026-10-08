import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { AuthUser } from '../common/auth-user';
import { AllowWhenSuspended, CurrentUser } from '../common/decorators';
import { ErrorLogService } from './error-log.service';

export class ClientErrorDto {
  @IsIn(['web', 'mobile'])
  source: 'web' | 'mobile';

  @IsString()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  stack?: string;

  /** Écran où l'erreur s'est produite */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}

/** Au plus 20 erreurs par minute et par utilisateur (une boucle d'erreurs ne noie pas le journal). */
const LIMIT = 20;

@ApiTags('Santé')
@ApiBearerAuth()
@AllowWhenSuspended()
@Controller('client-errors')
export class ClientErrorsController {
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly errors: ErrorLogService) {}

  /** Erreur d'affichage du site ou de l'app, remontée au journal de l'éditeur. */
  @Post()
  @HttpCode(204)
  async report(@CurrentUser() user: AuthUser, @Body() dto: ClientErrorDto) {
    const now = Date.now();
    const times = (this.recent.get(user.id) ?? []).filter(
      (t) => now - t < 60_000,
    );
    if (times.length >= LIMIT) return;
    times.push(now);
    this.recent.set(user.id, times);
    if (this.recent.size > 5000) this.recent.clear();
    await this.errors.record({
      ...dto,
      tenantId: user.tenantId,
      userId: user.id,
    });
  }
}
