import { createHash } from 'node:crypto';
import { layout } from './layout';

/**
 * Enough image parsing to check artwork before uploading it: the pixel size
 * from a PNG or JPEG header, read without decoding the image. Podcast apps,
 * YouTube and the dashboard all refuse artwork of the wrong shape, and they
 * do it long after the upload, so the checks happen in the CLI.
 */
export interface ImageInfo {
  type: 'png' | 'jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** JPEG start-of-frame markers; everything else in the range is a different segment. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function uint32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function uint16(b: Uint8Array, at: number): number {
  return (b[at]! << 8) | b[at + 1]!;
}

/** The image's type and pixel size, or undefined if it is neither PNG nor JPEG. */
export function imageSize(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    // IHDR is always the first chunk: length, type, then width and height.
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return undefined;
    return { type: 'png', width: uint32(bytes, 16), height: uint32(bytes, 20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 3 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      // Padding between segments, and standalone markers that carry no length.
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      const length = uint16(bytes, at + 2);
      if (length < 2) return undefined;
      if (SOF.has(marker)) {
        if (at + 9 >= bytes.length) return undefined;
        return { type: 'jpeg', height: uint16(bytes, at + 5), width: uint16(bytes, at + 7) };
      }
      // Scan data follows SOS and has no size of its own, so stop there.
      if (marker === 0xda) return undefined;
      at += 2 + length;
    }
  }
  return undefined;
}

/** Brand icons are shown small, in the dashboard nav and on brand pages. */
export const ICON_MIN_PX = 128;
export const ICON_MAX_PX = 3000;
export const ICON_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What is wrong with an image used as a brand icon, as a list of problems
 * (empty when it is fine). Unreadable headers are reported rather than
 * guessed at: an icon that fails to render in the nav is hard to spot.
 */
export function checkIconImage(bytes: Uint8Array, file = 'image'): string[] {
  const problems: string[] = [];
  if (bytes.length > ICON_MAX_BYTES) {
    problems.push(`${file} is ${Math.ceil(bytes.length / 1024)} KB; the limit is 2 MB`);
  }
  const info = imageSize(bytes);
  if (!info) {
    problems.push(`${file} is not a readable JPEG or PNG`);
    return problems;
  }
  if (info.width !== info.height) {
    problems.push(`${file} is ${info.width}x${info.height}; a brand icon must be square`);
  }
  const smallest = Math.min(info.width, info.height);
  if (smallest < ICON_MIN_PX) {
    problems.push(`${file} is ${info.width}x${info.height}; at least ${ICON_MIN_PX}px is needed`);
  }
  if (Math.max(info.width, info.height) > ICON_MAX_PX) {
    problems.push(`${file} is ${info.width}x${info.height}; ${ICON_MAX_PX}px is the limit`);
  }
  return problems;
}

/** The media type for an icon's actual bytes, whatever the file was called. */
export function iconContentType(type: ImageInfo['type']): string {
  return type === 'png' ? 'image/png' : 'image/jpeg';
}

/**
 * Icons are small and change rarely, and a replaced one gets a new key, so a
 * day in a cache costs nothing and no stale icon can stick.
 */
export const BRAND_ICON_CACHE_CONTROL = 'public, max-age=86400';

/**
 * Content-addressed icon key, so a replaced icon is never served from cache.
 * The extension comes from the bytes rather than the file name: an icon
 * uploaded through the dashboard is named by whatever the browser sent.
 */
export function brandIconKey(slug: string, bytes: Uint8Array, type: ImageInfo['type']): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  return layout.brandIcon(slug, hash, type === 'png' ? 'png' : 'jpg');
}
