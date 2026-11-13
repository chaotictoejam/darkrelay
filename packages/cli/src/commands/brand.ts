import { readFile } from 'node:fs/promises';
import {
  BRAND_ICON_CACHE_CONTROL,
  BrandConfig,
  DEFAULT_RSS_OUTLET_ID,
  DEFAULT_YOUTUBE_OUTLET_ID,
  OUTLET_KINDS,
  Outlet,
  SLUG,
  brandFromShow,
  brandIconKey,
  catalogSlug,
  checkIconImage,
  feedShow,
  feedUrl,
  iconContentType,
  imageSize,
  layout,
  outletName,
  outletSource,
  publicKey,
  resolveAsset,
  withOutlet,
  withoutOutlet,
  type BrandConfigInput,
  type OutletInput,
  type OutletKind,
} from '@darkrelay/core';
import { z } from 'zod';
import { Bucket, resolveDeployment, type GlobalOptions } from '../context';
import { loadShow } from './show';

/**
 * A brand's config, or the brand an unmigrated show stands for. Reads never
 * need the migration to have run: a show with no brand.json is the brand it
 * will become, derived in memory.
 */
export async function loadBrand(bucket: Bucket, slug: string): Promise<BrandConfig | undefined> {
  const raw = await bucket.getText(layout.brandConfig(slug));
  if (raw !== undefined) return BrandConfig.parse(JSON.parse(raw));
  const show = await loadShow(bucket, slug);
  return show ? brandFromShow(show) : undefined;
}

async function requireBrand(bucket: Bucket, slug: string): Promise<BrandConfig> {
  const brand = await loadBrand(bucket, slug);
  if (!brand) throw new Error(`No brand or show "${slug}" in this deployment`);
  return brand;
}

async function writeBrand(bucket: Bucket, brand: BrandConfig, now = new Date()) {
  const stored = { ...brand, updatedAt: now.toISOString() };
  await bucket.putText(layout.brandConfig(brand.slug), JSON.stringify(stored, null, 2));
  return stored;
}

export interface CatalogEntry {
  slug: string;
  /** Has a brand.json of its own (the migration has run for it). */
  brand: boolean;
  /** Has a show.json: a feed DarkRelay hosts. */
  show: boolean;
}

