import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateBrandingDto {
  /** Nom affiché dans l'app ; vide = nom de la structure */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  displayName?: string | null;

  /** Couleur principale, format #RRGGBB */
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'primaryColor doit être au format #RRGGBB',
  })
  primaryColor?: string;

  /** Message affiché sur l'écran d'accueil de l'agent */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  welcomeMessage?: string | null;

  /** Téléphone à appeler en cas de problème */
  @IsOptional()
  @Matches(/^\+?[0-9 ().-]{6,20}$/, {
    message: 'supportPhone doit être un numéro de téléphone',
  })
  supportPhone?: string | null;
}

export class BrandingDto {
  displayName: string;
  primaryColor: string;
  /** Couleur de texte lisible sur la couleur principale (#FFFFFF ou #0F172A) */
  onPrimaryColor: string;
  welcomeMessage: string | null;
  supportPhone: string | null;
  /** Adresse du logo (authentifiée), ou null */
  logoUrl: string | null;
  /** Change à chaque modification : clé de cache pour l'app */
  version: number;
}
