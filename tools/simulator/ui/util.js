export const HOUR = 3600e3, MIN = 60e3;
export const $ = id => document.getElementById(id);
export const fmt = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '–' : (Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v).toFixed(d);
export const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
export const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayLabel = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const store = {
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable or full */ } },
};

// Small DOM builder. Text always goes in through textContent.
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in (props || {})) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export function tile(k, v, unit, lines) {
  return h('div', { class: 'tile' },
    h('div', { class: 'k', text: k }),
    h('div', { class: 'v' }, v, unit ? h('small', { text: unit }) : null),
    lines.map(l => h('div', { class: 'd' }, ...l)));
}
export function delta(cur, base, digits, unit, lowerIsBetter) {
  const s = h('span');
  if (cur === null || base === null || !isFinite(cur) || !isFinite(base)) return s;
  const diff = cur - base;
  if (Math.abs(diff) < Math.pow(10, -digits) / 2) { s.textContent = 'no change'; return s; }
  s.className = (lowerIsBetter ? diff < 0 : diff > 0) ? 'better' : 'worse';
  const pct = base !== 0 ? ' (' + (diff > 0 ? '+' : '−') + Math.abs(diff / base * 100).toFixed(1) + ' %)' : '';
  s.textContent = (diff > 0 ? '▲ +' : '▼ −') + Math.abs(diff).toFixed(digits) + unit + pct;
  return s;
}

// Copy text, or select it for a manual copy where the clipboard is refused.
export function copyText(text, selectEl, status) {
  const sel = () => {
    const r = document.createRange(); r.selectNodeContents(selectEl);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    status.textContent = 'Selected. Press Ctrl+C or ⌘C to copy.';
  };
  try { navigator.clipboard.writeText(text).then(() => { status.textContent = 'Copied.'; }, sel); } catch (e) { sel(); }
}

export function readFile(file, cb, err) {
  const rd = new FileReader();
  rd.onload = () => cb(String(rd.result));
  rd.onerror = () => err('Could not read that file.');
  rd.readAsText(file);
}
