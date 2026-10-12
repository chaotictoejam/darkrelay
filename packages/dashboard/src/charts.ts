import { compact, niceTicks, shortDate } from './format';
import { hideTooltip, showTooltip } from './tooltip';

const NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export interface Point {
  date: string;
  value: number;
}

/**
 * Daily downloads as a single-series line with an area wash. Crosshair snaps
 * to the nearest day on hover and with arrow keys; the last value is labeled.
 */
export function lineChart(points: Point[], label: string): HTMLElement {
  const wrap = document.createElement('figure');
  wrap.className = 'chart';
  const holder = document.createElement('div');
  wrap.append(
    holder,
    tableView(
      ['Date', label],
      points.map((p) => [p.date, p.value]),
    ),
  );
  let drawn = 0;
  const redraw = () => {
    const width = Math.round(holder.clientWidth);
    if (!width || width === drawn) return;
    drawn = width;
    holder.replaceChildren(drawLine(points, label, width));
  };
  // Drawn at the real pixel width so text stays 11px on every screen.
  new ResizeObserver(redraw).observe(holder);
  return wrap;
}

function drawLine(points: Point[], label: string, W: number): SVGSVGElement {
  const H = W < 480 ? 200 : 240;
  const m = { top: 16, right: 40, bottom: 28, left: 36 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = Math.max(...points.map((p) => p.value), 0);
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const x = (i: number) => m.left + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => m.top + ih - (v / top) * ih;

  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': `${label}, ${points.length} days. Use arrow keys to read values.`,
    tabindex: 0,
  });
  for (const t of ticks) {
    root.append(svg('line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t), class: 'grid' }));
    const txt = svg('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'axis' });
    txt.textContent = compact(t);
    root.append(txt);
  }
  const labelIdx = [
    ...new Set(
      W < 480
        ? [0, points.length - 1]
        : [0, Math.floor((points.length - 1) / 2), points.length - 1],
    ),
  ];
  for (const i of labelIdx) {
    if (!points[i]) continue;
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    const txt = svg('text', { x: x(i), y: H - 8, 'text-anchor': anchor, class: 'axis' });
    txt.textContent = shortDate(points[i]!.date);
    root.append(txt);
  }

  if (points.length) {
    const line = points
      .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join('');
    root.append(
      svg('path', { d: `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`, class: 'area' }),
    );
    root.append(svg('path', { d: line, class: 'line' }));
    const last = points.length - 1;
    root.append(svg('circle', { cx: x(last), cy: y(points[last]!.value), r: 4, class: 'dot' }));
    const end = svg('text', { x: x(last) + 10, y: y(points[last]!.value) + 4, class: 'value' });
    end.textContent = compact(points[last]!.value);
    root.append(end);
  }

  const cross = svg('line', {
    y1: m.top,
    y2: m.top + ih,
    class: 'crosshair',
    visibility: 'hidden',
  });
  const hover = svg('circle', { r: 4, class: 'dot', visibility: 'hidden' });
  root.append(cross, hover);
  let active = -1;
  const show = (i: number) => {
    if (!points[i]) return;
    active = i;
    const p = points[i]!;
    cross.setAttribute('x1', String(x(i)));
    cross.setAttribute('x2', String(x(i)));
    hover.setAttribute('cx', String(x(i)));
    hover.setAttribute('cy', String(y(p.value)));
    cross.setAttribute('visibility', 'visible');
    hover.setAttribute('visibility', 'visible');
    const box = root.getBoundingClientRect();
    showTooltip(
      box.left + (x(i) / W) * box.width,
      box.top + (y(p.value) / H) * box.height,
      p.value.toLocaleString('en-US'),
      shortDate(p.date),
    );
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    hover.setAttribute('visibility', 'hidden');
    hideTooltip();
  };
  root.addEventListener('pointermove', (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - m.left) / iw) * (points.length - 1));
    show(Math.max(0, Math.min(points.length - 1, i)));
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = active < 0 ? points.length - 1 : active + (e.key === 'ArrowLeft' ? -1 : 1);
    show(Math.max(0, Math.min(points.length - 1, next)));
  });

  return root;
}

/**
 * Ranked horizontal bars in one hue, value at the tip. Used for apps,
 * countries and devices: magnitude, not identity, so one color is right.
 */
export function barList(
  entries: [string, number][],
  label: string,
  name = (k: string) => k,
): HTMLElement {
  const wrap = document.createElement('figure');
  wrap.className = 'chart bars';
  const total = entries.reduce((n, [, v]) => n + v, 0);
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const list = document.createElement('ol');
  list.setAttribute('aria-label', label);
  for (const [key, value] of entries) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    const lab = document.createElement('span');
    lab.className = 'bar-label';
    lab.textContent = name(key);
    const track = document.createElement('span');
    track.className = 'bar-track';
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.width = `${Math.max((value / max) * 100, 0.5)}%`;
    const val = document.createElement('span');
    val.className = 'bar-value';
    val.textContent = compact(value);
    track.append(bar, val);
    li.append(lab, track);
    const share = total ? ` (${Math.round((value / total) * 100)}%)` : '';
    const tip = (el: Element) => {
      const r = el.getBoundingClientRect();
      showTooltip(
        r.left + r.width / 2,
        r.top,
        `${value.toLocaleString('en-US')}${share}`,
        name(key),
      );
    };
    li.addEventListener('pointerenter', () => tip(bar));
    li.addEventListener('pointerleave', hideTooltip);
    li.addEventListener('focus', () => tip(bar));
    li.addEventListener('blur', hideTooltip);
    list.append(li);
  }
  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No data in this range.';
    wrap.append(p);
  } else {
    wrap.append(list);
  }
  return wrap;
}

export function tableView(headers: string[], rows: (string | number)[][]): HTMLElement {
  const details = document.createElement('details');
  details.className = 'table-view';
  const summary = document.createElement('summary');
  summary.textContent = 'Table';
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of r)
      tr.insertCell().textContent = typeof c === 'number' ? c.toLocaleString('en-US') : c;
  }
  details.append(summary, table);
  return details;
}
