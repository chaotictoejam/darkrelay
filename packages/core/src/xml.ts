export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Wraps text in CDATA, splitting any `]]>` so the section can't be closed early. */
export function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

type Attrs = Record<string, string | number | boolean | undefined>;

function attrs(a: Attrs): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');
}

/** Element with escaped text content. Returns '' when the value is undefined. */
export function el(name: string, value: string | number | undefined, a: Attrs = {}): string {
  if (value === undefined) return '';
  return `<${name}${attrs(a)}>${escapeXml(String(value))}</${name}>`;
}

export function empty(name: string, a: Attrs): string {
  return `<${name}${attrs(a)}/>`;
}

export function raw(name: string, inner: string, a: Attrs = {}): string {
  return `<${name}${attrs(a)}>${inner}</${name}>`;
}
