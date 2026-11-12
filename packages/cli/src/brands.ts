/**
 * `--show` is the old name of `--brand`. Every command that took one takes
 * both, so existing scripts keep working; the actions normalize them to one
 * slug before anything else happens.
 */
export interface BrandFlags {
  brand?: string;
  show?: string;
}

export function oneBrand(flags: BrandFlags): string {
  if (flags.brand && flags.show && flags.brand !== flags.show) {
    throw new Error(
      `--brand ${flags.brand} and --show ${flags.show} name different brands; pass one`,
    );
  }
  const brand = flags.brand ?? flags.show;
  if (!brand) throw new Error("Pass --brand <slug> ('--show' is its old name)");
  return brand;
}

export function manyBrands(flags: { brand?: string[]; show?: string[] }): string[] {
  return [...new Set([...(flags.brand ?? []), ...(flags.show ?? [])])];
}
