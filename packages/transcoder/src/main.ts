import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { TranscodeJob } from '@darkrelay/core';
import { runJob, type JobIO } from './job';

const s3 = new S3Client({});
const job = TranscodeJob.parse(JSON.parse(process.env['JOB'] ?? '{}'));

const io: JobIO = {
  async download(key, path) {
    const r = await s3.send(new GetObjectCommand({ Bucket: job.bucket, Key: key }));
    await pipeline(r.Body as Readable, createWriteStream(path));
  },
  async upload(key, path, contentType, cacheControl) {
    await new Upload({
      client: s3,
      params: {
        Bucket: job.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentType: contentType,
        CacheControl: cacheControl,
      },
    }).done();
  },
  async putJson(key, value) {
    await s3.send(
      new PutObjectCommand({
        Bucket: job.bucket,
        Key: key,
        Body: JSON.stringify(value, null, 2),
        ContentType: 'application/json',
      }),
    );
  },
};

// A Spot interruption sends SIGTERM with two minutes' notice. Exit without
// writing processed.json; the publisher sees the stopped task and retries
// on regular Fargate.
process.on('SIGTERM', () => {
  console.log('SIGTERM: stopping; the publisher will retry this job');
  process.exit(143);
});

const result = await runJob(job, io, '/work/job');
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
