import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { ObjectStore, StoredObject } from '../ports.js';

/**
 * AWS S3 for user documents. Uploads go browser -> S3 directly through a
 * presigned URL, so document bytes never pass through the API process and a
 * 10MB PDF costs it no memory or bandwidth.
 *
 * Credentials follow the standard AWS chain (env, ~/.aws, instance role), so
 * nothing extra is required when running on EC2/ECS with an instance profile.
 */
@Injectable()
export class S3ObjectStore implements ObjectStore {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    const bucket = config.get<string>('S3_BUCKET');
    if (!bucket) throw new Error('S3_BUCKET is required for OBJECT_STORE=s3');

    this.bucket = bucket;
    this.client = new S3Client({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      // Optional, for MinIO / LocalStack in development.
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true' || undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<{ etag: string | null }> {
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Documents are private; the API only ever hands out presigned URLs.
        ServerSideEncryption: 'AES256',
      }),
    );
    return { etag: res.ETag?.replace(/"/g, '') ?? null };
  }

  async get(key: string): Promise<StoredObject> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`S3 object ${key} had no body`);

    const body = await streamToBuffer(res.Body as Readable);
    return {
      body,
      contentType: res.ContentType ?? 'application/octet-stream',
      etag: res.ETag?.replace(/"/g, '') ?? null,
    };
  }

  async presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Proves both the credentials and that the bucket actually exists. */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
