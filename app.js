/*
 * Forecast Curve Editor demo
 *
 * 1. ForecastMath   pure functions, no DOM. This is the part worth reusing.
 * 2. State          values, locks, total, undo history.
 * 3. Rendering      plain SVG. Swap this section for any chart library.
 * 4. Interaction    point drag, curve brush, freehand, locks, table edits.
 * 5. Excel + versions
 */
'use strict';

/* ============================================================
 * 1. ForecastMath
 * All values are plain arrays of numbers (one per period).
 * `locked` is a parallel array of booleans. Nothing here mutates its inputs.
 * ============================================================ */
const ForecastMath = (() => {
  const EPS = 1e-9;
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (arr, idx) => (idx ? idx.reduce((a, i) => a + arr[i], 0) : arr.reduce((a, b) => a + b, 0));
  const lockedIdx = (locked) => range(locked.length).filter((i) => locked[i]);
  const freeIdx = (locked) => range(locked.length).filter((i) => !locked[i]);

  // Add `delta` across the periods in `pool`, split in proportion to `weights`.
  // No value may go below 0: a period that would is pinned at 0, dropped from
  // the pool, and what it could not absorb is spread again over the rest.
  // Mutates `values` (callers pass a copy). Returns anything left unplaced.
  function distribute(values, pool, weights, delta) {
    let active = pool.slice();
    let remaining = delta;
    for (let pass = 0; pass <= pool.length && Math.abs(remaining) > EPS && active.length; pass++) {
      let w = active.map((i) => Math.max(0, weights[i]));
      let wSum = w.reduce((a, b) => a + b, 0);
      if (wSum <= EPS) { w = active.map(() => 1); wSum = active.length; } // all zero: split evenly
      const next = [];
      let placed = 0;
      active.forEach((i, k) => {
        const share = (remaining * w[k]) / wSum;
        if (values[i] + share < 0) { placed -= values[i]; values[i] = 0; } // clamp and drop
        else { values[i] += share; placed += share; next.push(i); }
      });
      remaining -= placed;
      active = next;
    }
    return remaining;
  }

  // Set period `index` to `newValue`, then rebalance the other unlocked periods
  // so the series still sums to `total`. Locked periods never change.
  // The difference is spread in proportion to each period's current value,
  // which keeps the shape of the rest of the curve.
  function rebalance(values, locked, index, newValue, total) {
    const out = values.slice();
    const others = freeIdx(locked).filter((i) => i !== index);
    if (!others.length) return out; // nothing left to absorb the change
    const budget = total - sum(out, lockedIdx(locked).filter((i) => i !== index));
    out[index] = clamp(newValue, 0, Math.max(0, budget));
    const delta = budget - out[index] - sum(out, others);
    distribute(out, others, out.slice(), delta);
    return out;
  }

  // "Drag the curve": move unlocked periods by `amount`, weighted by a Gaussian
  // centred on `center` (fractional period index) with width `sigma`.
  // Periods away from the brush absorb the difference so the total holds.
  function brush(values, locked, center, amount, sigma, total) {
    const n = values.length;
    const out = values.slice();
    const free = freeIdx(locked);
    const g = range(n).map((i) => Math.exp(-((i - center) ** 2) / (2 * sigma * sigma)));
    free.forEach((i) => { out[i] = Math.max(0, out[i] + amount * g[i]); });
    const budget = total - sum(out, lockedIdx(locked));
    const weights = out.map((v, i) => v * (1 - g[i])); // absorb mostly outside the brush
    distribute(out, free, weights, budget - sum(out, free));
    return out;
  }

  // Preset shapes, as relative weights at t in (0, 1).
  const SHAPES = {
    flat: () => 1,
    linear: (t) => 0.2 + t, // steady ramp up
    bell: (t) => Math.exp(-((t - 0.5) ** 2) / (2 * 0.16 ** 2)),
    front: (t) => Math.exp(-2.6 * t),
    back: (t) => Math.exp(-2.6 * (1 - t)),
  };

  function presetWeights(name, n) {
    if (name === 'scurve') {
      // An S-curve describes CUMULATIVE progress (a logistic). Period values are
      // the increments of that cumulative curve, so they peak in the middle.
      const k = 8;
      const L = (x) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      const c = (x) => (L(x) - L(0)) / (L(1) - L(0));
      return range(n).map((i) => c((i + 1) / n) - c(i / n));
    }
    const f = SHAPES[name] || SHAPES.flat;
    return range(n).map((i) => f((i + 0.5) / n));
  }

  // Fill the unlocked periods with a preset shape, scaled to whatever budget
  // the locked periods leave. Locked periods keep their values.
  function applyPreset(name, values, locked, total) {
    const out = values.slice();
    const w = presetWeights(name, values.length);
    const free = freeIdx(locked);
    const budget = total - sum(values, lockedIdx(locked));
    const wSum = sum(w, free);
    free.forEach((i) => { out[i] = wSum > 0 ? (budget * w[i]) / wSum : budget / free.length; });
    return out;
  }

  // Change the total and scale the unlocked periods to the new budget.
  function setTotal(values, locked, total) {
    const out = values.slice();
    const free = freeIdx(locked);
    const budget = total - sum(values, lockedIdx(locked));
    distribute(out, free, out.slice(), budget - sum(out, free));
    return out;
  }

  // Turn a freehand stroke into one value per period.
  // `stroke` is [{x, y}] in domain units: x = fractional period index
  // (0 = first period centre), y = value. For each period centre we find the
  // stroke segment that spans it and interpolate, so fast strokes with big gaps
  // still work. If the stroke doubles back, the later segment wins. Centres up
  // to half a period past either end snap to the end point. Returns a value per
  // period, or null where the stroke did not reach.
  function resampleStroke(stroke, n) {
    if (stroke.length < 2) return range(n).map(() => null);
    const first = stroke.reduce((a, p) => (p.x < a.x ? p : a));
    const last = stroke.reduce((a, p) => (p.x > a.x ? p : a));
    return range(n).map((c) => {
      let y = null;
      for (let k = 0; k < stroke.length - 1; k++) {
        const a = stroke[k], b = stroke[k + 1];
        if (c >= Math.min(a.x, b.x) && c <= Math.max(a.x, b.x)) {
          y = a.x === b.x ? b.y : a.y + ((b.y - a.y) * (c - a.x)) / (b.x - a.x);
        }
      }
      if (y === null && c < first.x && first.x - c <= 0.5) y = first.y;
      if (y === null && c > last.x && c - last.x <= 0.5) y = last.y;
      return y === null ? null : Math.max(0, y);
    });
  }

  // Apply resampled stroke values. Unlocked periods the stroke covered take the
  // drawn values; unlocked periods it missed absorb the difference. A full-width
  // stroke (or one the rest cannot absorb) is scaled to the budget instead,
  // keeping the drawn shape.
  function applyStroke(values, locked, samples, total) {
    const out = values.slice();
    const free = freeIdx(locked);
    const drawn = free.filter((i) => samples[i] != null);
    if (!drawn.length) return out;
    const rest = free.filter((i) => samples[i] == null);
    const budget = total - sum(values, lockedIdx(locked));
    drawn.forEach((i) => { out[i] = samples[i]; });
    const left = rest.length
      ? distribute(out, rest, out.slice(), budget - sum(out, drawn) - sum(out, rest))
      : budget - sum(out, drawn);
    if (Math.abs(left) > EPS) {
      const target = budget - sum(out, rest);
      const ds = sum(out, drawn);
      drawn.forEach((i) => { out[i] = ds > EPS ? (out[i] * target) / ds : target / drawn.length; });
    }
    return out;
  }

  // Round to `decimals` places so the rounded values still sum EXACTLY to
  // `total` (largest-remainder method). Locked periods are already at display
  // precision and stay as they are; only unlocked periods share the rounding.
  function roundToTotal(values, total, locked, decimals = 0) {
    const f = 10 ** decimals;
    const n = values.length;
    locked = locked || values.map(() => false);
    const units = values.map((v) => v * f);
    const out = units.map((u) => Math.round(u));
    const free = freeIdx(locked);
    if (!free.length) return out.map((u) => u / f);
    const target = Math.round(total * f) - sum(out, lockedIdx(locked));
    free.forEach((i) => { out[i] = Math.floor(units[i]); });
    let r = target - sum(out, free);
    const byFrac = free.slice().sort((a, b) => (units[b] - Math.floor(units[b])) - (units[a] - Math.floor(units[a])));
    for (let k = 0; r > 0; k = (k + 1) % byFrac.length, r--) out[byFrac[k]] += 1; // biggest remainders first
    const rev = byFrac.slice().reverse();
    for (let k = 0, guard = 0; r < 0 && guard < n * 1000; k = (k + 1) % rev.length, guard++) {
      if (out[rev[k]] > 0) { out[rev[k]] -= 1; r++; }
    }
    return out.map((u) => u / f);
  }

  const toQuarters = (values) => [0, 1, 2, 3].map((q) => values[q * 3] + values[q * 3 + 1] + values[q * 3 + 2]);

  const cumulative = (values) => {
    const t = sum(values) || 1;
    let run = 0;
    return values.map((v) => (run += v) / t);
  };

  return { sum, range, clamp, distribute, rebalance, brush, presetWeights, applyPreset, setTotal, resampleStroke, applyStroke, roundToTotal, toQuarters, cumulative, lockedIdx };
})();

