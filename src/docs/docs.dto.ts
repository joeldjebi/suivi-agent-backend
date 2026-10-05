import { PartialType } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class DocArticleDto {
  /** Identifiant d'adresse : minuscules, chiffres et tirets */
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug : minuscules, chiffres et tirets',
  })
  @MaxLength(80)
  slug: string;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  section: string;

  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  summary?: string;

  /** Contenu en Markdown (le HTML n'est pas interprété) */
  @IsString()
  @MinLength(1)
  @MaxLength(30000)
  body: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(['admin', 'team_lead', 'agent'], { each: true })
  audience: ('admin' | 'team_lead' | 'agent')[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  position?: number;

  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

export class UpdateDocArticleDto extends PartialType(DocArticleDto) {}
