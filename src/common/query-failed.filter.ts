import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';

/** Traduit les violations de contraintes PostgreSQL en erreurs HTTP lisibles. */
@Catch(QueryFailedError)
export class QueryFailedFilter implements ExceptionFilter {
  private readonly logger = new Logger(QueryFailedFilter.name);

  catch(error: QueryFailedError & { code?: string }, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const known: Record<string, [HttpStatus, string, string]> = {
      '23505': [
        HttpStatus.CONFLICT,
        'DUPLICATE',
        'Cette opération est déjà en cours ou existe déjà',
      ],
      '23503': [
        HttpStatus.CONFLICT,
        'REFERENCE_IN_USE',
        'Un élément lié est introuvable ou encore utilisé',
      ],
      '22P02': [HttpStatus.BAD_REQUEST, 'INVALID_VALUE', 'Valeur invalide'],
    };
    const match = error.code ? known[error.code] : undefined;
    if (!match) {
      this.logger.error(error.message, error.stack);
      response
        .status(500)
        .json({ statusCode: 500, code: 'INTERNAL', message: 'Erreur interne' });
      return;
    }
    const [statusCode, code, message] = match;
    response.status(statusCode).json({ statusCode, code, message });
  }
}
