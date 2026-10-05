import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser } from '../common/auth-user';
import { SessionRevocationService } from '../common/session-revocation.service';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: AuthUser['role'];
  email: string;
  /** Date d'émission (secondes), ajoutée par la bibliothèque JWT */
  iat?: number;
  /** Date d'émission précise (millisecondes) : une révocation n'invalide pas un jeton émis juste après */
  iam?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly revocation: SessionRevocationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (await this.revocation.isRevoked(payload.sub, payload)) {
      throw new UnauthorizedException('Session révoquée');
    }
    return {
      id: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      email: payload.email,
    };
  }
}
