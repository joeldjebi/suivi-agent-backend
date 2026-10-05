import type { Role } from '@suivi/shared';

/** Contenu du jeton d'accès, disponible dans `req.user`. */
export interface AuthUser {
  id: string;
  tenantId: string;
  role: Role;
  email: string;
}
