import {
  BRAND_ICON_CACHE_CONTROL,
  BrandConfig,
  ICON_MAX_BYTES,
  SLUG,
  brandIconKey,
  brandMetaItem,
  canUpload,
  checkIconImage,
  iconContentType,
  imageSize,
  layout,
  publicKey,
  resolveAsset,
  type Access,
} from '@darkrelay/core';
import { z } from 'zod';
import { error, isResponse, parse, type ApiResponse } from '../lib/http';
import type { Store } from '../lib/store';
import { loadBrand } from '../lib/brands';

export interface BrandDeps {
  store: Pick<Store, 'getText' | 'put'>;
  /**
   * The brand's dashboard row. The ingestion runs write the same item, but
   * they run once a day: writing it here is what makes a new icon show up in
   * the switcher straight away instead of tomorrow morning.
   */
  saveMeta(item: Record<string, unknown>): Promise<void>;
  /** Public media base URL, so the response carries the icon's URL. */
  publicBaseUrl?: string;
  now(): Date;
}

export interface BrandRequest {
  method: string;
  path: string;
  body: unknown;
  access: Access;
}

/** Base64 of the largest icon allowed, plus room for padding. */
const MAX_BASE64 = Math.ceil(ICON_MAX_BYTES / 3) * 4 + 4;

const IconBody = z.object({
  /** The picked file's name. Only used in the messages sent back. */
  filename: z.string().min(1).max(200).optional(),
  /** The image itself, base64, with no data: prefix. */
  data: z
    .string()
    .min(1)
    .max(MAX_BASE64)
    .regex(/^[A-Za-z0-9+/\s]+={0,2}$/, 'is not base64'),
});

/**
 * Brand writes from the dashboard. Reads go to the analytics function, which
 * only ever touches DynamoDB; this one holds the few permissions a change to
 * brand.json needs, and checks the caller's role for the brand on every
 * route — the UI hiding a button is not the protection.
 */
export async function route(deps: BrandDeps, req: BrandRequest): Promise<ApiResponse> {
  const parts = req.path.split('/').filter(Boolean);
  // `/brands` is the name the dashboard uses; `/shows` is the same tree under
  // its older name, as on the read side.
  if (parts[0] !== 'brands' && parts[0] !== 'shows') return error(404, 'Not found');
  const slug = parts[1];
  if (!slug || !SLUG.test(slug)) return error(400, 'Bad brand');
  if (parts.length === 3 && parts[2] === 'icon' && req.method === 'POST')
    return setIcon(deps, slug, req.access, req.body);
  return error(404, 'Not found');
}

/**
 * Replaces a brand's icon. The bytes are checked here, not only in the
 * browser, and the key is derived from them, so a replacement never lands on
 * the old URL and no cache can serve the icon it replaced.
 *
 * A brand that has no brand.json yet (a show the migration has not reached)
 * gets one written, derived from its feed config exactly as every read
 * already derives it. Nothing a podcast app can see changes.
 */
async function setIcon(
  deps: BrandDeps,
  slug: string,
  access: Access,
  body: unknown,
): Promise<ApiResponse> {
  if (!canUpload(access, slug)) return error(403, "You can't change this brand");
  const input = parse(IconBody, body);
  if (isResponse(input)) return input;
  const brand = await loadBrand(deps.store, slug);
  if (!brand) return error(404, `No brand "${slug}" in this deployment`);

  const name = input.filename ?? 'icon';
  const bytes = new Uint8Array(Buffer.from(input.data, 'base64'));
  // Everything the icon has to be — square, big enough, small enough, and a
  // readable PNG or JPEG — is checked from the bytes themselves.
  const problems = checkIconImage(bytes, name);
  if (problems.length) return error(400, problems);

  const type = imageSize(bytes)!.type;
  const key = brandIconKey(slug, bytes, type);
  await deps.store.put(publicKey(key), bytes, {
    contentType: iconContentType(type),
    cacheControl: BRAND_ICON_CACHE_CONTROL,
  });
  const updated = BrandConfig.parse({
    ...brand,
    icon: { key },
    updatedAt: deps.now().toISOString(),
  });
  await deps.store.put(layout.brandConfig(slug), JSON.stringify(updated, null, 2), {
    contentType: 'application/json',
  });
  await deps.saveMeta(brandMetaItem(updated));
  return {
    statusCode: 200,
    body: {
      brand: slug,
      iconKey: key,
      iconUrl: deps.publicBaseUrl ? resolveAsset({ key }, deps.publicBaseUrl) : undefined,
    },
  };
}
