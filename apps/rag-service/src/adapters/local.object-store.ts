import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ObjectStore, StoredObject } from '../ports.js';

/**
 * Filesystem stand-in for S3, so document upload/indexing works in local dev
 * with no AWS account. Same interface, so the ingestion path is identical.
 *
 * Keys are confined to the storage root: a caller cannot escape it with `../`,
 * because the resolved path is re-checked against the root before any write.
 */
@Injectable()
export class LocalObjectStore implements ObjectStore {
  readonly name = 'local';
  private readonly log = new Logger(LocalObjectStore.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('LOCAL_STORAGE_DIR', './.local-storage'));
  }

  async put(key: string, body: Buffer, contentType: string): Promise<{ etag: string | null }> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await this.writeSidecar(path, contentType);
    return { etag: createHash('md5').update(body).digest('hex') };
  }

  async get(key: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    const body = await readFile(path);
    return { body, contentType: await this.readSidecar(path), etag: null };
  }

  /**
   * A `file://` URL the browser cannot PUT to, so the web app detects the local
   * store and uploads through the API instead. Same 200 response either way.
   */
  async presignPut(_key: string, _contentType: string, _expiresInSeconds: number): Promise<string> {
    return `local://${this.root}`;
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta`, { force: true });
  }

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.log.log(`Local object store ready at ${this.root}`);
  }

  /** Rejects traversal: `a/../../etc/passwd` must not resolve outside root. */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Refusing to access ${key}: resolves outside the storage root`);
    }
    return path;
  }

  private async writeSidecar(path: string, contentType: string): Promise<void> {
    await writeFile(`${path}.meta`, contentType, 'utf8');
  }

  private async readSidecar(path: string): Promise<string> {
    return readFile(`${path}.meta`, 'utf8')
      .then((t) => t.trim())
      .catch(() => 'application/octet-stream');
  }
}
