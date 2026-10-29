// Kurčometar (the stats window's tab, a joke the players asked for): how big each player acts, in centimetres, from
// what the replay has: how much and how worked up they talked (voice.js), their actions per minute (CamRec input),
// their combat army over the game and the value they killed a minute. Each measure is compared with the other
// players' in this game (z score, cut at ±2) and the player's length is 13.1 cm + 2.2 cm × the mean of their scores:
// the lobby average is 13.1 cm. A team's is its players' mean. It measures ego, not anatomy.
export const KM_MEASURES = [
  ['kmec', 'kmečanje', 'how much they talked (s / min), more when worked up (above +1 R)'],
  ['apm', 'APM', 'actions per minute (CamRec input)'],
  ['army', 'vojska', 'combat army over the game (points)'],
  ['aggro', 'agresija', 'value killed per minute'],
];
export const KM_AVG = 13.1, KM_CM = 2.2, KM_MIN = 5, KM_MAX = 25;
// players: [{ id, m: { kmec?, apm?, army?, aggro? } }] (a measure left out: no data for that player)
// -> Map id -> { cm, z: { measure: score } }
export function kurcometar(players) {
  const z = new Map(players.map(p => [p.id, {}]));
  for (const [k] of KM_MEASURES) {
    const has = players.filter(p => Number.isFinite(p.m[k]));
    if (has.length < 2) continue;
    const mean = has.reduce((a, p) => a + p.m[k], 0) / has.length;
    const sd = Math.sqrt(has.reduce((a, p) => a + (p.m[k] - mean) ** 2, 0) / has.length);
    for (const p of has) z.get(p.id)[k] = sd > 1e-9 ? Math.max(-2, Math.min(2, (p.m[k] - mean) / sd)) : 0;
  }
  const out = new Map();
  for (const p of players) {
    const zs = Object.values(z.get(p.id));
    out.set(p.id, { cm: zs.length ? Math.max(KM_MIN, Math.min(KM_MAX, KM_AVG + KM_CM * zs.reduce((a, b) => a + b, 0) / zs.length)) : NaN, z: z.get(p.id) });
  }
  return out;
}

const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const fmtCm = v => Number.isFinite(v) ? `${v.toFixed(1)} cm` : '–';
// a ruler 0..KM_MAX cm with a bar to cm (and the lobby average marked)
function ruler(cm, rgb, w) {
  const L = 8, R = 8, W = Math.max(120, w - L - R), X = c => L + W * c / KM_MAX, h = 46;
  let s = `<svg class="kmRuler" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="${L}" y="4" width="${W}" height="26" rx="3" class="kmWood"/>`;
  for (let c = 0; c <= KM_MAX; c++) {
    const x = X(c).toFixed(1), len = c % 5 ? 6 : 11;
    s += `<line x1="${x}" x2="${x}" y1="4" y2="${4 + len}" class="kmTick"/>`;
    if (!(c % 5)) s += `<text x="${x}" y="${h - 3}" class="kmNum">${c}</text>`;
  }
  if (Number.isFinite(cm)) s += `<rect x="${L}" y="16" width="${(X(cm) - L).toFixed(1)}" height="10" rx="5" fill="rgb(${rgb})" class="kmBar"/>`;
  const a = X(KM_AVG).toFixed(1);
  return s + `<line x1="${a}" x2="${a}" y1="2" y2="32" class="kmAvg"/></svg>`;
}
// teams: [{ name, rgb, players: [{ id, name, rgb, m }] }], res: kurcometar() of all their players
export function kurcHtml(teams, res, w, minutes) {
  if (minutes < 1) return `<div class="kmNote">Kurčometar needs at least a minute of game to measure.</div>`;
  const fz = v => `${v > -0.05 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
  let html = '<div class="kmWrap">';
  for (const t of teams) {
    const cms = t.players.map(p => res.get(p.id).cm).filter(Number.isFinite), cm = cms.length ? cms.reduce((a, b) => a + b, 0) / cms.length : NaN;
    html += `<div class="kmTeam"><div class="kmHead"><b style="color:rgb(${t.rgb})">${esc(t.name)}</b><span class="kmCm">${fmtCm(cm)}</span><span class="kmSub">team average</span></div>${ruler(cm, t.rgb, w)}<div class="kmRows">`;
    for (const p of [...t.players].sort((a, b) => (res.get(b.id).cm || 0) - (res.get(a.id).cm || 0))) {
      const r = res.get(p.id);
      const chips = KM_MEASURES.filter(([k]) => r.z[k] !== undefined).map(([k, lbl, tip]) => `<span class="kmChip${r.z[k] >= 0.5 ? ' up' : r.z[k] <= -0.5 ? ' down' : ''}" title="${esc(tip)}">${esc(lbl)} ${fz(r.z[k])}</span>`).join('');
      html += `<div class="kmRow"><i style="background:rgb(${p.rgb})"></i><span class="kmName">${esc(p.name)}</span><b>${fmtCm(r.cm)}</b><span class="kmChips">${chips || '<span class="kmChip">no data</span>'}</span></div>`;
    }
    html += '</div></div>';
  }
  return html + `</div><p class="kmNote">Measures ego, not anatomy: each player against the others in this game (the lobby average is ${KM_AVG} cm), from what they did so far: ${KM_MEASURES.map(([, l, t]) => `<b>${esc(l)}</b> ${esc(t)}`).join('; ')}. A measure without data (no microphone, no input recording) is left out.</p>`;
}
