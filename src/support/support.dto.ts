import { SupportCategory, SupportStatus } from '@suivi/shared';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @MinLength(4)
  @MaxLength(140)
  subject: string;

  @IsIn(Object.values(SupportCategory))
  category: SupportCategory;

  /** Description du problème ou de la question */
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message: string;

  /** Contexte technique ajouté par l'application (page, navigateur…) */
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class SupportMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class PlatformTicketsQuery {
  @IsOptional()
  @IsIn([...Object.values(SupportStatus), 'all'])
  status?: SupportStatus | 'all';

  @IsOptional()
  @IsUUID()
  tenantId?: string;
}

export class PlatformTicketStatusDto {
  @IsIn(Object.values(SupportStatus))
  status: SupportStatus;
}