/* ============================================================
 * 2. State
 * ============================================================ */
const FM = ForecastMath;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const N = MONTHS.length;
const VERSIONS_KEY = 'forecast-demo-versions';
const fmt = (v) => Math.round(v).toLocaleString('en-US');

const state = {
  total: 1200,
  values: [57, 95, 100, 133, 148, 112, 91, 98, 132, 100, 75, 59],
  locked: MONTHS.map((_, i) => i === 11), // Dec starts locked, like the concept sketch
  view: 'monthly',
  mode: 'point',
  sigma: 1.4,
  showCum: false,
};
const history = [];
let drag = null; // active pointer interaction
let geo = null;  // current chart geometry

const snapshot = () => ({ values: state.values.slice(), locked: state.locked.slice(), total: state.total });
function pushHistory(snap) {
  history.push(snap || snapshot());
  if (history.length > 100) history.shift();
  $('#undo').disabled = false;
}
function undo() {
  const s = history.pop();
  if (!s) return;
  Object.assign(state, { values: s.values, locked: s.locked, total: s.total });
  $('#undo').disabled = !history.length;
  say('Undone.');
  render();
}

// Round and store after every finished edit, so stored values always sum exactly.
function commit(msg) {
  state.values = FM.roundToTotal(state.values, state.total, state.locked);
  if (msg) say(msg);
  render();
}