/** Which slugs under `catalog/` have a brand config, a feed config, or both. */
export function catalogEntries(keys: string[]): CatalogEntry[] {
  const found = new Map<string, CatalogEntry>();
  const mark = (slug: string, field: 'brand' | 'show') => {
    const entry = found.get(slug) ?? { slug, brand: false, show: false };
    entry[field] = true;
    found.set(slug, entry);
  };
  for (const key of keys) {
    const brand = catalogSlug(key, 'brand.json');
    if (brand) mark(brand, 'brand');
    const show = catalogSlug(key, 'show.json');
    if (show) mark(show, 'show');
  }
  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface MigrationPlan {
  create: string[];
  skip: { slug: string; reason: string }[];
}

/**
 * Which shows need a brand.json written. A show that already has one is left
 * alone unless `--force` is passed, because a stored brand may carry a name,
 * icon and outlets that its show config knows nothing about.
 */
export function planMigration(
  entries: CatalogEntry[],
  opts: { slug?: string; force?: boolean } = {},
): MigrationPlan {
  const chosen = opts.slug ? entries.filter((e) => e.slug === opts.slug) : entries;
  if (opts.slug && !chosen.length) {
    throw new Error(`No brand or show "${opts.slug}" in this deployment`);
  }
  const plan: MigrationPlan = { create: [], skip: [] };
  for (const entry of chosen) {
    if (!entry.show) plan.skip.push({ slug: entry.slug, reason: 'no feed to migrate' });
    else if (entry.brand && !opts.force)
      plan.skip.push({ slug: entry.slug, reason: 'already a brand' });
    else plan.create.push(entry.slug);
  }
  return plan;
}

export interface OutletFlags {
  kind?: string;
  id?: string;
  label?: string;
  connection?: string;
  /** For an `rss` outlet: the feed config's slug (default: the brand's own). */
  feed?: string;
  url?: string;
  channelId?: string;
}

/**
 * One outlet from command-line flags. Ids default to the kind, so a brand's
 * first feed is `rss` and its first channel `youtube`; name an id to add a
 * second of the same kind.
 */
export function buildOutlet(brandSlug: string, flags: OutletFlags, now = new Date()): Outlet {
  const kind = flags.kind as OutletKind | undefined;
  if (!kind || !OUTLET_KINDS.includes(kind)) {
    throw new Error(`--kind must be one of ${OUTLET_KINDS.join(', ')}`);
  }
  const addedAt = now.toISOString();
  let raw: OutletInput;
  if (kind === 'rss') {
    const show = flags.feed ?? brandSlug;
    if (!SLUG.test(show)) throw new Error(`"${show}" is not a slug`);
    raw = { kind, id: flags.id ?? DEFAULT_RSS_OUTLET_ID, show, label: flags.label, addedAt };
  } else if (kind === 'youtube') {
    if (!flags.connection) {
      throw new Error('A YouTube outlet needs --connection <name> (darkrelay youtube connect)');
    }
    raw = {
      kind,
      id: flags.id ?? DEFAULT_YOUTUBE_OUTLET_ID,
      connection: flags.connection,
      channelId: flags.channelId,
      label: flags.label,
      addedAt,
    };
  } else {
    raw = { kind, id: flags.id ?? kind, url: flags.url, label: flags.label, addedAt };
  }
  const parsed = Outlet.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid outlet:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Every brand in the deployment, with its outlets. */
export async function listBrands(global: GlobalOptions) {
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const entries = catalogEntries(await bucket.list('catalog/'));
  if (!entries.length) return console.log('No brands yet. Create one with: darkrelay show put');
  for (const entry of entries) {
    const brand = await loadBrand(bucket, entry.slug);
    if (!brand) continue;
    const note = entry.brand ? '' : '  (not migrated: brand derived from its show)';
    console.log(`${brand.slug}  ${brand.name}${note}`);
    for (const outlet of brand.outlets) {
      console.log(`  ${outlet.id.padEnd(12)} ${outlet.kind.padEnd(8)} ${outletName(outlet)}`);
      if (outlet.kind === 'rss') console.log(`  ${''.padEnd(12)} ${feedUrl(baseUrl, outlet.show)}`);
    }
    if (!brand.outlets.length) console.log('  no outlets');
  }
}

export async function getBrand(slug: string, global: GlobalOptions) {
  const { bucket: name } = await resolveDeployment(global);
  console.log(JSON.stringify(await requireBrand(new Bucket(name), slug), null, 2));
}

/**
 * Creates or updates a brand from a JSON file, the way `show put` does for a
 * feed. Fields the file leaves out keep their current values.
 */
export async function putBrand(file: string, flags: { icon?: string }, global: GlobalOptions) {
  const input = JSON.parse(await readFile(file, 'utf8')) as Partial<BrandConfigInput>;
  if (!input.slug) throw new Error('brand file needs a "slug"');
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const existing = await loadBrand(bucket, input.slug);

  const parsed = BrandConfig.safeParse({
    schemaVersion: 1,
    ...existing,
    ...input,
    icon: flags.icon
      ? await uploadIcon(bucket, input.slug, flags.icon)
      : (input.icon ?? existing?.icon),
  });
  if (!parsed.success) throw new Error(`Invalid brand:\n${z.prettifyError(parsed.error)}`);
  const stored = await writeBrand(bucket, parsed.data);
  console.log(`${existing ? 'Updated' : 'Created'} brand ${stored.slug} (${stored.name}).`);
  await reportBrand(bucket, stored, baseUrl);
}

export async function setBrandIcon(slug: string, image: string, global: GlobalOptions) {
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const brand = await requireBrand(bucket, slug);
  const icon = await uploadIcon(bucket, slug, image);
  await writeBrand(bucket, { ...brand, icon });
  console.log(`Icon for ${slug}: ${resolveAsset(icon, baseUrl)}`);
}

async function uploadIcon(bucket: Bucket, slug: string, file: string) {
  const bytes = await readFile(file);
  const problems = checkIconImage(bytes, file);
  if (problems.length) throw new Error(problems.join('\n'));
  const type = imageSize(bytes)!.type;
  const key = brandIconKey(slug, bytes, type);
  await bucket.uploadFile(publicKey(key), file, iconContentType(type), BRAND_ICON_CACHE_CONTROL);
  return { key };
}

/**
 * Writes brand.json for shows that have none. Nothing a podcast app can see
 * changes: the feed, its `podcast:guid` and every episode `<guid>` are left
 * exactly as they are, and the brand keeps the show's slug.
 */
export async function migrateBrands(
  slug: string | undefined,
  flags: { dryRun?: boolean; force?: boolean },
  global: GlobalOptions,
) {
  const { bucket: name } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const plan = planMigration(catalogEntries(await bucket.list('catalog/')), {
    slug,
    force: flags.force,
  });
  for (const { slug: skipped, reason } of plan.skip) console.log(`  ${skipped}: ${reason}`);
  if (!plan.create.length) return console.log('Nothing to migrate.');

  for (const brandSlug of plan.create) {
    const show = await loadShow(bucket, brandSlug);
    if (!show) continue;
    const brand = brandFromShow(show);
    const outlets = brand.outlets.map((o) => `${o.id} (${o.kind})`).join(', ');
    if (flags.dryRun) {
      console.log(`  would create brand ${brand.slug} "${brand.name}" with ${outlets}`);
      continue;
    }
    await writeBrand(bucket, brand);
    console.log(`  ${brand.slug} "${brand.name}" -> ${outlets}`);
  }
  console.log(
    flags.dryRun
      ? `\n${plan.create.length} brand(s) would be written. Nothing changed.`
      : `\nMigrated ${plan.create.length} brand(s). Feeds and GUIDs are untouched.`,
  );
}

/** Adds an outlet, or replaces the one with the same id. */
export async function addOutlet(slug: string, flags: OutletFlags, global: GlobalOptions) {
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const brand = await requireBrand(bucket, slug);
  const outlet = buildOutlet(slug, flags);
  if (outlet.kind === 'rss' && !(await bucket.exists(layout.showConfig(outlet.show)))) {
    throw new Error(
      `No feed config at ${layout.showConfig(outlet.show)}. Create it with: darkrelay show put`,
    );
  }
  const replaced = brand.outlets.some((o) => o.id === outlet.id);
  const stored = await writeBrand(bucket, withOutlet(brand, outlet));
  console.log(
    `${replaced ? 'Replaced' : 'Added'} outlet ${outlet.id} (${outlet.kind}) on ${slug}.`,
  );
  await reportBrand(bucket, stored, baseUrl);
}

/**
 * Removes an outlet from a brand. Nothing is deleted or unpublished: a feed
 * keeps serving and a channel keeps its videos; the brand just stops
 * counting that outlet.
 */
export async function removeOutlet(slug: string, id: string, global: GlobalOptions) {
  const { bucket: name } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const brand = await requireBrand(bucket, slug);
  const outlet = brand.outlets.find((o) => o.id === id);
  if (!outlet) throw new Error(`${slug} has no outlet "${id}"`);
  await writeBrand(bucket, withoutOutlet(brand, id));
  console.log(`Removed outlet ${id} (${outlet.kind}) from ${slug}.`);
  if (outlet.kind === 'rss') {
    console.log(
      `The feed itself is untouched and still public. To stop publishing it: darkrelay show draft ${outlet.show}`,
    );
  }
}

async function reportBrand(bucket: Bucket, brand: BrandConfig, baseUrl: string) {
  if (brand.icon) console.log(`Icon: ${resolveAsset(brand.icon, baseUrl)}`);
  const feed = feedShow(brand);
  console.log(feed ? `Feed: ${feedUrl(baseUrl, feed)}` : 'No feed outlet (nothing is published).');
  for (const outlet of brand.outlets) {
    console.log(
      `  ${outlet.id.padEnd(12)} ${outlet.kind.padEnd(8)} source=${outletSource(outlet)}`,
    );
  }
  if (feed && !(await bucket.exists(layout.showConfig(feed)))) {
    console.log(`WARNING: no feed config at ${layout.showConfig(feed)}.`);
  }
}

/**
 * Wires a connected YouTube channel into a brand, creating the brand if it
 * does not exist yet. This is how a brand with no feed comes into being: the
 * channel is the only outlet it has.
 */
export async function attachYouTubeOutlet(
  global: GlobalOptions,
  slug: string,
  channel: { connection: string; channelId?: string; channelTitle?: string; id?: string },
) {
  if (!SLUG.test(slug)) throw new Error(`"${slug}" is not a brand slug`);
  const { bucket: name, baseUrl } = await resolveDeployment(global);
  const bucket = new Bucket(name);
  const existing = await loadBrand(bucket, slug);
  const base =
    existing ??
    BrandConfig.parse({
      schemaVersion: 1,
      slug,
      name: channel.channelTitle ?? slug,
      outlets: [],
    });
  // An outlet already wrapping this connection keeps its id, so connecting
  // again updates it instead of adding a second outlet for one channel.
  const sameConnection = base.outlets.find(
    (o) => o.kind === 'youtube' && o.connection === channel.connection,
  );
  const outlet = Outlet.parse({
    kind: 'youtube',
    id: channel.id ?? sameConnection?.id ?? DEFAULT_YOUTUBE_OUTLET_ID,
    connection: channel.connection,
    channelId: channel.channelId,
    channelTitle: channel.channelTitle,
    addedAt: new Date().toISOString(),
  });
  const stored = await writeBrand(bucket, withOutlet(base, outlet));
  console.log(
    `${existing ? 'Updated' : 'Created'} brand ${slug} ("${stored.name}") with YouTube outlet ${outlet.id}.`,
  );
  await reportBrand(bucket, stored, baseUrl);
  return stored;
}
