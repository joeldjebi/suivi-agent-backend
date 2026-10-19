import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDeviceDto {
  /** Jeton Firebase Cloud Messaging du téléphone */
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  token: string;

  /** web : version web de l'app (notifications du navigateur) */
  @IsIn(['android', 'ios', 'web'])
  platform: 'android' | 'ios' | 'web';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}
