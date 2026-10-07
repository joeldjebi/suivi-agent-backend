import { Type } from 'class-transformer';
import {
  IsDateString,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

/** Champs envoyés avec la photo (formulaire multipart : nombres reçus en texte). */
export class UploadPhotoDto {
  /** Identifiant créé par le téléphone : un renvoi ne crée pas de doublon */
  @IsUUID()
  clientId: string;

  @IsDateString()
  takenAt: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  /** Précision de la position, en mètres */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  accuracy?: number;
}
