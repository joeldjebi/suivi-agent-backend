import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class RegisterDto {
  /** Nom de la structure */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  organizationName: string;

  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

/** Connexion par email (plateforme web) ou par téléphone (app mobile). */
export class LoginDto {
  @ValidateIf((o: LoginDto) => !o.phone)
  @IsEmail()
  email?: string;

  /** Numéro de téléphone, ex. 07 07 07 07 07 ou +225 07 07 07 07 07 */
  @ValidateIf((o: LoginDto) => !o.email)
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

/** Ce que chacun peut modifier dans son propre profil (pas le numéro de connexion). */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class TokensDto {
  accessToken: string;
  refreshToken: string;
  /** Durée de validité du jeton d'accès, en secondes */
  expiresIn: number;
}
