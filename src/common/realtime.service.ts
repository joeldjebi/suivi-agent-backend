import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { User } from '../entities';

export const rooms = {
  /** Administrateurs de la structure. */
  admins: (tenantId: string) => `tenant:${tenantId}:admins`,
  /** Chefs d'équipe qui supervisent toute la structure (formule sans groupes). */
  supervisors: (tenantId: string) => `tenant:${tenantId}:supervisors`,
  /** Chef(s) d'équipe d'un groupe. */
  group: (groupId: string) => `group:${groupId}`,
  user: (userId: string) => `user:${userId}`,
};

/** Diffusion Socket.IO ; le serveur est fourni par la passerelle temps réel. */
@Injectable()
export class RealtimeService {
  private server?: Server;

  attach(server: Server) {
    this.server = server;
  }

  emit(roomNames: string[], event: string, payload: unknown) {
    if (!this.server || !roomNames.length) return;
    this.server.to(roomNames).emit(event, payload);
  }
}

/**
 * Salles qui suivent un agent : les administrateurs, le chef de son groupe, et les chefs
 * qui supervisent toute la structure (formule sans groupes).
 */
export function statusRooms(
  tenantId: string,
  agent: Pick<User, 'groupId'>,
): string[] {
  return [
    rooms.admins(tenantId),
    rooms.supervisors(tenantId),
    ...(agent.groupId ? [rooms.group(agent.groupId)] : []),
  ];
}
