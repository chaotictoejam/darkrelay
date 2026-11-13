import { describe, expect, it } from 'vitest';
import { ICON_MAX_BYTES, brandIconKey, checkIconImage, imageSize } from '../src';

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8);
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  b.set([width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255], 16);
  b.set([height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255], 20);
  return b;
}

/** FFD8, a small APP0 segment, then a start-of-frame carrying the size. */
function jpeg(width: number, height: number, marker = 0xc0): Uint8Array {
  const soi = [0xff, 0xd8];
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  // Start of frame: marker, segment length 17, sample precision.
  const sof = [0xff, marker, 0x00, 0x11, 0x08];
  const size = [height >>> 8, height & 255, width >>> 8, width & 255];
  // One component, described by three bytes each; the parser skips them.
  const components = [0x03, ...new Array<number>(9).fill(0)];
  return new Uint8Array([...soi, ...app0, ...sof, ...size, ...components]);
}

function padTo(bytes: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  out.set(bytes, 0);
  return out;
}

describe('imageSize', () => {
  it('reads PNG dimensions', () => {
    expect(imageSize(png(1400, 1400))).toEqual({ type: 'png', width: 1400, height: 1400 });
    expect(imageSize(png(3000, 1688))).toEqual({ type: 'png', width: 3000, height: 1688 });
  });

  it('reads baseline and progressive JPEG dimensions, skipping other segments', () => {
    expect(imageSize(jpeg(1280, 720))).toEqual({ type: 'jpeg', width: 1280, height: 720 });
    expect(imageSize(jpeg(512, 512, 0xc2))).toEqual({ type: 'jpeg', width: 512, height: 512 });
  });

  it('returns nothing for other formats and truncated headers', () => {
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeUndefined();
    expect(imageSize(new Uint8Array(0))).toBeUndefined();
    expect(imageSize(png(100, 100).subarray(0, 20))).toBeUndefined();
    expect(imageSize(jpeg(100, 100).subarray(0, 12))).toBeUndefined();
    // A PNG whose first chunk is not IHDR is not one we can trust.
    const broken = png(100, 100);
    broken.set([0x69, 0x44, 0x41, 0x54], 12);
    expect(imageSize(broken)).toBeUndefined();
  });
});

describe('checkIconImage', () => {
  it('accepts a square PNG or JPEG', () => {
    expect(checkIconImage(png(512, 512))).toEqual([]);
    expect(checkIconImage(jpeg(1400, 1400))).toEqual([]);
  });

  it('rejects an icon that is not square', () => {
    expect(checkIconImage(jpeg(1280, 720), 'banner.jpg')).toEqual([
      'banner.jpg is 1280x720; a brand icon must be square',
    ]);
  });

  it('rejects icons that are too small, too large or too heavy', () => {
    expect(checkIconImage(png(64, 64))[0]).toMatch(/at least 128px/);
    expect(checkIconImage(png(4000, 4000))[0]).toMatch(/3000px is the limit/);
    expect(checkIconImage(padTo(png(512, 512), ICON_MAX_BYTES + 1))[0]).toMatch(/limit is 2 MB/);
  });

  it('rejects anything it cannot read, and says so once', () => {
    expect(checkIconImage(new Uint8Array([1, 2, 3]), 'icon.svg')).toEqual([
      'icon.svg is not a readable JPEG or PNG',
    ]);
  });
});

describe('brandIconKey', () => {
  it('addresses the icon by its content, so a replacement is never cached', () => {
    const a = brandIconKey('cc', new Uint8Array([1, 2, 3]), 'png');
    const b = brandIconKey('cc', new Uint8Array([4, 5, 6]), 'png');
    expect(a).toMatch(/^cc\/icon-[0-9a-f]{8}\.png$/);
    expect(a).not.toBe(b);
  });

  it('names the file after the bytes, not after what the upload was called', () => {
    expect(brandIconKey('cc', new Uint8Array([1]), 'jpeg')).toMatch(/\.jpg$/);
  });
});
