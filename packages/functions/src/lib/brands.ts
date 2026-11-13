import {
  BrandConfig,
  ShowConfig,
  brandFromShow,
  catalogSlug,
  layout,
  type BrandConfig as Brand,
} from '@darkrelay/core';
import type { Store } from './store';

type Reader = Pick<Store, 'getText'>;
type Lister = Pick<Store, 'getText' | 'list'>;
type Log = (message: string, data?: Record<string, unknown>) => void;

/**
 * A brand as stored, or the brand a show that has not been migrated stands
 * for. Ingestion never waits for `brand migrate` to have run: a show with no
 * brand.json is read as the brand it will become, with the same slug.
 */
export async function loadBrand(
  store: Reader,
  slug: string,
  log: Log = () => {},
): Promise<Brand | undefined> {
  const raw = await store.getText(layout.brandConfig(slug));
  if (raw !== undefined) {
    const parsed = BrandConfig.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    // Falling through to the show keeps a brand file with a typo in it from
    // taking the feed's numbers down with it.
    log('Invalid brand.json; falling back to its show', { slug, issues: parsed.error.issues });
  }
  const showRaw = await store.getText(layout.showConfig(slug));
  if (showRaw === undefined) return undefined;
  const show = ShowConfig.safeParse(JSON.parse(showRaw));
  if (!show.success) {
    log('Invalid show.json; skipping brand', { slug, issues: show.error.issues });
    return undefined;
  }
  return brandFromShow(show.data);
}

/** Every brand under `catalog/`: those with a brand file, a feed, or both. */
export async function listBrands(store: Lister, log: Log = () => {}): Promise<Brand[]> {
  const slugs = new Set<string>();
  for (const { key } of await store.list('catalog/')) {
    const brand = catalogSlug(key, 'brand.json');
    if (brand) slugs.add(brand);
    const show = catalogSlug(key, 'show.json');
    if (show) slugs.add(show);
  }
  const brands: Brand[] = [];
  for (const slug of [...slugs].sort()) {
    const brand = await loadBrand(store, slug, log);
    if (brand) brands.push(brand);
  }
  return brands;
}
