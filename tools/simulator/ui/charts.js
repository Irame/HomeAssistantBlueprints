// Hand-drawn SVG time-of-day charts that share one clock, plus one
// crosshair and tooltip across all charts of a view.
import { $, HOUR, MIN, dayStart } from './util.js';
import { hm } from '../src/blueprint.js';

const NS = 'http://www.w3.org/2000/svg';
export const M = { l: 44, r: 14, t: 8, b: 22 };
export const svgEl = (name, attrs, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };

export function niceTicks(lo, hi, n) {
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => span / s <= n) || 10 * mag;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const out = []; for (let v = a; v <= b + step / 1e6; v += step) out.push(+v.toFixed(6));
  return { ticks: out, lo: a, hi: b, step };
}
export function extent(values, pad) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) if (v !== null && v !== undefined && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return isFinite(lo) ? [lo - pad, hi + pad] : [0, 1];
}

// range: {start, end}; night: {start: 'HH:MM', end: 'HH:MM'} or null; band: extra px under the plot
export function frame(svg, { height, yt, fmtY, band, range, night }) {
  svg.textContent = '';
  const w = Math.max(280, svg.parentNode.clientWidth - 24);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + height); svg.setAttribute('height', height);
  const pb = height - M.b - (band || 0);
  const X = t => M.l + (t - range.start) / (range.end - range.start) * (w - M.l - M.r);
  const Y = v => M.t + (yt.hi - v) / (yt.hi - yt.lo) * (pb - M.t);
  if (night) {
    const ns = hm(night.start), ne = hm(night.end);
    for (let d = dayStart(range.start) - 24 * HOUR; d < range.end; d += 24 * HOUR) {
      const segs = ns <= ne ? [[ns, ne]] : [[ns, 1440], [0, ne]];
      for (const [a, b] of segs) {
        const x0 = X(Math.max(range.start, d + a * MIN)), x1 = X(Math.min(range.end, d + b * MIN));
        if (x1 > x0) svgEl('rect', { x: x0, y: M.t, width: x1 - x0, height: pb - M.t, class: 'night' }, svg);
      }
    }
  }
  for (const v of yt.ticks) {
    const y = Y(v);
    svgEl('line', { x1: M.l, x2: w - M.r, y1: y, y2: y, class: v === yt.lo ? 'base' : 'grid' }, svg);
    svgEl('text', { x: M.l - 6, y: y + 3.5, 'text-anchor': 'end' }, svg).textContent = fmtY(v);
  }
  const stepH = w < 520 ? 6 : 3;
  for (let t = Math.ceil(range.start / HOUR) * HOUR; t <= range.end; t += HOUR) {
    const hr = new Date(t).getHours(); if (hr % stepH) continue;
    svgEl('text', { x: X(t), y: height - 6, 'text-anchor': 'middle' }, svg).textContent = String(hr).padStart(2, '0') + ':00';
  }
  return { svg, w, h: height, pb, X, Y, range };
}

export function stepPath(rows, g, get) {
  let d = '', prev = null, open = false;
  for (const r of rows) {
    const v = get(r);
    if (v === null || v === undefined || !isFinite(v)) { if (open) d += 'H' + g.X(r.t).toFixed(1); open = false; prev = null; continue; }
    if (!open) { d += 'M' + g.X(r.t).toFixed(1) + ',' + g.Y(v).toFixed(1); open = true; }
    else if (v !== prev) d += 'H' + g.X(r.t).toFixed(1) + 'V' + g.Y(v).toFixed(1);
    prev = v;
  }
  if (open) d += 'H' + g.X(g.range.end).toFixed(1);
  return d;
}
export function linePath(pts, g) {
  let d = '', open = false;
  for (const p of pts) {
    if (p.v === null || p.v === undefined || !isFinite(p.v)) { open = false; continue; }
    d += (open ? 'L' : 'M') + g.X(p.t).toFixed(1) + ',' + g.Y(p.v).toFixed(1); open = true;
  }
  return d;
}
export const every = (rows, n, get) => rows.filter((r, i) => i % n === 0 || i === rows.length - 1).map(r => ({ t: r.t, v: get(r) }));

// a thin bar along the bottom band wherever isOn(row) holds
export function strip(g, rows, y, cls, isOn) {
  let s = null;
  const flush = t => { if (s !== null) svgEl('rect', { x: g.X(s), y, width: Math.max(1, g.X(t) - g.X(s)), height: 5, rx: 1.5, class: cls }, g.svg); s = null; };
  for (const r of rows) { if (isOn(r)) { if (s === null) s = r.t; } else flush(r.t); }
  flush(g.range.end);
}
export function stripLabel(g, y, text) { svgEl('text', { x: M.l - 6, y, 'text-anchor': 'end', class: 'strip-lbl' }, g.svg).textContent = text; }

