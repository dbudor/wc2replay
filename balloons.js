// Commentary as comic-book speech balloons over the map, read from a JSON file:
//   replays/<replay name without .w2r.gz / .pcapng>.balloons.json next to a listed replay, or a .json picked / dropped
//   with the files. Either an array or { "balloons": [...] }; each entry:
//     time   game clock when it appears, as the viewer shows it: "2:39", "1:02:05", "2:39.5" or seconds (or tick: n)
//     text   what is said ("\n" breaks the line)
//     unit   the unit slot that speaks (B in the viewer copies an entry for the inspected unit); the balloon follows
//            it, and stays where it was if the unit dies
//     x, y   instead of unit: a point on the map (map pixels)
//            neither: a caption box at the top of the view (the narrator)
//     secs   how long it stays, in game seconds (default: by its length, at least 3)
//     kind   "say" (default), "think" or "shout"
// Pure DOM over the canvas: nothing here touches the simulation.
import { A } from './gamestate.js';

const KINDS = new Set(['say', 'think', 'shout']);

// Game clock text / seconds -> ms; NaN when it is not one.
function clockMs(v) {
  if (typeof v === 'number') return v * 1000;
  if (typeof v !== 'string' || !/^\s*\d+(:\d{1,2}){0,2}(\.\d+)?\s*$/.test(v)) return NaN;
  return v.trim().split(':').reduce((a, p) => a * 60 + +p, 0) * 1000;
}

// The file's entries, checked and sorted; throws with what is wrong.
export function parseBalloons(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.balloons) ? json.balloons : null;
  if (!list) throw new Error('expected an array of balloons or { "balloons": [...] }');
  const out = [];
  list.forEach((e, i) => {
    const bad = what => { throw new Error(`balloon ${i + 1}: ${what}`); };
    if (!e || typeof e !== 'object') bad('not an object');
    if (typeof e.text !== 'string' || !e.text.trim()) bad('no text');
    const ms = e.tick != null ? NaN : clockMs(e.time);
    if (e.tick == null && !Number.isFinite(ms)) bad(`time "${e.time}" is not a game clock like "2:39"`);
    if (e.tick != null && !(Number.isInteger(e.tick) && e.tick >= 0)) bad('tick must be a whole number');
    if (e.unit != null && !(Number.isInteger(e.unit) && e.unit >= 0 && e.unit < 4096)) bad('unit must be a unit slot number');
    const pt = e.x != null || e.y != null;
    if (pt && !(Number.isFinite(e.x) && Number.isFinite(e.y))) bad('x and y must both be numbers');
    if (e.secs != null && !(Number.isFinite(e.secs) && e.secs > 0)) bad('secs must be a positive number');
    const kind = e.kind == null ? 'say' : e.kind;
    if (!KINDS.has(kind)) bad(`kind must be say, think or shout`);
    out.push({
      tick: e.tick != null ? e.tick : null, ms, text: e.text.trim(), kind,
      unit: e.unit != null ? e.unit : null, x: pt ? e.x : null, y: pt ? e.y : null,
      secs: e.secs || Math.max(3, 1.5 + e.text.length / 15),
    });
  });
  return out;
}

// One entry as the file holds it (the B key's clipboard stub).
export function balloonStub({ tickMs, tick, unit, x, y }) {
  const s = tick * tickMs / 1000, h = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = (s % 60).toFixed(1).padStart(4, '0');
  const time = `${h ? h + ':' + String(mm).padStart(2, '0') : mm}:${ss}`;
  const where = unit != null ? `"unit": ${unit}` : `"x": ${Math.round(x)}, "y": ${Math.round(y)}`;
  return `{ "time": "${time}", ${where}, "text": "" },`;
}

export class Balloons {
  constructor(layer) { this.layer = layer; this.list = []; this.live = new Map(); }
  set(list) { this.list = list || []; this.clear(); }
  clear() { for (const b of this.live.values()) b.el.remove(); this.live.clear(); }
  get size() { return this.list.length; }

  // Every frame. project(mapX, mapY) -> { x, y, clip: { l, t, r, b } } in CSS px of the layer, or null (no map shown).
  update(m, tick, tickMs, project, hidden) {
    const want = new Set();
    if (!hidden && this.list.length) {
      for (let i = 0; i < this.list.length; i++) {
        const e = this.list[i], t0 = e.tick != null ? e.tick : Math.round(e.ms / tickMs);
        if (tick >= t0 && tick < t0 + e.secs * 1000 / tickMs) want.add(i);
      }
    }
    for (const [i, b] of this.live) if (!want.has(i)) { b.el.remove(); this.live.delete(i); }
    for (const i of want) {
      const e = this.list[i];
      let b = this.live.get(i);
      if (!b) {
        const el = document.createElement('div');
        el.className = `balloon ${e.unit == null && e.x == null ? 'caption' : e.kind}`;
        el.textContent = e.text;
        this.layer.append(el);
        b = { el, serial: null, x: e.x, y: e.y, key: '' }; this.live.set(i, b);
      }
      this.place(m, e, b, project);
    }
  }

  place(m, e, b, project) {
    const el = b.el;
    if (e.unit == null && e.x == null) {   // caption: top centre (CSS)
      const key = 'cap'; if (b.key !== key) { b.key = key; el.style.cssText = ''; }
      return;
    }
    if (e.unit != null) {   // follow the unit while that slot still holds it (its serial), else stay where it was
      const n = m.r32(A.UnitCount), u = m.r32(A.Units) + 0x98 * e.unit;
      if (e.unit < n) {
        const f = m.r16(u + 0x1e), serial = m.r32(u + 0x14);
        if (b.serial === null && !(f & 1)) b.serial = serial;
        if (b.serial === serial && !(f & 1) && !(f & 8 && b.x != null)) {   // inside a transport / building: where it went in
          const t = m.r8(u + 0x27), bh = (m.r16(A.TypeBox + 4 * t + 2) << 16) >> 16;
          b.x = m.s16(u) + 16 * m.r16(A.TypeSize + 4 * t);
          b.y = m.s16(u + 2) + 16 * m.r16(A.TypeSize + 4 * t + 2) - bh / 2;
        }
      }
      if (b.x == null) { if (b.key !== 'none') { b.key = 'none'; el.style.display = 'none'; } return; }
    }
    const p = project(b.x, b.y);
    if (!p) { if (b.key !== 'none') { b.key = 'none'; el.style.display = 'none'; } return; }
    // the tail's tip on the speaker; off screen: pinned to the nearest edge, no tail
    const w = el.offsetWidth || 120, h = el.offsetHeight || 40, c = p.clip, tail = 14, pad = 6;
    const off = p.x < c.l || p.x > c.r || p.y < c.t || p.y > c.b;
    let x = Math.max(c.l + pad, Math.min(c.r - w - pad, p.x - w * 0.3)), y = p.y - tail - h;
    let below = false;
    if (!off && y < c.t + pad) { y = p.y + tail + 8; below = true; }   // no room above: hang below the unit
    if (off) y = Math.max(c.t + pad, Math.min(c.b - h - pad, y));
    // where along the bottom (or top) edge the tail starts: under the speaker, kept on the balloon
    const tx = Math.max(12, Math.min(w - 26, p.x - x - 7));
    const key = `${Math.round(x)},${Math.round(y)},${off},${below},${Math.round(tx)}`;
    if (key === b.key) return;
    b.key = key;
    el.style.cssText = `left:${Math.round(x)}px;top:${Math.round(y)}px;--tx:${Math.round(tx)}px`;
    el.classList.toggle('edge', off); el.classList.toggle('below', below);
  }
}
