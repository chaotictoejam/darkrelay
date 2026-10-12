const tip = () => document.getElementById('tooltip') as HTMLDivElement;

/** Value leads, label follows. Text only, never innerHTML: labels come from data. */
export function showTooltip(x: number, y: number, value: string, label: string) {
  const el = tip();
  el.replaceChildren();
  const v = document.createElement('strong');
  v.textContent = value;
  const l = document.createElement('span');
  l.textContent = label;
  el.append(v, l);
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
  const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

export function hideTooltip() {
  tip().hidden = true;
}
