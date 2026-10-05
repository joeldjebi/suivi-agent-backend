import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Role } from '@suivi/shared';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { PaginationQuery } from '../common/pagination.dto';

export class CreateUserDto {
  @IsEmail()
  email: string;

  /** Mot de passe initial, communiqué à l'utilisateur par la structure */
  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @IsNotEmpty()
  firstName: string;

  @IsString()
  @IsNotEmpty()
  lastName: string;

  /** Identifiant de connexion à l'app mobile : obligatoire pour les agents et chefs d'équipe */
  @IsOptional()
  @IsString()
  phone?: string | null;

  @IsIn(Object.values(Role))
  role: Role;

  /** Groupe de l'agent (un seul groupe par agent) */
  @IsOptional()
  @IsUUID()
  groupId?: string | null;

  /** Agent en période d'essai : critère du mode mixte (RG-23) */
  @IsOptional()
  @IsBoolean()
  onProbation?: boolean;
}

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListUsersQuery extends PaginationQuery {
  @IsOptional()
  @IsIn(Object.values(Role))
  role?: Role;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  /** Recherche sur le nom, le prénom, l'email ou le numéro */
  @IsOptional()
  @IsString()
  search?: string;

  /** Actifs, désactivés ou en période d'essai */
  @IsOptional()
  @IsIn(['active', 'inactive', 'probation'])
  status?: 'active' | 'inactive' | 'probation';

  /** Agents rattachés à aucun groupe */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  withoutGroup?: boolean;

  /** En journée aujourd'hui, jamais travaillé, ou sans journée depuis 30 jours */
  @IsOptional()
  @IsIn(['working', 'never', 'idle30'])
  activity?: 'working' | 'never' | 'idle30';

  @IsOptional()
  @IsIn(['name', 'recent', 'lastDay'])
  sort?: 'name' | 'recent' | 'lastDay';
}
