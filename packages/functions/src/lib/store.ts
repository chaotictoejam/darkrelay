import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface WriteOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ListedObject {
  key: string;
  size: number;
}

/** The slice of S3 the publisher needs. Swapped for an in-memory version in tests. */
export interface Store {
  getText(key: string): Promise<string | undefined>;
  head(key: string): Promise<{ size: number; metadata: Record<string, string> } | undefined>;
  put(key: string, body: string | Uint8Array, opts?: WriteOptions): Promise<void>;
  copy(from: string, to: string, opts?: WriteOptions): Promise<void>;
  list(prefix: string): Promise<ListedObject[]>;
  delete(keys: string[]): Promise<void>;
}

export class S3Store implements Store {
  constructor(
    private readonly bucket: string,
    private readonly s3 = new S3Client({}),
  ) {}

  async getText(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await r.Body!.transformToString('utf-8');
    } catch (e) {
      if (e instanceof NoSuchKey) return undefined;
      throw e;
    }
  }

  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, metadata: r.Metadata ?? {} };
    } catch (e) {
      if (e instanceof NotFound) return undefined;
      throw e;
    }
  }

  async put(key: string, body: string | Uint8Array, opts: WriteOptions = {}) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        Metadata: opts.metadata,
      }),
    );
  }

  async copy(from: string, to: string, opts: WriteOptions = {}) {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: to,
        CopySource: `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        Metadata: opts.metadata,
      }),
    );
  }

  async list(prefix: string) {
    const out: ListedObject[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
      token = r.NextContinuationToken;
    } while (token);
    return out;
  }

  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}
