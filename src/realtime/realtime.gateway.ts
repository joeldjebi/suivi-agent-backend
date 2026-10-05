import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Role } from '@suivi/shared';
import type { Server, Socket } from 'socket.io';
import { AccessService } from '../common/access.service';
import { DbService } from '../common/db.service';
import { RealtimeService, rooms } from '../common/realtime.service';
import type { JwtPayload } from '../auth/jwt.strategy';

/**
 * Connexion temps réel : `io(url, { auth: { token: '<accessToken>' } })`.
 * Chaque client rejoint sa salle personnelle ; les administrateurs suivent toute la structure,
 * les chefs d'équipe leurs groupes.
 */
@WebSocketGateway({ cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth as { token?: string }).token;
      if (!token) throw new Error('Jeton manquant');
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      const joined = [rooms.user(payload.sub), rooms.tenant(payload.tenantId)];
      if (payload.role === Role.Admin)
        joined.push(rooms.admins(payload.tenantId));
      if (payload.role === Role.TeamLead) {
        const { all, groupIds } = await this.db.runAsTenant(
          payload.tenantId,
          async () => ({
            all: await this.access.supervisesAll(payload),
            groupIds: await this.access.leaderGroupIds(payload.sub),
          }),
        );
        // Sans groupes, le chef suit tous les agents de la structure.
        if (all) joined.push(rooms.supervisors(payload.tenantId));
        joined.push(...groupIds.map(rooms.group));
      }
      await client.join(joined);
    } catch (error) {
      this.logger.debug(
        `Connexion temps réel refusée : ${(error as Error).message}`,
      );
      client.disconnect(true);
    }
  }
}
