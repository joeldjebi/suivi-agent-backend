import { HttpException, HttpStatus } from '@nestjs/common';

/** Erreur métier avec un code stable, exploitable par le web et le mobile. */
export class BusinessException extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super({ statusCode: status, code, message, ...details }, status);
  }
}

export const notFound = (what: string) =>
  new BusinessException(
    HttpStatus.NOT_FOUND,
    'NOT_FOUND',
    `${what} introuvable`,
  );

export const forbidden = (message = 'Action non autorisée') =>
  new BusinessException(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);

export const conflict = (code: string, message: string) =>
  new BusinessException(HttpStatus.CONFLICT, code, message);

export const badRequest = (code: string, message: string) =>
  new BusinessException(HttpStatus.BAD_REQUEST, code, message);
