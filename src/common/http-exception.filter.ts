import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

/** Messages en français des erreurs produites par le framework (rôles, validation, fichiers…). */
const BY_STATUS: Record<number, [string, string]> = {
  [HttpStatus.BAD_REQUEST]: [
    'VALIDATION',
    'Certaines informations sont manquantes ou invalides',
  ],
  [HttpStatus.UNAUTHORIZED]: [
    'UNAUTHORIZED',
    'Votre session a expiré : reconnectez-vous',
  ],
  [HttpStatus.FORBIDDEN]: ['FORBIDDEN', 'Vous n’avez pas accès à cette action'],
  [HttpStatus.NOT_FOUND]: ['NOT_FOUND', 'Élément introuvable'],
  [HttpStatus.METHOD_NOT_ALLOWED]: ['NOT_FOUND', 'Élément introuvable'],
  [HttpStatus.PAYLOAD_TOO_LARGE]: [
    'TOO_LARGE',
    'Fichier ou envoi trop volumineux',
  ],
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: [
    'UNSUPPORTED_FILE',
    'Type de fichier non pris en charge',
  ],
  [HttpStatus.TOO_MANY_REQUESTS]: [
    'TOO_MANY_REQUESTS',
    'Trop de demandes : réessayez dans quelques instants',
  ],
};

/**
 * Erreurs HTTP : les erreurs métier (avec un `code`, déjà en français) passent telles
 * quelles ; celles du framework (« Forbidden resource », « File too large », messages de
 * validation en anglais…) reçoivent un code et un message en français, jamais technique.
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: HttpException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error.getStatus();
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      response.status(status).json(body);
      return;
    }
    const [code, message] = BY_STATUS[status] ?? [
      'REQUEST_ERROR',
      'La demande n’a pas pu aboutir',
    ];
    response.status(status).json({ statusCode: status, code, message });
  }
}
