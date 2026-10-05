import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DataSource, EntityManager } from 'typeorm';

interface DbContext {
  manager: EntityManager;
  tenantId: string | null;
  afterCommit: (() => void)[];
}

/**
 * Chaque requête et chaque tâche s'exécute dans une transaction où
 * `app.tenant_id` est positionné : la Row Level Security filtre alors
 * toutes les lignes sur la structure courante.
 */
@Injectable()
export class DbService {
  private readonly logger = new Logger(DbService.name);
  private readonly storage = new AsyncLocalStorage<DbContext>();

  constructor(private readonly dataSource: DataSource) {}

  get manager(): EntityManager {
    return this.context().manager;
  }

  get tenantId(): string {
    const { tenantId } = this.context();
    if (!tenantId) throw new Error('Aucune structure dans le contexte courant');
    return tenantId;
  }

  /** Exécute `fn` une fois la transaction validée (diffusion temps réel, etc.). */
  afterCommit(fn: () => void): void {
    this.context().afterCommit.push(fn);
  }

  runAsTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.run(tenantId, fn);
  }

  /** Contourne la RLS : réservé à la connexion et aux tâches planifiées. */
  runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
    return this.run(null, fn);
  }

  private context(): DbContext {
    const context = this.storage.getStore();
    if (!context) throw new Error('Aucun contexte de base de données actif');
    return context;
  }

  private async run<T>(
    tenantId: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const context: DbContext = {
      manager: runner.manager,
      tenantId,
      afterCommit: [],
    };
    try {
      await runner.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.bypass_rls', $2, true)`,
        [tenantId ?? '', tenantId ? 'off' : 'on'],
      );
      const result = await this.storage.run(context, fn);
      await runner.commitTransaction();
      for (const callback of context.afterCommit) {
        try {
          callback();
        } catch (error) {
          this.logger.error('Échec d’un traitement après validation', error);
        }
      }
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