export function legend(box, items) {
  box.textContent = '';
  for (const [cls, label, kind] of items) {
    const s = document.createElement('span'), i = document.createElement('i');
    i.className = cls + (kind ? ' ' + kind : ''); s.appendChild(i); s.appendChild(document.createTextNode(label)); box.appendChild(s);
  }
}

export function quarterMeans(rows, get) {
  const out = []; let acc = 0, n = 0, t0 = null;
  for (const r of rows) {
    const q = Math.floor(r.t / (15 * MIN)) * 15 * MIN;
    if (t0 !== null && q !== t0) { out.push({ t: t0, v: acc / n }); acc = 0; n = 0; }
    t0 = q; acc += get(r); n++;
  }
  if (n) out.push({ t: t0, v: acc / n });
  return out;
}
export function quarterPath(pts, g) {
  let d = '';
  pts.forEach((p, i) => { const x = g.X(p.t), y = g.Y(p.v); d += (i ? 'H' + x.toFixed(1) + 'V' : 'M' + x.toFixed(1) + ',') + y.toFixed(1); });
  if (pts.length) d += 'H' + g.X(Math.min(g.range.end, pts[pts.length - 1].t + 15 * MIN)).toFixed(1);
  return d;
}

// One crosshair over several charts. charts(): [{ card, g, dots(i) -> [[value, cls], ...] }]
// fill(i, tip) writes the tooltip; count() is the number of minute rows.
export function hover({ stage, tip, charts, fill, count, start }) {
  let idx = null, bound = new Set();
  function show(i) {
    const list = charts(); if (!list.length) return;
    idx = i;
    const t = start() + i * MIN;
    for (const c of list) {
      const g = c.g; if (!g) continue;
      let line = g.svg.querySelector('.cross');
      if (!line) line = svgEl('line', { class: 'cross' }, g.svg);
      const x = g.X(t);
      line.setAttribute('x1', x); line.setAttribute('x2', x); line.setAttribute('y1', M.t); line.setAttribute('y2', g.pb);
      g.svg.querySelectorAll('.dot').forEach(d => d.remove());
      for (const [v, cls] of (c.dots ? c.dots(i) : [])) if (v !== null && v !== undefined && isFinite(v)) svgEl('circle', { cx: x, cy: g.Y(v), r: 4, class: 'dot ' + cls }, g.svg);
    }
    tip.textContent = '';
    fill(i, tip);
    tip.hidden = false;
    const first = list[0], sr = stage.getBoundingClientRect(), cr = first.g.svg.getBoundingClientRect();
    const px = cr.left - sr.left + first.g.X(t) * cr.width / first.g.w;
    const tw = tip.offsetWidth, top = first.card.offsetTop + 44;
    let left = px + 14; if (left + tw > stage.clientWidth) left = px - tw - 14; if (left < 0) left = 0;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hide() {
    idx = null; tip.hidden = true;
    for (const c of charts()) if (c.g) c.g.svg.querySelectorAll('.cross,.dot').forEach(n => n.remove());
  }
  function fromEvent(e, g) {
    const r = g.svg.getBoundingClientRect(), x = (e.clientX - r.left) * g.w / r.width;
    const t = g.range.start + (x - M.l) / (g.w - M.l - M.r) * (g.range.end - g.range.start);
    return Math.max(0, Math.min(count() - 1, Math.round((t - start()) / MIN)));
  }
  // cards are rebuilt on render; listen on each card once
  function bind() {
    for (const c of charts()) {
      if (bound.has(c.card)) continue;
      bound.add(c.card);
      c.card.addEventListener('pointermove', e => { const cur = charts().find(x => x.card === c.card); if (cur && cur.g) show(fromEvent(e, cur.g)); });
      c.card.addEventListener('pointerleave', hide);
      c.card.addEventListener('blur', hide);
      c.card.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, Math.min(count() - 1, (idx ?? 0) + (e.key === 'ArrowRight' ? 15 : -15)))); }
        else if (e.key === 'Escape') hide();
      });
    }
  }
  return { show, hide, bind, get idx() { return idx; } };
}

export function tipRow(tip, cls, label, value) {
  const d = document.createElement('div'); d.className = 'r';
  const i = document.createElement('i'); if (cls) i.className = cls; d.appendChild(i);
  const l = document.createElement('span'); l.className = 'l'; l.textContent = label; d.appendChild(l);
  const v = document.createElement('b'); v.textContent = value; d.appendChild(v);
  tip.appendChild(d);
}
export { $ };
