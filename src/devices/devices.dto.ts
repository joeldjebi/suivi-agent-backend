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

  @IsIn(['android', 'ios'])
  platform: 'android' | 'ios';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}
