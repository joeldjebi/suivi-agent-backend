import { IsDateString, IsOptional } from 'class-validator';

export class WeekQuery {
  /** Un jour de la semaine voulue (AAAA-MM-JJ) ; par défaut, la semaine en cours */
  @IsOptional()
  @IsDateString({ strict: true })
  date?: string;
}