/* ============================================================
 * 3. Rendering (plain SVG)
 * ============================================================ */
const $ = (s) => document.querySelector(s);
const svg = $('#chart');
const wrap = $('#chartWrap');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Axis top = 4 round ticks (e.g. 0, 50, 100, 150, 200), so labels stay clean.
function niceCeil(v) {
  const raw = Math.max(v, 1) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return 4 * (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

// Monotone cubic path: smooth like the concept, but never overshoots between
// points (so the drawn line never dips below zero).
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1].x - pts[i].x; m[i] = (pts[i + 1].y - pts[i].y) / dx[i]; }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i].x + h).toFixed(1)},${(pts[i].y + t[i] * h).toFixed(1)} ${(pts[i + 1].x - h).toFixed(1)},${(pts[i + 1].y - t[i + 1] * h).toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

function lockIcon(cx, cy) {
  return `<g transform="translate(${cx - 5},${cy - 6})"><path class="lock-icon" d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5"/><rect class="lock-icon-body" x="0.5" y="5" width="9" height="7" rx="1.5"/></g>`;
}

function render() {
  const monthly = state.view === 'monthly';
  const shown = FM.roundToTotal(state.values, state.total, state.locked); // display values sum exactly
  const series = monthly ? shown : FM.toQuarters(shown);
  const labels = monthly ? MONTHS : ['Q1', 'Q2', 'Q3', 'Q4'];
  const n = series.length;

  const W = wrap.clientWidth, H = wrap.clientHeight;
  const narrow = W < 520;
  const m = { l: narrow ? 38 : 48, r: state.showCum ? (narrow ? 34 : 44) : 14, t: 26, b: 34 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const yMax = drag && drag.yMax ? drag.yMax : niceCeil(Math.max(...series, 1) * 1.2);
  const step = pw / n;
  const X = (i) => m.l + (i + 0.5) * step;
  const Y = (v) => m.t + ph - (v / yMax) * ph;
  geo = { m, pw, ph, yMax, step, n, W, H, X, Y };

  const out = [];
  out.push(`<defs><linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2563eb" stop-opacity="0.22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0.02"/></linearGradient></defs>`);

  // locked columns (monthly only)
  if (monthly) {
    state.locked.forEach((lk, i) => {
      if (lk) out.push(`<rect class="lock-band" x="${m.l + i * step}" y="${m.t - 20}" width="${step}" height="${ph + 20}"/>${lockIcon(X(i), m.t - 9)}`);
    });
  }

  // grid + y axis
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4, y = Y(v);
    out.push(`<line class="grid-line" x1="${m.l}" x2="${m.l + pw}" y1="${y}" y2="${y}"/>`);
    out.push(`<text class="axis-text" x="${m.l - 8}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`);
  }

  // x labels (monthly labels toggle locks)
  const short = monthly && step < 34; // phones: J F M A ... instead of Jan Feb Mar
  labels.forEach((lab, i) => {
    if (short) lab = lab[0];
    const cls = monthly ? `mlabel${state.locked[i] ? ' locked' : ''}` : 'qlabel';
    const attr = monthly ? ` data-lock="${i}"` : '';
    out.push(`<g class="${cls}"${attr}><rect x="${m.l + i * step + 2}" y="${m.t + ph + 6}" width="${step - 4}" height="24" rx="6"/><text x="${X(i)}" y="${m.t + ph + 22}" text-anchor="middle">${lab}</text></g>`);
  });

  // area + line
  const pts = series.map((v, i) => ({ x: X(i), y: Y(v) }));
  const d = smoothPath(pts);
  out.push(`<path d="${d} L${pts[n - 1].x},${m.t + ph} L${pts[0].x},${m.t + ph} Z" fill="url(#fillGrad)"/>`);
  out.push(`<path class="line" d="${d}"/>`);

  // cumulative overlay on a 0 to 100% right axis
  if (state.showCum) {
    const cum = FM.cumulative(series);
    const cp = cum.map((c, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${(m.t + ph - c * ph).toFixed(1)}`).join(' ');
    out.push(`<path class="cum" d="${cp}"/>`);
    [0, 0.5, 1].forEach((c) => out.push(`<text class="cum-text" x="${m.l + pw + 6}" y="${m.t + ph - c * ph + 4}">${c * 100}%</text>`));
  }

  // points
  series.forEach((v, i) => {
    const lk = monthly && state.locked[i];
    const act = drag && drag.idx === i && drag.mode === 'point';
    out.push(`<circle class="hit" data-i="${i}" cx="${X(i)}" cy="${Y(v)}" r="14"/>`);
    out.push(`<circle class="pt${lk ? ' locked' : ''}${act ? ' active' : ''}" data-i="${i}" cx="${X(i)}" cy="${Y(v)}" r="${act ? 6.5 : 5}"/>`);
  });

  // value tip while dragging a point
  if (drag && drag.mode === 'point' && drag.idx != null) {
    const i = drag.idx, txt = fmt(series[i]);
    const tw = 12 + txt.length * 7.5, tx = Math.min(Math.max(X(i) - tw / 2, 2), W - tw - 2), ty = Math.max(Y(series[i]) - 34, 0);
    out.push(`<rect class="tip-bg" x="${tx}" y="${ty}" width="${tw}" height="22" rx="6"/><text class="tip-text" x="${tx + tw / 2}" y="${ty + 15}" text-anchor="middle">${txt}</text>`);
  }

  out.push('<g id="overlay"></g>');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = out.join('');

  wrap.className = `chart-wrap mode-${state.mode}${monthly ? '' : ' readonly'}`;
  renderSide(shown);
}

function renderSide(shown) {
  const total = FM.sum(shown);
  const exact = Math.abs(total - state.total) < 1e-9;
  $('#sum').textContent = fmt(total);
  $('#target').textContent = fmt(state.total);
  const chk = $('#sumCheck');
  chk.textContent = exact ? 'Exact' : `Off by ${fmt(total - state.total)}`;
  chk.className = `badge ${exact ? 'ok' : 'bad'}`;
  $('#quarters').innerHTML = FM.toQuarters(shown).map((q, i) => `<span><b>Q${i + 1}</b>${fmt(q)}</span>`).join('');
  if (document.activeElement !== $('#total')) $('#total').value = state.total;

  const tbody = $('#vals tbody');
  if (tbody.children.length !== N) {
    tbody.innerHTML = MONTHS.map((mo, i) => `<tr data-row="${i}"><td class="m">${mo}</td><td><input type="number" min="0" step="1" data-i="${i}" aria-label="${mo} value"></td><td><button class="lockbtn" data-lock="${i}" aria-label="Lock ${mo}"></button></td></tr>`).join('');
  }
  const lockSvg = (on) => on
    ? '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    : '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';
  MONTHS.forEach((mo, i) => {
    const tr = tbody.children[i];
    tr.classList.toggle('locked', state.locked[i]);
    const inp = tr.querySelector('input');
    if (document.activeElement !== inp) inp.value = shown[i];
    inp.disabled = state.locked[i];
    const b = tr.querySelector('.lockbtn');
    b.classList.toggle('on', state.locked[i]);
    b.innerHTML = lockSvg(state.locked[i]);
    b.setAttribute('aria-pressed', state.locked[i]);
  });
}

const HINTS = {
  point: 'Drag any point up or down. The other unlocked months rebalance so the total holds. Hold Shift to drag the curve instead. Click a month label to lock it.',
  brush: 'Drag anywhere on the chart to push a smooth bump up or down. Brush width sets how far it spreads; months outside it absorb the change.',
  draw: 'Draw across the chart. A full-width stroke replaces the shape; a partial stroke reshapes just those months and the rest rebalances.',
  quarterly: 'Quarterly is a read-only roll-up of the monthly values. Switch to Monthly to edit.',
};
function updateHint() {
  $('#hint').textContent = state.view === 'quarterly' ? HINTS.quarterly : HINTS[state.mode];
  $('.brush-field').classList.toggle('disabled', state.mode !== 'brush');
}

let msgTimer = null;
function say(text, isError) {
  const el = $('#msg');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.textContent = ''; }, isError ? 7000 : 4000);
}

/* ============================================================
 * 4. Interaction
 * ============================================================ */
function localPoint(e) {
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const inPlot = (p) => p.x >= geo.m.l - 6 && p.x <= geo.m.l + geo.pw + 6 && p.y >= geo.m.t - 20 && p.y <= geo.m.t + geo.ph + 4;
const xToIndex = (x) => (x - geo.m.l) / geo.step - 0.5;
const yToValue = (y, yMax) => Math.max(0, ((geo.m.t + geo.ph - y) / geo.ph) * yMax);
const clampY = (y) => FM.clamp(y, geo.m.t, geo.m.t + geo.ph);

function toggleLock(i) {
  if (state.view !== 'monthly') return;
  pushHistory();
  state.locked[i] = !state.locked[i];
  say(`${MONTHS[i]} ${state.locked[i] ? 'locked. It will not change when other months move.' : 'unlocked.'}`);
  render();
}

svg.addEventListener('pointerdown', (e) => {
  if (state.view !== 'monthly' || !geo) return;
  if (e.target.closest('[data-lock]')) return; // month labels are handled by click
  const p = localPoint(e);
  if (!inPlot(p)) return;
  e.preventDefault();
  const mode = state.mode === 'point' && e.shiftKey ? 'brush' : state.mode;
  if (FM.lockedIdx(state.locked).length === N) { say('Every month is locked. Unlock one to edit.', true); return; }
  drag = { mode, before: snapshot(), start: state.values.slice(), yMax: geo.yMax, startY: p.y, moved: false, pointerId: e.pointerId };
  if (mode === 'point') {
    const i = FM.clamp(Math.round(xToIndex(p.x)), 0, N - 1);
    if (state.locked[i]) { say(`${MONTHS[i]} is locked. Click its label to unlock it.`, true); drag = null; return; }
    drag.idx = i;
  } else if (mode === 'brush') {
    drag.center = FM.clamp(xToIndex(p.x), 0, N - 1);
  } else {
    drag.stroke = [{ x: p.x, y: clampY(p.y) }];
  }
  svg.setPointerCapture(e.pointerId);
  render();
  drawOverlay(p);
});

svg.addEventListener('pointermove', (e) => {
  if (!geo || state.view !== 'monthly') return;
  const p = localPoint(e);
  if (!drag) { if (state.mode === 'brush' || e.shiftKey) drawOverlay(inPlot(p) ? p : null); return; }
  if (e.pointerId !== drag.pointerId) return;
  drag.moved = true;
  if (drag.mode === 'point') {
    state.values = FM.rebalance(drag.start, state.locked, drag.idx, yToValue(clampY(p.y), drag.yMax), state.total);
    render();
  } else if (drag.mode === 'brush') {
    const amount = ((drag.startY - p.y) / geo.ph) * drag.yMax;
    state.values = FM.brush(drag.start, state.locked, drag.center, amount, state.sigma, state.total);
    render();
    drawOverlay(p);
  } else {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    (evs.length ? evs : [e]).forEach((ev) => { const q = localPoint(ev); drag.stroke.push({ x: FM.clamp(q.x, geo.m.l, geo.m.l + geo.pw), y: clampY(q.y) }); });
    drawOverlay(p);
  }
});

function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  const d = drag;
  drag = null;
  if (d.mode === 'draw') {
    // pixels -> domain units, then resample at each month centre
    const stroke = d.stroke.map((q) => ({ x: xToIndex(q.x), y: yToValue(q.y, d.yMax) }));
    const samples = FM.resampleStroke(stroke, N);
    const covered = samples.filter((s, i) => s != null && !state.locked[i]).length;
    if (!covered) { say('Draw across at least one unlocked month.', true); render(); return; }
    pushHistory(d.before);
    state.values = FM.applyStroke(state.values, state.locked, samples, state.total);
    commit(covered === N - FM.lockedIdx(state.locked).length
      ? 'Stroke converted to monthly values and scaled to the total.'
      : `Stroke reshaped ${covered} month${covered > 1 ? 's' : ''}; the other unlocked months rebalanced.`);
    return;
  }
  if (!d.moved) { render(); return; }
  pushHistory(d.before);
  commit(d.mode === 'point' ? `${MONTHS[d.idx]} set; other unlocked months rebalanced.` : 'Curve adjusted; total held.');
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('pointerleave', () => { if (!drag) drawOverlay(null); });

svg.addEventListener('click', (e) => {
  const el = e.target.closest('[data-lock]');
  if (el) toggleLock(+el.dataset.lock);
});

// Brush footprint and live freehand stroke, drawn without a full re-render.
function drawOverlay(p) {
  const ov = svg.querySelector('#overlay');
  if (!ov || !geo) return;
  let html = '';
  const brushing = (drag && drag.mode === 'brush') || (!drag && p && (state.mode === 'brush'));
  if (brushing && p) {
    const c = drag ? drag.center : FM.clamp(xToIndex(p.x), 0, N - 1);
    const cx = geo.m.l + (c + 0.5) * geo.step, w = state.sigma * geo.step * 2;
    html += `<rect class="brush" x="${cx - w}" y="${geo.m.t}" width="${w * 2}" height="${geo.ph}" rx="10"/>`;
  }
  if (drag && drag.mode === 'draw' && drag.stroke.length) {
    html += `<polyline class="stroke" points="${drag.stroke.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ')}"/>`;
  }
  ov.innerHTML = html;
}

// Presets
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  if (FM.lockedIdx(state.locked).length === N) { say('Every month is locked. Unlock one to apply a preset.', true); return; }
  pushHistory();
  state.values = FM.applyPreset(b.dataset.preset, state.values, state.locked, state.total);
  if (b.dataset.preset === 'scurve' && !state.showCum) { state.showCum = true; $('#showCum').checked = true; }
  commit(`${b.textContent} applied${FM.lockedIdx(state.locked).length ? ' around the locked months' : ''}.`);
}));

// Total
$('#total').addEventListener('change', (e) => {
  const t = Math.round(Number(e.target.value));
  const lockedSum = FM.sum(state.values, FM.lockedIdx(state.locked));
  if (!Number.isFinite(t) || t < 0) { say('Total must be a positive number.', true); e.target.value = state.total; return; }
  if (t < lockedSum) { say(`Locked months already add up to ${fmt(lockedSum)}. Unlock one or keep the total at ${fmt(lockedSum)} or more.`, true); e.target.value = state.total; return; }
  if (t > lockedSum && FM.lockedIdx(state.locked).length === N) { say('Every month is locked, so the total cannot change.', true); e.target.value = state.total; return; }
  pushHistory();
  state.total = t;
  state.values = FM.setTotal(state.values, state.locked, t);
  commit(`Total set to ${fmt(t)}; unlocked months scaled to fit.`);
});

// Table: type a value, or toggle a lock
$('#vals').addEventListener('change', (e) => {
  const i = e.target.dataset.i;
  if (i == null) return;
  const idx = +i, v = Number(e.target.value);
  if (!Number.isFinite(v) || v < 0) { say('Values must be zero or more.', true); render(); return; }
  if (FM.lockedIdx(state.locked).filter((k) => k !== idx).length === N - 1) { say('Every other month is locked, so this one cannot change.', true); render(); return; }
  pushHistory();
  state.values = FM.rebalance(state.values, state.locked, idx, v, state.total);
  e.target.blur();
  commit(`${MONTHS[idx]} set; other unlocked months rebalanced.`);
});
$('#vals').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lock]');
  if (b) toggleLock(+b.dataset.lock);
});

// View / mode / options
$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  state.view = b.dataset.view;
  document.querySelectorAll('#view button').forEach((x) => x.classList.toggle('on', x === b));
  updateHint();
  render();
});
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  state.mode = b.dataset.mode;
  document.querySelectorAll('#mode button').forEach((x) => x.classList.toggle('on', x === b));
  if (state.view !== 'monthly') { state.view = 'monthly'; document.querySelectorAll('#view button').forEach((x) => x.classList.toggle('on', x.dataset.view === 'monthly')); }
  updateHint();
  render();
});
$('#brushWidth').addEventListener('input', (e) => { state.sigma = Number(e.target.value); });
$('#showCum').addEventListener('change', (e) => { state.showCum = e.target.checked; render(); });
$('#undo').addEventListener('click', undo);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault();
    undo();
  }
});
window.addEventListener('resize', () => { if (!drag) render(); });

/* ============================================================
 * 5. Excel + versions
 * ============================================================ */
$('#exportXlsx').addEventListener('click', () => {
  if (!window.XLSX) { say('The Excel library did not load. Check your connection and reload.', true); return; }
  const shown = FM.roundToTotal(state.values, state.total, state.locked);
  const monthly = [['Month', 'Value', 'Locked'], ...MONTHS.map((mo, i) => [mo, shown[i], state.locked[i] ? 'Yes' : 'No'])];
  const quarterly = [['Quarter', 'Value'], ...FM.toQuarters(shown).map((q, i) => [`Q${i + 1}`, q]), ['Total', FM.sum(shown)]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthly), 'Monthly');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(quarterly), 'Quarterly');
  XLSX.writeFile(wb, 'forecast.xlsx');
  say('Exported forecast.xlsx (Monthly and Quarterly sheets).');
});

$('#importXlsx').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!window.XLSX) { say('The Excel library did not load. Check your connection and reload.', true); return; }
  try {
    const wb = XLSX.read(await file.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
    const cols = Math.max(0, ...rows.map((r) => r.length));
    let nums = null;
    for (let c = 0; c < cols && !nums; c++) {
      const col = rows.map((r) => r[c]).filter((v) => v !== '' && v != null && Number.isFinite(Number(v))).map(Number);
      if (col.length >= N) nums = col.slice(0, N);
    }
    if (!nums) { say('No column with 12 numbers found on the first sheet.', true); return; }
    if (nums.some((v) => v < 0)) { say('Imported values must be zero or more.', true); return; }
    pushHistory();
    state.total = Math.round(FM.sum(nums));
    state.values = FM.roundToTotal(nums, state.total, null);
    commit(`Imported 12 values from ${file.name}; total is now ${fmt(state.total)}.`);
  } catch (err) {
    say(`Could not read that file (${err.message}).`, true);
  }
});

function loadVersions() {
  try { return JSON.parse(localStorage.getItem(VERSIONS_KEY)) || []; } catch { return []; }
}
function saveVersions(list) { localStorage.setItem(VERSIONS_KEY, JSON.stringify(list)); }

function renderVersions() {
  const list = loadVersions();
  const ul = $('#versions');
  if (!list.length) { ul.innerHTML = '<li class="empty">No saved versions yet</li>'; return; }
  ul.innerHTML = list.slice().reverse().map((v) => `<li data-id="${v.id}"><div class="v-text"><div class="v-name">${esc(v.name)}</div><div class="v-meta">${new Date(v.savedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · total ${fmt(v.total)}</div></div><button class="btn tiny" data-restore="${v.id}">Restore</button><button class="btn tiny" data-del="${v.id}" aria-label="Delete ${esc(v.name)}">✕</button></li>`).join('');
}

$('#saveVersion').addEventListener('click', () => {
  const list = loadVersions();
  const name = $('#versionName').value.trim() || `Version ${list.length + 1}`;
  // Versions are immutable snapshots: restoring copies one back, it never edits it.
  list.push({ id: Date.now().toString(36), name, savedAt: new Date().toISOString(), ...snapshot() });
  saveVersions(list);
  $('#versionName').value = '';
  renderVersions();
  say(`Saved "${name}".`);
});
$('#versions').addEventListener('click', (e) => {
  const r = e.target.closest('[data-restore]'), d = e.target.closest('[data-del]');
  const list = loadVersions();
  if (r) {
    const v = list.find((x) => x.id === r.dataset.restore);
    if (!v) return;
    pushHistory();
    Object.assign(state, { values: v.values.slice(), locked: v.locked.slice(), total: v.total });
    commit(`Restored "${v.name}".`);
  } else if (d) {
    saveVersions(list.filter((x) => x.id !== d.dataset.del));
    renderVersions();
  }
});

// Boot
updateHint();
render();
renderVersions();
