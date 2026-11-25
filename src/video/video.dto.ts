import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Envoi depuis la page /video (public). L'IP et le user-agent sont ajoutés côté serveur. */
export class RecordViewDto {
  @IsString()
  @MaxLength(80)
  viewId: string;

  @IsOptional()
  @IsUUID()
  prospectId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  seconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  duration?: number;

  @IsOptional()
  @IsIn(['portrait', 'landscape'])
  orientation?: string;
}

export class ListViewsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
