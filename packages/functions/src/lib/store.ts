import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';

const SINGLE_COPY_LIMIT = 5 * 1024 ** 3;
const PART_SIZE = 512 * 1024 ** 2;

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
  /** Writes only if the key doesn't exist yet. False when it already did. */
  createIfAbsent(key: string, body: string, opts?: WriteOptions): Promise<boolean>;
  /** Bytes [start, end] inclusive. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array>;
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
    const size = (await this.head(from))?.size ?? 0;
    if (size > SINGLE_COPY_LIMIT) return this.multipartCopy(from, to, size, opts);
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

  async createIfAbsent(key: string, body: string, opts: WriteOptions = {}) {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          IfNoneMatch: '*',
          ContentType: opts.contentType,
        }),
      );
      return true;
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 412 || status === 409) return false;
      throw e;
    }
  }

  async getRange(key: string, start: number, end: number) {
    const r = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    return r.Body!.transformToByteArray();
  }

  /** CopyObject stops at 5 GB; long 1080p videos can be bigger. */
  private async multipartCopy(from: string, to: string, size: number, opts: WriteOptions) {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: to,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        Metadata: opts.metadata,
      }),
    );
    try {
      const source = `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
      const parts: { ETag: string; PartNumber: number }[] = [];
      for (let start = 0, n = 1; start < size; start += PART_SIZE, n++) {
        const end = Math.min(start + PART_SIZE, size) - 1;
        const r = await this.s3.send(
          new UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: to,
            UploadId,
            PartNumber: n,
            CopySource: source,
            CopySourceRange: `bytes=${start}-${end}`,
          }),
        );
        parts.push({ ETag: r.CopyPartResult!.ETag!, PartNumber: n });
      }
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: to,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (e) {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: to, UploadId }),
      );
      throw e;
    }
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
