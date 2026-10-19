import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** Fonctions présentées : chaque fonction désactivée retire ses diapositives et ses étapes. */
export class PresentationModulesDto {
  @IsBoolean()
  missions: boolean;

  @IsBoolean()
  outlets: boolean;

  @IsBoolean()
  orders: boolean;

  @IsBoolean()
  pay: boolean;
}

/** Informations du client qui personnalisent la présentation. */
export class PresentationContentDto {
  @ApiProperty({ example: 'Moyoo Pro' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  clientName: string;

  @ApiProperty({ example: 'distribution de boissons' })
  @IsString()
  @MaxLength(80)
  trade: string;

  @ApiProperty({ example: 'Abidjan' })
  @IsString()
  @MaxLength(60)
  city: string;

  @ApiProperty({ example: ['Plateau', 'Cocody', 'Yopougon'] })
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  areas: string[];

  @ApiProperty({ example: 16 })
  @IsInt()
  @Min(0)
  @Max(100000)
  agents: number;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(0)
  @Max(10000)
  leads: number;

  @ApiProperty({ example: ['Eau Cascade 1,5 L', 'Tonic Royal 33 cl'] })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  products: string[];

  /** Comment le client appelle ses points de vente (« boutiques, maquis et supérettes »). */
  @ApiProperty({ example: 'boutiques, maquis et supérettes' })
  @IsString()
  @MaxLength(80)
  outletWord: string;

  @ApiProperty({ type: PresentationModulesDto })
  @ValidateNested()
  @Type(() => PresentationModulesDto)
  modules: PresentationModulesDto;

  /** Prénom de l'agent qui sert de fil rouge à « la journée type ». */
  @ApiProperty({ example: 'Koffi' })
  @IsString()
  @MaxLength(40)
  agentName: string;

  @ApiProperty({ example: 'Joël' })
  @IsString()
  @MaxLength(60)
  presenter: string;

  @ApiPropertyOptional({ example: '2026-10-24', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601({ strict: true })
  meetingDate: string | null;

  @ApiProperty({ example: '#2563EB' })
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Couleur au format #RRGGBB' })
  color: string;

  @ApiProperty({ example: 'contact@performx.online' })
  @ValidateIf((_, v) => v !== '')
  @IsEmail()
  @MaxLength(120)
  supportEmail: string;

  @ApiProperty({ example: '+225 07 00 00 00 00' })
  @IsString()
  @MaxLength(30)
  supportPhone: string;
}

export class SavePresentationDto {
  @ApiProperty({ type: PresentationContentDto })
  @ValidateNested()
  @Type(() => PresentationContentDto)
  content: PresentationContentDto;

  /** Structure du client, si elle existe déjà sur PerformX. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  tenantId?: string | null;
}

export class PresentationDefaultsQuery {
  @ApiPropertyOptional({
    description: 'Pré-remplir avec les données de cette structure',
  })
  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
