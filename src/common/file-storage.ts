import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Fichiers de l'application (photos du terrain) rangés hors de la base de données, dans un
 * dossier : STORAGE_DIR (en production, le volume « photos » du conteneur), sinon
 * « storage/ » à côté de l'API. Une clé est un chemin relatif, ex.
 * « photos/<structure>/<photo>.jpg ». Écriture atomique : un fichier n'est jamais à moitié
 * écrit, même si le serveur s'arrête pendant l'envoi.
 */
@Injectable()
export class FileStorage {
  private readonly logger = new Logger(FileStorage.name);
  readonly root = resolve(process.env.STORAGE_DIR || 'storage');

  /** Chemin absolu d'une clé ; refuse toute clé qui sortirait du dossier. */
  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep))
      throw new Error(`Clé de fichier invalide : ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.part`;
    await writeFile(tmp, data);
    await rename(tmp, target);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  /** Supprime tout un dossier (ex. les photos d'une structure supprimée). */
  async removeTree(prefix: string): Promise<void> {
    try {
      await rm(this.path(prefix), { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(
        `Suppression de ${prefix} impossible : ${String(error)}`,
      );
    }
  }
}
