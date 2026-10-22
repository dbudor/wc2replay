// War2 replay viewer (browser). Static ES modules, no build step, no network: the user's own game files are
// read with <input type=file> / drag and drop and never leave the browser. Serve sim/ over http (e.g.
// `python3 -m http.server` in sim/) and open /web/viewer/; the wasm is ../../build/sim.wasm.
//
// Modules: mpq.js (MPQ reader + PKWARE explode), files.js (what the sim needs), sim.js (wasm session),
// tileset.js (ppl/vx4/vr4), gamestate.js (arena readers), render.js (terrain/fog/boxes), sprites.js (r2_sprites),
// pcap.js (capture -> .w2r; its -fixtx pass runs in the wasm: sim.js fixtx), audio.js (game sound from the hook events),
// screens.js (lobby intro and victory/defeat end screen from the MPQ's menu art).
//
// Captures (.pcapng/.pcap of an IPX-over-UDP game, ipxwrapper): converted in the browser with the host's view
// by default; the "View of" selector re-converts from another player's view, "Save .w2r" downloads the result.
//
// ---- sprites.js integration contract ----
//   import('./sprites.js') (optional; the viewer falls back to owner-coloured boxes when it is missing or throws)
//   createSpriteRenderer({ getFile, mem, tileset, palette, createImage? }) ->
//     .drawUnit(ctx, unitAddr, sx, sy, scale [, opts])     unitAddr = arena address of the Unit (stride 0x98)
//     .drawMissile(ctx, missileAddr, sx, sy, scale [, opts]) missileAddr = arena address of the Missile (0x40)
//     .drawScene(ctx, sx, sy, scale, { player? })          (preferred) everything in the game's layer order
//   getFile(name) -> Uint8Array|null, synchronous, game file names with backslashes (patch MPQ before dat MPQ)
//   mem()         -> Uint8Array whose index is the original x86 address (the current session's arena; it
//                    changes after a seek, so call it on every draw). Read-only.
//   tileset       null = read g_Tileset (0x4acc10) from the arena; palette = the tileset's raw .ppl bytes
//   (sx, sy)      screen position of map pixel (0,0): screenX = sx + mapPixelX * scale (likewise y).
//   Return false from drawUnit/drawMissile to have the viewer draw its placeholder instead.
//
// ---- lobby intro / victory-defeat outro (screens.js) ----
// Whenever the timeline is at its very beginning (turn 0: after loading, a rewind / seek to 0, or Play at the end,
// which restarts) the view shows the game's chat room as the players saw it when the host started (rez\chat_mj.bin /
// chat_p2.bin on art\Chat_IPX.pcx, data from the .w2r MTCH chunk). It stays until Play (button, space, or its own
// "Start replay" button); Step dismisses it and steps; seeking anywhere else hides it.
// When the replay ends, the end screen of MsnStats_Run (win/lose art per race, outcome, rank, score and the
// units/buildings/gold/lumber/oil/kills/razings table) is shown for the SELECTED PLAYER: the "Fog of war"
// player, or the recording player (the "View of" peer) when fog is "all". Changing that selector while it is
// up re-draws it; a click or key closes it (it shows again when the end is reached again).
//
// ---- player view (playerview.js) ----
// "Player view" (checkbox next to the Fog-of-war selector, key P) shows the replay as the fog-of-war player saw it:
// the Classic 640x480 game screen from the user's MPQ (race panels, resource bar, minimap, selected-unit info,
// command buttons, messages) scaled to the window, that player's fog and selection boxes (g_Selection[p]), a
// camera that follows its selection (dragging the map releases it; Follow / F re-centres) and the sounds of its
// own clicks (selection / acknowledge voices with the original pickers, building sounds, work complete...).
// The side panel is hidden meanwhile; the fog selector and the toggle move to the controls bar.
//
// ---- recorded cameras (camrec.js, the CamRec plugin plugins/camrec) ----
// Players who ran camrec.w2p broadcast their viewport and mouse (UDP 34755): a capture holds them, the plugin's own
// camrec\*.w2c files can be dropped in as well, and a converted .w2r keeps them ('CAMR' chunk; Save .w2r).
// Player view: the camera is that player's recorded viewport and its mouse is drawn with the game's cursor
// (dragging releases it to the selection-following camera; Follow / F returns to the recording). Free view: each
// shown player's viewport rectangle and cursor on the map and the minimap (the fog-of-war player, or everybody
// when fog is "all"). "Cameras" (C) turns all of it off. Samples are shown at tick + ms within the tick.
//
// ---- timing ----
// One sim tick is one Game_TimedFrame; at 1x the viewer plays ticks at the game's own frame pace for the
// match's speed (gamestate.tickMs: Classic speed 5 = 20/30/30 ms cycle = 26.67 ms/tick, 37.5 ticks/s).
// Game time shown = ticks * that pace. Turns are stepped whole (Classic IPX: 2 ticks per turn at speed 5).
// Seeking backwards discards the wasm instance, boots a fresh one and fast-forwards (bit-exact by
// construction); the sim runs ~40-100k ticks/s in wasm.

import { MpqArchive, MpqSet } from './mpq.js';
import { bootFileNames } from './files.js';
import { SimSession, compileSim, convertDetectRules } from './sim.js';
import { parseCapture, convertCapture, CaptureError, crc32, withLocalQuit } from './pcap.js';
import { loadTileset } from './tileset.js';
import { MapRenderer, FogTracker } from './render.js';
import { readUnits, readPlayers, tickMs, soundNames, UNIT_NAMES, A } from './gamestate.js';
import { GameAudio, isMusicFile, ALT_SOUND } from './audio.js';
import { loadScreenArt, parseMatch, lobbyInfo, renderLobby, lobbyStartButton, outroData, renderOutro, outcome, playerStats, GameTracker, OUTCOME_TEXT } from './screens.js';
import { camPacketsFromCapture, camPacketsFromW2c, camPacketsFromW2r, withCamChunk, buildTracks, camAt, trackGeometry, mouseTarget, loadCursor, isW2c } from './camrec.js';
import { pickUnit, unitRef, refAlive, unitInfo } from './unitinfo.js';
import { UiVoices, PlayerCamera, PlayerFrame, loadPlayerUiArt, selectionOf, visibleMessages, FRAME_W, FRAME_H, MAP_RECT, MINI_RECT } from './playerview.js';


const $ = id => document.getElementById(id);
// game sound (audio.js): hook events -> WebAudio, only at 1x/2x and not while seeking
const audio = new GameAudio();
audio.bindControls({ mute: $('mute'), volume: $('volume'), voices: $('voices'), music: $('music') });
const ui = { status: $('status'), controls: $('controls'), play: $('play'), step: $('step'), speed: $('speed'), seek: $('seek'),
  clock: $('clock'), view: $('view'), mini: $('mini'), fog: $('fog'), hp: $('hp'), players: $('players'), log: $('log'),
  logSounds: $('logSounds'), logVoices: $('logVoices'), drop: $('drop'), wrap: $('viewWrap'),
  peerBox: $('peerBox'), peer: $('peer'), save: $('save'), rules: $('rules'),
  pview: $('pview'), follow: $('follow'), viewOpts: $('viewOpts'), viewRow: $('viewRow'), pvSlot: $('pvSlot'),
  camShow: $('camShow'), camBox: $('camBox'), listBox: $('listBox'), replayList: $('replayList'), inspect: $('inspect') };

const picked = { exe: null, dat: null, patch: null, replay: null, replayName: '', puds: new Map(), plugin: null,   // plugin: pluginInfo()
  capture: null, captureName: '', converted: null,
  camCapture: [], camFiles: [] };   // CamRec packets: from the capture, from dropped .w2c files   // capture: parseCapture result; converted: { peer, w2r, name }
const st = {
  module: null, mpq: null, files: null, session: null, tileset: null, renderer: null, sprites: null, fog: null,
  playing: false, speed: 1, totalTurns: 0, tickMs: 26.67, budget: 0, lastT: 0, busy: false, sounds: [], looping: false, datKey: null,
  view: { x: 0, y: 0, scale: 1 }, logN: 0,
  art: null, match: null, tracker: null, lobby: null,
  screen: null,          // { kind: 'intro' | 'outro', t0, player, img, key } while a full-view screen is up
  outroClosed: false,    // the outro was dismissed at this end of the replay
  // player view: art (MPQ), frame renderer, camera, per-player UI voice state and messages
  pv: { on: false, art: null, frame: null, cam: new PlayerCamera(), camRec: true, ui: null, messages: [], names: [], lastTick: -1, rect: null },
  cam: { tracks: new Map(), curBytes: [], cursors: [] },   // recorded cameras by player; Art\h_arrow.cur / o_arrow.cur
  stepClock: null,       // { from: g_TickCount before the last step, t } while playing (smooth camera time)
};
const setStatus = (msg, err = false) => { ui.status.textContent = msg; ui.status.classList.toggle('err', err); };

// ---------------------------------------------------------------- War2Combat plugin rules (Peon2k)
// The sim implements Peon2k's rule changes (src/lift/mod_peon2k.c) behind W2_PATCH_PEON2K_022 / _023. A capture does
// not record which plugins the players had loaded, so the rules are chosen when the capture is converted: "auto"
// converts with each candidate (the user's own plugin/peon2k.w2p first) and keeps the first whose run matches every
// sync byte the capture carries. A .w2r keeps the rules it was converted with (MTCH), unless overridden here.
const RULES = { 0: 'original rules', 256: 'Peon2k 0.2.2 rules', 512: 'Peon2k 0.2.3 rules' };
const PLUGIN_BUILDS = { 0xefea1697: 0x100, 0x86b57ae2: 0x200 };   // CRC-32 of the released peon2k.w2p files
function pluginInfo(bytes, name) {
  const bits = PLUGIN_BUILDS[crc32(bytes)] || 0;
  let wav = null;                                  // the plugin's embedded PEON2K\ajmoo.wav (it writes it out at startup)
  for (let i = 0; i + 12 <= bytes.length; i++) {
    if (bytes[i] === 0x52 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x46 && bytes[i + 3] === 0x46 && bytes[i + 8] === 0x57 && bytes[i + 9] === 0x41) {
      const n = (bytes[i + 4] | bytes[i + 5] << 8 | bytes[i + 6] << 16 | bytes[i + 7] << 24) >>> 0;
      if (i + 8 + n <= bytes.length) { wav = bytes.slice(i, i + 8 + n); break; }
    }
  }
  return { name, bits, wav };
}
function setPlugin(info) {
  picked.plugin = info;
  audio.setExtraFile(ALT_SOUND, info && info.wav);
}
const rulesName = b => RULES[b] || `rules ${b}`;
function ruleCandidates() {
  const v = ui.rules.value;
  if (v !== 'auto') return [+v];
  const first = picked.plugin && picked.plugin.bits ? [picked.plugin.bits] : [];
  return [...new Set([...first, 0, 0x100, 0x200])];
}

// ---------------------------------------------------------------- recorded cameras (CamRec)
const camPackets = () => [...(picked.capture ? picked.camCapture : picked.replay ? camPacketsFromW2r(picked.replay) : []),
  ...picked.camFiles.flatMap(b => camPacketsFromW2c(b))];
function refreshCams() {
  const pk = camPackets(), M = st.session ? st.session.mem().r16(A.MapSize) : 0;
  st.cam.tracks = buildTracks(pk); st.cam.ignored = [];
  for (const [p, tr] of st.cam.tracks) if (M && tr.start && tr.start.mapSize !== M) { st.cam.tracks.delete(p); st.cam.ignored.push(p); }   // another game's file
  if (picked.converted) picked.converted.w2r = withCamChunk(picked.converted.w2r, pk);   // Save .w2r keeps them
  ui.camBox.hidden = !st.cam.tracks.size;
}
function camNote() {
  const ign = st.cam.ignored && st.cam.ignored.length ? ` (ignored a camera of another map: player ${st.cam.ignored.map(p => p + 1).join(', ')})` : '';
  if (!st.cam.tracks.size) return ign.trim();
  const names = [...st.cam.tracks.keys()].sort((a, b) => a - b).map(p => st.pv.names[p] || `player ${p + 1}`);
  return `recorded camera${names.length > 1 ? 's' : ''}: ${names.join(', ')}${ign}`;
}
// Game time (g_TickCount, fractional) for the recorded cameras: while playing, the ticks of the last step are
// spread over the wall time they take, so the mouse moves smoothly between turns.
function camTime() {
  const g = st.session.mem().r32(A.TickCount), c = st.stepClock;
  if (!st.playing || st.speed === 0 || !c || c.from > g) return g;
  return Math.min(g, c.from + (performance.now() - c.t) * st.speed / st.tickMs);
}
const camOn = () => ui.camShow.checked && st.cam.tracks.size > 0;
function cursorFor(p) {
  const race = st.session.mem().r8(A.PlayerRace + p);
  return st.cam.cursors[race === 1 ? 1 : 0] || st.cam.cursors[0] || null;
}

// ---------------------------------------------------------------- file picking
async function addFiles(list) {
  await autoGame;                                  // game files found next to the page come first; picked ones override
  let newCapture = null, onlyMusic = list.length > 0, onlyPlugin = false;
  const onlyCam = list.length > 0 && list.every(f => /\.w2c$/i.test(f.name));
  for (const f of list) {
    const n = f.name.toLowerCase();
    const buf = () => f.arrayBuffer().then(b => new Uint8Array(b));
    if (isMusicFile(n)) { audio.addMusicFile(f.name, await buf()); continue; }   // optional Music\*.WAV (CD install)
    if (n.endsWith('.w2c')) {                      // CamRec plugin file (camrec\*.w2c)
      const b = await buf();
      if (isW2c(b)) picked.camFiles.push(b); else setStatus(`${f.name}: not a CamRec .w2c file`, true);
      continue;
    }
    onlyMusic = false; if (!n.endsWith('.w2p')) onlyPlugin = false;
    if (n.endsWith('.exe')) picked.exe = await buf();
    else if (n === 'war2dat.mpq') picked.dat = await buf();
    else if (n === 'war2patch.mpq') picked.patch = await buf();
    else if (n.endsWith('.w2r')) { picked.replay = await buf(); picked.replayName = f.name; picked.capture = null; picked.converted = null; picked.camCapture = []; newCapture = null; }
    else if (n.endsWith('.pud')) picked.puds.set(n, await buf());
    else if (n.endsWith('.w2p')) { setPlugin(pluginInfo(await buf(), f.name)); onlyPlugin = true; continue; }
    else if (/\.(pcapng|pcap|cap)$/.test(n)) {
      const b = await buf();
      try { newCapture = parseCapture(b); } catch (e) { reportError(e, f.name); return; }
      picked.camCapture = camPacketsFromCapture(b);
      picked.capture = newCapture; picked.captureName = f.name; picked.converted = null; picked.replay = null;
    }
    else if (n.endsWith('.mpq') && !picked.dat) picked.dat = await buf();
  }
  if (onlyMusic && st.session) return;
  if (onlyCam) {
    if (!st.session) { setStatus(`${picked.camFiles.length} camera file(s) loaded; now pick the replay or capture.`); return; }
    refreshCams(); setStatus(camNote() || 'These camera files hold no samples.', !st.cam.tracks.size); return;
  }
  if (onlyPlugin && st.session) {                  // a dropped peon2k.w2p: its sample now; auto re-detects a capture with it first
    setStatus(`${picked.plugin.name}: ${picked.plugin.bits ? rulesName(picked.plugin.bits).replace(' rules', '') : 'unknown plugin build (not a released peon2k.w2p)'}${picked.plugin.wav ? ', ajmoo.wav loaded' : ''}.`);
    if (picked.capture && ui.rules.value === 'auto' && picked.plugin.bits && picked.converted && picked.converted.rules !== picked.plugin.bits && st.session.mismatch) {
      try { await convert(); await start(); } catch (e) { reportError(e); }
    }
    return;
  }
  if (newCapture) fillPeers(newCapture);
  ui.peerBox.hidden = !picked.capture;
  const missing = [!picked.exe && 'Warcraft II BNE.exe', !picked.dat && 'War2Dat.mpq', !picked.replay && !picked.capture && 'a .w2r replay or a capture'].filter(Boolean);
  if (missing.length) { setStatus(`Still needed: ${missing.join(', ')}.`); return; }
  try {
    if (picked.capture && (!picked.converted || newCapture)) await convert();
    await start({ intro: true });
  } catch (e) { reportError(e); }
}
function reportError(e, name = '') {
  console.error(e);
  setStatus(e instanceof CaptureError ? `${name ? name + ': ' : ''}${e.message}. Only captures of Warcraft II BNE IPX games (IPX over UDP port 34754, ipxwrapper) can be converted.` : e.message, true);
}
function fillPeers(cap) {
  ui.peer.length = 0;
  for (const pe of [cap.host, ...cap.peers.filter(p => p !== cap.host)]) {
    const nm = cap.peerNames[pe];
    ui.peer.add(new Option(`${pe === cap.host ? 'host' : 'peer ' + pe}${nm ? ` (${nm})` : ''}`, pe === cap.host ? 'host' : String(pe)));
  }
  ui.peer.value = 'host';
}
// capture -> raw .w2r (pcap.js) -> -fixtx in a throwaway wasm instance (sim.js fixtx)
async function convert() {
  const cap = picked.capture, peer = ui.peer.value || 'host';
  let pud = null, pudName;
  if (cap.customMap) {
    const want = cap.mapName.toLowerCase();
    const hit = [...picked.puds].find(([n]) => n.replace(/\.pud$/, '') === want) || (picked.puds.size === 1 ? [...picked.puds][0] : null);
    if (!hit) throw new Error(`This capture is a game on the custom map “${cap.mapName || '?'}”: add that map's .pud file${picked.puds.size > 1 ? ' (several .pud files are loaded: keep only that one)' : ''}.`);
    [pudName, pud] = hit;
  }
  await ensureGameData();
  const cands = ruleCandidates();
  const best = await convertDetectRules({ module: st.module, exe: picked.exe, files: st.files, pud, candidates: cands,
    convert: rules => convertCapture(cap, { peer, pud, pudName, rules }),
    onTry: rules => setStatus(`Converting ${picked.captureName} (${peer === 'host' ? 'host' : 'peer ' + peer}${cands.length > 1 || rules ? ', ' + rulesName(rules) : ''})…`) });
  const { rules, info, stats } = best, w2r = withLocalQuit(best.w2r, info.localQuit);
  st.rulesNote = cands.length > 1 ? (best.clean ? `${rulesName(rules)} (auto-detected)` : `no rule set replays this capture cleanly (best: ${rulesName(rules)}, in sync to turn ${best.reached})`) : rulesName(rules);
  const base = picked.captureName.replace(/\.[^.]*$/, '');
  picked.converted = { peer, w2r, info, stats, rules, name: `${base}-${peer === 'host' ? 'host' : 'p' + peer}.w2r` };
  picked.replay = w2r; picked.replayName = `${picked.captureName} (${info.mode}, ${peer === 'host' ? 'host' : 'peer ' + peer} view)`;
}
ui.rules.onchange = async () => {
  if (!(picked.replay || picked.capture)) return;
  while (st.busy || st.loading) await new Promise(r => setTimeout(r, 50));   // a seek / boot in progress finishes first
  setPlaying(false); ui.rules.disabled = true;
  try { if (picked.capture) await convert(); await start(); } catch (e) { reportError(e); }
  ui.rules.disabled = false;
};
ui.peer.onchange = async () => {
  if (st.session) st.freeCam0 = st.pv.on && st.freeCam ? st.freeCam : { ...(st.viewWant || viewCentre()), scale: st.view.scale };
  if (!picked.capture || st.busy) return;
  setPlaying(false);
  ui.peer.disabled = true;
  try { await convert(); await start(); } catch (e) { reportError(e); }
  ui.peer.disabled = false;
};
ui.save.onclick = () => {
  const c = picked.converted; if (!c) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([c.w2r], { type: 'application/octet-stream' }));
  a.download = c.name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
$('files').addEventListener('change', e => addFiles([...e.target.files]));
window.addEventListener('dragover', e => { e.preventDefault(); ui.drop.hidden = false; });
window.addEventListener('dragleave', e => { if (e.target === ui.drop || !e.relatedTarget) ui.drop.hidden = true; });
window.addEventListener('drop', e => { e.preventDefault(); ui.drop.hidden = true; addFiles([...e.dataTransfer.files]); });

// Dev convenience: ?load=url1,url2,... fetches files from the same origin (e.g. when the server's root also
// holds the game directory) and feeds them through the same path as picked files. Nothing is uploaded.
// Game files next to the page: if the server has Warcraft II BNE.exe and War2Dat.mpq (+ War2Patch.mpq) in the
// viewer's directory or its game/ subdirectory (tools/dist/serve.py serves the user's War2 folder there), they
// are loaded at start and only the replay is asked for. A few casings are tried (case-sensitive servers).
// Nothing is fetched from anywhere but this origin; on file:// or without them the picker works as before.
const GAME_NAMES = {
  exe: ['Warcraft II BNE.exe', 'Warcraft II BNE.EXE', 'warcraft ii bne.exe', 'WARCRAFT II BNE.EXE'],
  dat: ['War2Dat.mpq', 'war2dat.mpq', 'WAR2DAT.MPQ', 'War2Dat.MPQ'],
  patch: ['War2Patch.mpq', 'war2patch.mpq', 'WAR2PATCH.MPQ', 'War2Patch.MPQ'],
};
async function findGameFile(dir, names) {
  for (const n of names) {
    const u = new URL(dir + encodeURIComponent(n), location.href);
    try { const r = await fetch(u, { method: 'HEAD', cache: 'no-store' }); if (r.ok) return u; } catch { return null; }
  }
  return null;
}
const autoGame = (async () => {
  if (!/^https?:$/.test(location.protocol) || new URLSearchParams(location.search).get('noauto')) return;
  for (const dir of ['./', './game/']) {
    const exe = await findGameFile(dir, GAME_NAMES.exe); if (!exe) continue;
    const dat = await findGameFile(dir, GAME_NAMES.dat); if (!dat) continue;
    const patch = await findGameFile(dir, GAME_NAMES.patch);
    try {
      setStatus('Loading the game files from the server…');
      const get = async u => new Uint8Array(await (await fetch(u)).arrayBuffer());
      [picked.exe, picked.dat, picked.patch] = await Promise.all([get(exe), get(dat), patch ? get(patch) : null]);
      const plug = await findGameFile(dir, ['plugin/peon2k.w2p', 'plugin/Peon2k.w2p', 'plugin/PEON2K.W2P', 'Plugin/peon2k.w2p']);
      if (plug) try { setPlugin(pluginInfo(await get(plug), 'plugin/peon2k.w2p')); } catch { /* optional */ }
      const where = new URL(dir, location.href).pathname;
      st.gameDir = where;
      setStatus(`Game files loaded from ${where} (Warcraft II BNE.exe, War2Dat.mpq${patch ? ', War2Patch.mpq' : ''}${picked.plugin ? ', plugin/peon2k.w2p' : ''}). Pick or drop a .w2r replay or a .pcapng/.pcap capture (custom maps: also its .pud).`);
      document.body.classList.add('game-auto');
      const lb = $('files').parentElement; if (lb.firstChild.nodeType === 3) lb.firstChild.nodeValue = 'Replay…';
    } catch { picked.exe = picked.dat = picked.patch = null; }
    return;
  }
})();

const loadList = new URLSearchParams(location.search).get('load');
if (loadList) (async () => {
  const fl = [];
  for (const u of loadList.split(',')) {
    const r = await fetch(u); if (!r.ok) { setStatus(`cannot fetch ${u}`, true); return; }
    const b = await r.arrayBuffer(); fl.push({ name: decodeURIComponent(u.split('/').pop()), arrayBuffer: async () => b });
  }
  addFiles(fl);
})();

// The replays folder: replays/index.json = [{ name (path under replays/), size, mtime (s) }], written live by
// tools/dist/serve.py (its --replays DIR, default the viewer's replays/ folder) or as a static file by make_dist.sh.
// Picking an entry fetches it like a picked file; a capture or .w2r on a custom map brings its .pud along when the
// folder has one of that name. Re-read when the page gets the focus back (new captures show up).
const REPLAY_EXT = /\.(w2r|pcapng|pcap|cap|w2c|pud)$/i;
let replayIndex = [];
async function refreshReplayList() {
  if (!/^https?:$/.test(location.protocol)) return;
  let list;
  try { const r = await fetch('replays/index.json', { cache: 'no-store' }); if (!r.ok) return; list = await r.json(); } catch { return; }
  if (!Array.isArray(list)) return;
  replayIndex = list.filter(e => e && typeof e.name === 'string' && REPLAY_EXT.test(e.name) && !/(^|\/)\.\.?(\/|$)/.test(e.name))
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name));
  const sel = ui.replayList, keep = sel.value;
  sel.length = 0;
  sel.add(new Option(replayIndex.length ? `${replayIndex.filter(e => !/\.(pud|w2c)$/i.test(e.name)).length} in replays/…` : 'replays/ is empty', ''));
  const two = n => String(n).padStart(2, '0');
  const when = t => { if (!t) return ''; const d = new Date(t * 1000); return ` · ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`; };
  const kb = n => n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  for (const e of replayIndex) sel.add(new Option(`${e.name}${when(e.mtime)}${e.size ? ' · ' + kb(e.size) : ''}`, e.name));
  sel.value = replayIndex.some(e => e.name === keep) ? keep : '';
  ui.listBox.hidden = false;
}
// .pud name a .w2r's PUD chunk names (custom map), or ''
function w2rPudName(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 8; o + 8 <= b.length;) {
    const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), len = dv.getUint32(o + 4, true);
    if (tag === 'PUD ' && len > 8 && dv.getUint32(o + 8, true)) { let e = o + 16; while (e < o + 8 + len && b[e]) e++; return String.fromCharCode(...b.subarray(o + 16, e)); }
    if (tag === 'TURN' || tag === 'END ') break;
    o += 8 + len;
  }
  return '';
}
async function loadFromList(name) {
  const url = n => 'replays/' + n.split('/').map(encodeURIComponent).join('/');
  const get = async n => { const r = await fetch(url(n), { cache: 'no-store' }); if (!r.ok) throw new Error(`cannot fetch replays/${n} (${r.status})`); return new Uint8Array(await r.arrayBuffer()); };
  const file = (n, b) => ({ name: n.split('/').pop(), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  setStatus(`Loading replays/${name}…`);
  const b = await get(name), fl = [file(name, b)];
  let map = '';
  if (/\.w2r$/i.test(name)) map = w2rPudName(b);
  else if (/\.(pcapng|pcap|cap)$/i.test(name)) { try { const c = parseCapture(b); if (c.customMap) map = c.mapName + '.pud'; } catch { /* addFiles reports it */ } }
  const base = s => s.replace(/^.*[\\/]/, '').toLowerCase();
  const pud = map && !picked.puds.has(base(map)) && replayIndex.find(e => /\.pud$/i.test(e.name) && base(e.name) === base(map));
  if (pud) fl.unshift(file(pud.name, await get(pud.name)));
  await addFiles(fl);
}
ui.replayList.onchange = async () => {
  const n = ui.replayList.value; if (!n) return;
  ui.replayList.disabled = true;
  try { await loadFromList(n); } catch (e) { reportError(e); }
  ui.replayList.disabled = false;
};
refreshReplayList();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshReplayList(); });
window.addEventListener('focus', () => refreshReplayList());

function replayTurnCount(b) {   // .w2r: "W2R1", u32 version, chunks {u32 tag, u32 len, data}; END = u32 turn count
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let o = 8; o + 8 <= b.length;) {
    const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]), len = dv.getUint32(o + 4, true);
    if (tag === 'END ' && len >= 4) return dv.getUint32(o + 8, true);
    o += 8 + len;
  }
  return 0;
}

// ---------------------------------------------------------------- boot / seek
async function ensureGameData() {
  if (!st.module) st.module = await compileSim(await (await fetch(new URL('./sim.wasm', import.meta.url))).arrayBuffer());
  if (st.datKey && st.datKey[0] === picked.dat && st.datKey[1] === picked.patch) return;
  setStatus('Reading the MPQs…');
  st.mpq = new MpqSet([picked.patch && new MpqArchive(picked.patch), new MpqArchive(picked.dat)]);
  st.files = bootFileNames(st.mpq).filter(n => st.mpq.has(n)).map(n => [n, st.mpq.read(n)]);
  st.datKey = [picked.dat, picked.patch];
  st.art = loadScreenArt(n => st.mpq.read(n));
  st.pv.art = loadPlayerUiArt(n => st.mpq.read(n));
  st.cam.curBytes = ['Art\\h_arrow.cur', 'Art\\o_arrow.cur'].map(n => { try { return st.mpq.has(n) ? st.mpq.read(n) : null; } catch { return null; } });
}

async function start({ intro = false } = {}) {
  await ensureGameData();
  setPlaying(false);
  st.loading = true;
  try { await startSession(intro); } finally { st.loading = false; }
}
async function startSession(intro) {
  st.totalTurns = replayTurnCount(picked.replay);
  st.match = parseMatch(picked.replay);
  st.tracker = new GameTracker(picked.replay);
  st.screen = null; st.outroClosed = false;
  await boot();
  const m = st.session.mem();
  st.tileset = loadTileset(n => st.mpq.read(n), m);
  st.tickMs = tickMs(m);
  st.sounds = soundNames(m);
  audio.setGame(n => st.mpq.read(n), m);
  st.sprites = null;
  try {
    const S = await import('./sprites.js');
    st.sprites = await S.createSpriteRenderer({
      getFile: n => st.mpq.read(n), mem: () => { const v = st.session.mem(); return v.u8.subarray(v.base); },
      tileset: null, palette: st.mpq.read(st.tileset.names[0]),
    });
  } catch (e) { console.warn('sprites.js unavailable, drawing boxes:', e); }
  st.renderer = new MapRenderer({ createCanvas, tileset: st.tileset, sprites: st.sprites });
  st.cam.cursors = st.cam.curBytes.map(b => {
    const c = loadCursor(b, st.tileset.rgb); if (!c) return null;
    const cv = createCanvas(c.w, c.h); cv.getContext('2d').putImageData(new ImageData(c.px, c.w, c.h), 0, 0);
    return { cv, hx: c.hx, hy: c.hy, w: c.w, h: c.h };
  });
  st.renderer.showHp = ui.hp.checked;
  st.pv.frame = st.pv.art && st.pv.art.ok ? new PlayerFrame({ art: st.pv.art, rgb: st.tileset.rgb, createCanvas }) : null;
  ui.pview.disabled = !st.pv.frame;
  ui.pview.parentElement.title = st.pv.frame ? ui.pview.parentElement.title : 'Player view needs the in-game interface art (Art\\h_top.bmp ...) from War2Dat.mpq';
  st.pv.names = []; for (const p of readPlayers(m)) st.pv.names[p.id] = p.name || `Player ${p.id + 1}`;
  refreshCams();
  ui.fog.length = 1;
  for (const p of readPlayers(m)) ui.fog.add(new Option(`as player ${p.id + 1}${p.name ? ` (${p.name})` : ''}${p.id === m.r8(A.LocalPlayer) ? ' · recorder' : ''}`, p.id));
  ui.seek.max = Math.max(1, st.totalTurns - 1);
  ui.controls.hidden = false;
  ui.log.textContent = '';
  const mapKey = `${st.match ? st.match.mapName : ''}|${m.r16(A.MapSize)}|${m.r8(A.Tileset)}`;
  if (st.camMapKey === mapKey && st.freeCam0) { st.view.scale = st.freeCam0.scale; centreOn(st.freeCam0.x, st.freeCam0.y); }
  else centreOnLocal();   // new map: start on the recording player's base
  st.camMapKey = mapKey;
  st.lobby = st.match ? lobbyInfo(st.match, m, st.art, i => st.tileset.rgb[i] || [128, 128, 128]) : null;
  st.lobbyBtn = st.lobby ? lobbyStartButton(st.art, st.lobby) : null;
  maybeLobby();
  ui.save.hidden = !picked.converted;
  const conv = picked.converted ? ` (converted: ${picked.converted.info.peers.length} players, ${picked.converted.stats.moved} commands placed by sync byte)` : '';
  const rn = picked.converted ? st.rulesNote : rulesName(st.session.rules) + (st.session.rules !== st.session.mtchRules ? ` (the file says ${rulesName(st.session.mtchRules)})` : '');
  const noAlt = st.session.rules && !(picked.plugin && picked.plugin.wav) ? '; add plugin/peon2k.w2p for its sound' : '';
  const cams = camNote();
  setStatus(`${picked.replayName}: ${st.session.pudName.replace(/^.*[\\/]/, '')}, tileset ${st.tileset.names[0].split('\\')[2]}, ${st.totalTurns} turns${conv}, ${rn}${noAlt}${cams ? '; ' + cams : ''}${st.sprites ? '' : ' (no sprites.js: boxes)'}.`);
  if (!st.looping) { st.looping = true; requestAnimationFrame(frame); }
  const q = new URLSearchParams(location.search);   // dev: ?turn=N&fog=P&play=1
  if (q.get('fog')) { ui.fog.value = q.get('fog'); ui.fog.onchange(); }
  if (q.get('pview')) setPlayerView(true);
  if (q.get('turn')) await seekTo(+q.get('turn'));
  if (q.get('play')) setPlaying(true);
}

// ---------------------------------------------------------------- intro / outro screens
let screenCanvas = null;
function showScreen(kind) {
  st.screen = { kind, t0: performance.now(), img: null, key: '' };
  if (kind === 'intro') setPlaying(false);
}
function closeScreen() {
  if (!st.screen) return;
  if (st.screen.kind === 'outro') { st.outroClosed = true; if (st.screen.music) audio.musicTrack = -1; }
  st.screen = null;
}
const lobbyUp = () => !!(st.screen && st.screen.kind === 'intro');
// the lobby is up exactly while the timeline is at turn 0 (dev: ?nointro=1 never shows it)
function maybeLobby() {
  if (st.session && st.session.turn === 0 && st.lobby && !st.screen && !new URLSearchParams(location.search).get('nointro')) showScreen('intro');
}
function startFromLobby() { closeScreen(); setPlaying(true); }
// the player the end screen is about: the fog-of-war player, else the recording player
const outroPlayer = () => +ui.fog.value >= 0 ? +ui.fog.value : st.session.mem().r8(A.LocalPlayer);
function outroInfo() {
  const m = st.session.mem(), tr = st.tracker;
  let v = outroPlayer();
  if (!tr.players.includes(v)) v = tr.players.includes(m.r8(A.LocalPlayer)) ? m.r8(A.LocalPlayer) : tr.players[0];
  return outroData(st.art, m, st.match, v, tr.players, tr.left, tr.elim, st.tickMs);
}
function updateScreen() {
  const sc = st.screen, now = performance.now(), t = new URLSearchParams(location.search).get('noanim') ? 99 : (now - sc.t0) / 1000;
  let surf = null, key;
  if (sc.kind === 'intro') {
    key = 'i';
    if (key !== sc.key && st.art.lobbyOk) surf = renderLobby(st.art, st.lobby);
  } else {
    const O = outroInfo();
    key = `o${O.v}:${Math.min(2, t).toFixed(2)}`;
    if (key !== sc.key && st.art.outroOk)
      surf = renderOutro(st.art, O, t, `Showing ${O.name} - pick another player with "Fog of war"`);
    if (key !== sc.key) {
      sc.info = O;
      const track = O.race + (O.outcome.kind === 'victory' ? 0xe : 0xc);   // HVICTORY/OVICTORY, HDEFEAT/ODEFEAT
      sc.music = O.outcome.kind !== 'undecided' && audio.setScreenTrack(track);
    }
  }
  if (key !== sc.key) {
    sc.key = key;
    if (surf) {
      screenCanvas = screenCanvas || createCanvas(640, 480);
      const ctx = screenCanvas.getContext('2d'), id = ctx.createImageData(640, 480);
      id.data.set(surf.data); ctx.putImageData(id, 0, 0); sc.img = screenCanvas;
    } else sc.img = null;
  }
  return true;
}
// Plain text when the MPQ lacks the menu art.
function screenFallbackLines() {
  const sc = st.screen;
  if (sc.kind === 'intro') {
    const L = st.lobby;
    return [`${L.scenarioKind}: ${L.mapTitle} (${L.mapSize}x${L.mapSize}), ${L.mode}, speed ${L.speed}`,
      `Resources ${L.options.resources} · Units ${L.options.units} · Fog ${L.options.fog} · Tileset ${L.options.tileset} · Location ${L.options.location}`,
      ...L.slots.filter(x => x.kind === 'human' || (x.kind === 'computer' && x.inGame)).map(x => `${x.name}: ${x.lobbyRace}, player ${x.p + 1}${x.host ? ' (host)' : ''}`),
      'press Play to start'];
  }
  const O = sc.info;
  return [`${O.name}: ${O.title} ${O.sub}`, `Rank ${O.rank} · Score ${O.score}`,
    ...O.rows.map(r => `${r.label}: units ${r.stats.units}, buildings ${r.stats.bldgs}, gold ${r.stats.gold}, lumber ${r.stats.lumber}, oil ${r.stats.oil}, kills ${r.stats.kills}, razings ${r.stats.razed}`)];
}
function drawScreen(ctx, W, H) {
  ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, 0, W, H);
  if (st.screen.img) {
    const k = Math.min(W / 640, H / 480), w = Math.round(640 * k), h = Math.round(480 * k);
    ctx.imageSmoothingEnabled = k < 1;
    ctx.drawImage(st.screen.img, 0, 0, 640, 480, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
    st.screen.rect = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), k };
    return;
  }
  const d = window.devicePixelRatio || 1, lines = screenFallbackLines();
  ctx.fillStyle = '#fce05c'; ctx.font = `${Math.round(15 * d)}px Georgia, serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach((t, i) => ctx.fillText(t, 20 * d, (20 + 24 * i) * d));
}

async function boot() {
  let pud = null;
  const rules = !picked.converted && ui.rules.value !== 'auto' ? +ui.rules.value : null;   // null: as converted / the .w2r says
  const probe = await SimSession.boot({ module: st.module, exe: picked.exe, files: st.files, replay: picked.replay, pud: null, rules }).catch(e => e);
  if (!(probe instanceof Error)) { attach(probe); return; }
  if (!/custom map/.test(probe.message)) throw probe;
  const want = /custom map (.*)$/.exec(probe.message)[1].replace(/^.*[\\/]/, '').toLowerCase();
  pud = picked.puds.get(want) || [...picked.puds.values()][0];
  if (!pud) throw new Error(`This replay uses the custom map “${want}”: add that .pud file.`);
  attach(await SimSession.boot({ module: st.module, exe: picked.exe, files: st.files, replay: picked.replay, pud, rules }));
}
function attach(s) {
  st.session = s;
  if (st.tracker) st.tracker.reset(s.mem());
  st.fog = new FogTracker(s.mem().r16(A.MapSize));
  st.fog.update(s.mem());
  if (st.renderer) st.renderer.terrain = null;   // new arena: full terrain refresh
  const m = s.mem();   // player view: per-player UI state restarts with the game (rebuilt while fast-forwarding)
  st.pv.ui = new UiVoices({ seed: m.r32(0x4d40a0), ext: !!m.r32(A.Extended), tileset: m.r8(A.Tileset) });
  st.pv.messages = []; st.pv.cam.reset(); st.pv.lastTick = -1;
  st.stepClock = null;
}

const createCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
// What audio.js needs: arena, viewed player (fog selector, -1 = all), the visible tiles, whether sound is on now.
function audioEnv() {
  const v = st.view, pv = st.pv.on;
  return { m: st.session.mem(), player: pv ? pvPlayer() : +ui.fog.value, playing: st.playing, pview: pv,
    view: pv ? { x: st.pv.cam.x / 32, y: st.pv.cam.y / 32, w: MAP_RECT.w / 32, h: MAP_RECT.h / 32 }
      : { x: v.x / 32, y: v.y / 32, w: ui.view.width / v.scale / 32, h: ui.view.height / v.scale / 32 },
    enabled: !st.busy && (st.speed === 1 || st.speed === 2) };
}
// The player view's UI emulation runs for every player all the time (its state must not depend on what was viewed).
function pvHandle(ev) {
  const s = st.session, m = s.mem();
  if (!st.pv.ui) return;
  const out = st.pv.ui.handle(ev, m, st.tickMs, m.r8(A.LocalPlayer), st.pv.names);
  if (out.messages.length) { st.pv.messages.push(...out.messages); if (st.pv.messages.length > 300) st.pv.messages.splice(0, st.pv.messages.length - 200); }
  const env = audioEnv();
  if (!st.pv.on || !env.enabled) return;
  const p = env.player;
  for (const x of out.sounds) if (x.player === p) audio.playUi(m.r8(A.PlayerRace + p), x.id);
}

function stepTurn(log = true) {
  const s = st.session;
  if (s.ended) return false;
  const r = s.step();
  st.fog.update(s.mem());
  st.tracker.after(s.mem(), s.turn - 1, s.tick);
  const ev = s.drainHooks();
  if (log) logEvents(ev);
  audio.handle(ev, audioEnv());
  pvHandle(ev);
  if (r >= 1 && r <= 3) setStatus(`Replay diverged at turn ${s.turn - 1} (status ${r}): the recording does not match this game data.`, true);
  return !s.ended;
}

async function seekTo(turn) {
  if (st.busy) return;
  st.busy = true;
  const wasPlaying = st.playing; setPlaying(false);
  try {
    if (turn < st.session.turn) { await boot(); ui.log.textContent = ''; }
    if (st.screen) st.screen = null;              // a seek hides the lobby / closes the outro (shown again at the end)
    st.outroClosed = false;
    if (turn === 0) { st.busy = false; maybeLobby(); return; }
    const t0 = performance.now();
    while (st.session.turn < turn && !st.session.ended) {
      for (let k = 0; k < 500 && st.session.turn < turn && stepTurn(turn - st.session.turn < 50); k++);
      if (performance.now() - t0 > 30) { updateClock(); await new Promise(r => setTimeout(r, 0)); }
    }
  } catch (e) { setStatus(e.message, true); }
  st.busy = false;
  if (wasPlaying) setPlaying(true);
}

// ---------------------------------------------------------------- playback loop
function setPlaying(on) { st.playing = !!(on && st.session && !st.session.ended); ui.play.textContent = st.playing ? 'Pause' : 'Play'; st.budget = 0; }
function playPressed() {
  if (lobbyUp()) { startFromLobby(); return; }
  closeScreen();
  if (st.session && st.session.ended) { seekTo(0); return; }   // Play at the end restarts: back to the lobby
  setPlaying(!st.playing);
}
function stepPressed() { closeScreen(); setPlaying(false); stepTurn(); }
ui.play.onclick = playPressed;
ui.step.onclick = stepPressed;
ui.speed.onchange = () => { st.speed = +ui.speed.value; st.budget = 0; };
ui.seek.oninput = () => { ui.clock.textContent = `seek to turn ${ui.seek.value}…`; };
ui.seek.onchange = () => seekTo(+ui.seek.value);
ui.fog.onchange = () => {
  if (st.pv.on && +ui.fog.value < 0) ui.fog.value = String(pvPlayer());   // the player view always has a player
  st.renderer.fogPlayer = +ui.fog.value; st.pv.cam.reset(); st.pv.camRec = true; st.pv.frame && (st.pv.frame.shown = null);
  if (st.screen && st.screen.kind === 'outro') st.screen.t0 = performance.now();
};
// ---- player view on / off
function pvPlayer() {
  const v = +ui.fog.value;
  return v >= 0 ? v : st.session ? st.session.mem().r8(A.LocalPlayer) : 0;
}
function setPlayerView(on) {
  on = !!(on && st.pv.frame);
  // the free view (camera and fog choice) is remembered while the player view is on and restored when it goes off
  if (on && !st.pv.on && st.session) st.freeCam = { ...(st.viewWant || viewCentre()), scale: st.view.scale, fog: ui.fog.value };
  const restore = !on && st.pv.on && st.freeCam;
  st.pv.on = on; ui.pview.checked = on;
  document.body.classList.toggle('pview', on);
  (on ? ui.pvSlot : ui.viewRow).prepend(ui.viewOpts);   // keep the selector + toggle reachable
  if (on) ui.wrap.append(ui.inspect); else $('players').before(ui.inspect);   // the inspect card floats over the game screen
  ui.inspect.classList.toggle('float', on);
  if (on) {
    if (+ui.fog.value < 0) { ui.fog.value = String(pvPlayer()); }
    st.renderer.fogPlayer = +ui.fog.value;
    st.pv.cam.reset(); if (st.pv.frame) st.pv.frame.shown = null;
  }
  ui.follow.hidden = !on || pvFollowing();
  if (restore) {
    st.view.scale = st.freeCam.scale; centreOn(st.freeCam.x, st.freeCam.y);
    if ([...ui.fog.options].some(o => o.value === st.freeCam.fog)) { ui.fog.value = st.freeCam.fog; st.renderer.fogPlayer = +ui.fog.value; }
  }
}
function pvFollow() { st.pv.cam.follow = true; st.pv.camRec = true; ui.follow.hidden = true; }
const pvRecTrack = () => camOn() && st.session ? st.cam.tracks.get(pvPlayer()) : null;
const pvFollowing = () => st.pv.cam.follow && (st.pv.camRec || !pvRecTrack());
ui.pview.onchange = () => setPlayerView(ui.pview.checked);
ui.follow.onclick = pvFollow;
ui.hp.onchange = () => { st.renderer.showHp = ui.hp.checked; };
ui.camShow.onchange = () => { st.pv.camRec = true; };
window.addEventListener('keydown', e => {
  if (!st.session || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.key === ' ') { e.preventDefault(); playPressed(); }
  else if (e.key === 'Escape' && st.inspect) { st.inspect = null; drawInspect(st.session.mem()); }
  else if (e.key === '.') stepPressed();
  else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey && !lobbyUp()) setPlayerView(!st.pv.on);
  else if ((e.key === 'f' || e.key === 'F') && st.pv.on && !e.ctrlKey && !e.metaKey) pvFollow();
  else if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey) { ui.hp.checked = !ui.hp.checked; ui.hp.onchange(); }
  else if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && st.cam.tracks.size) { ui.camShow.checked = !ui.camShow.checked; ui.camShow.onchange(); }
  else if (e.key >= '1' && e.key <= '8' && !e.ctrlKey && !e.metaKey && !e.altKey) {   // view player 1..8 (if in the game)
    const v = String(+e.key - 1);
    if ([...ui.fog.options].some(o => o.value === v)) { ui.fog.value = v; ui.fog.onchange(); }
  }
  else if (e.key === '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {                 // no fog (the player view is always fogged)
    if (st.pv.on) setPlayerView(false);
    ui.fog.value = '-1'; ui.fog.onchange();
  }
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey) {   // skip 10 s
    e.preventDefault();
    if (st.busy || lobbyUp() && e.key === 'ArrowLeft') return;
    const s = st.session, tpt = s.turn > 1 && s.tick > 0 ? s.tick / (s.turn - 1) : 1;   // average ticks per turn so far
    const dturns = Math.max(1, Math.round(10000 / st.tickMs / tpt));
    const target = Math.max(0, Math.min(st.totalTurns - 1, s.turn + (e.key === 'ArrowLeft' ? -dturns : dturns)));
    ui.seek.value = target; seekTo(target);
  }
  else if (st.screen && st.screen.kind === 'outro' && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== 'Shift' && e.target.tagName !== 'SELECT') { e.preventDefault(); closeScreen(); }
});

function frame(t) {
  requestAnimationFrame(frame);
  if (!st.session || st.loading) return;
  const dt = st.lastT ? Math.min(250, t - st.lastT) : 0; st.lastT = t;
  if (st.screen && st.screen.kind === 'intro') { st.budget = 0; }
  else if (st.playing && !st.busy) {
    const t0 = performance.now(), tick0 = st.session.tick, g0 = st.session.mem().r32(A.TickCount);
    if (st.speed === 0) { while (performance.now() - t0 < 12 && stepTurn()); }
    else {
      st.budget += dt * st.speed / st.tickMs;   // ticks we owe
      while (st.budget > 0 && performance.now() - t0 < 30) {
        const before = st.session.tick;
        if (!stepTurn()) break;
        st.budget -= Math.max(1, st.session.tick - before);
      }
      if (st.budget > 50) st.budget = 50;
    }
    // palette cycling runs on game time: wall clock x speed (max speed: the ticks played), frozen when paused
    st.renderer.advancePalette(st.speed === 0 ? (st.session.tick - tick0) * st.tickMs : dt * st.speed, st.session.mem());
    if (st.session.tick !== tick0) st.stepClock = { from: g0, t: t0 };
    if (st.session.ended) setPlaying(false);
  }
  if (st.session.ended && !st.busy && !st.screen && !st.outroClosed && st.tracker && st.match) showScreen('outro');
  const env = audioEnv();
  if (st.screen && st.screen.kind === 'outro' && st.screen.music) env.playing = true;
  audio.frame(env);
  draw();
}

function fmtTime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(Math.floor(s / 3600) ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; }
function updateClock() {
  const s = st.session;
  ui.clock.textContent = `turn ${Math.max(0, s.turn - 1)}/${st.totalTurns - 1} · tick ${s.tick} · ${fmtTime(s.tick * st.tickMs)}${s.ended ? ' · end' : ''}`;
  if (document.activeElement !== ui.seek) ui.seek.value = s.turn;
}

// ---------------------------------------------------------------- view
function resize() {
  const r = ui.wrap.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const c = st.session && (st.viewWant || viewCentre());
  ui.view.width = Math.round(r.width * d); ui.view.height = Math.round(r.height * d);
  if (c) centreOn(c.x, c.y);   // keep the intended centre (not the edge-clamped one) when the canvas changes size
}
// Free (non-player-view) camera centre in map pixels.
const viewCentre = () => ({ x: st.view.x + ui.view.width / st.view.scale / 2, y: st.view.y + ui.view.height / st.view.scale / 2 });
new ResizeObserver(resize).observe(ui.wrap);
const mapPx = () => 32 * st.session.mem().r16(A.MapSize);
function clampView() {
  const v = st.view, W = ui.view.width / v.scale, H = ui.view.height / v.scale, M = mapPx();
  v.x = W >= M ? (M - W) / 2 : Math.max(0, Math.min(M - W, v.x));
  v.y = H >= M ? (M - H) / 2 : Math.max(0, Math.min(M - H, v.y));
}
function centreOn(px, py) { st.viewWant = { x: px, y: py }; const v = st.view; v.x = px - ui.view.width / v.scale / 2; v.y = py - ui.view.height / v.scale / 2; clampView(); }
function centreOnLocal() {
  const m = st.session.mem(), lp = m.r8(A.LocalPlayer), us = readUnits(m).filter(u => u.owner === lp);
  const u = us.find(u => u.tflags & 0x20) || us[0];
  st.view.scale = window.devicePixelRatio || 1;
  if (u) centreOn(u.x + 16 * u.w, u.y + 16 * u.h); else centreOn(mapPx() / 2, mapPx() / 2);
}
let drag = null;
ui.view.addEventListener('pointerdown', e => {
  if (lobbyUp()) {   // only its "Start replay" button does something
    const r = ui.view.getBoundingClientRect(), d = window.devicePixelRatio || 1, q = st.screen.rect, b = st.lobbyBtn;
    if (q && b) {
      const x = ((e.clientX - r.left) * d - q.x) / q.k, y = ((e.clientY - r.top) * d - q.y) / q.k;
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) startFromLobby();
    }
    return;
  }
  if (st.screen) { closeScreen(); return; }
  if (st.pv.on) { pvPointerDown(e); return; }
  drag = { x: e.clientX, y: e.clientY, vx: st.view.x, vy: st.view.y, moved: false }; ui.view.setPointerCapture(e.pointerId); ui.view.classList.add('drag'); });
// player view: frame coordinates of a pointer event (the 640x480 screen is scaled into the canvas)
function pvPoint(e) {
  const r = ui.view.getBoundingClientRect(), d = window.devicePixelRatio || 1, q = st.pv.rect;
  if (!q) return null;
  return { x: ((e.clientX - r.left) * d - q.x) / q.k, y: ((e.clientY - r.top) * d - q.y) / q.k };
}
const inRect = (pt, R) => pt && pt.x >= R.x && pt.y >= R.y && pt.x < R.x + R.w && pt.y < R.y + R.h;
function pvMini(pt) {
  const M = mapPx(), c = st.pv.cam;
  c.follow = false; st.pv.camRec = false; ui.follow.hidden = false;
  c.centreOn(st.session.mem(), (pt.x - MINI_RECT.x) / MINI_RECT.w * M, (pt.y - MINI_RECT.y) / MINI_RECT.h * M);
}
function pvPointerDown(e) {
  const pt = pvPoint(e);
  if (inRect(pt, MINI_RECT)) { drag = { mini: true }; ui.view.setPointerCapture(e.pointerId); pvMini(pt); return; }
  if (!inRect(pt, MAP_RECT)) return;
  drag = { pv: true, x: e.clientX, y: e.clientY, vx: st.pv.cam.x, vy: st.pv.cam.y, moved: false };
  ui.view.setPointerCapture(e.pointerId); ui.view.classList.add('drag');
}
ui.view.addEventListener('pointermove', e => {
  if (!drag || !st.session) return;
  const d = window.devicePixelRatio || 1;
  if (drag.mini) { pvMini(pvPoint(e)); return; }
  if (drag.pv) {   // dragging the map releases the camera
    const k = st.pv.rect ? st.pv.rect.k : 1, dx = (e.clientX - drag.x) * d / k, dy = (e.clientY - drag.y) * d / k;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true; st.pv.cam.follow = false; st.pv.camRec = false; ui.follow.hidden = false;
    st.pv.cam.x = drag.vx - dx; st.pv.cam.y = drag.vy - dy; st.pv.cam.clamp(st.session.mem());
    return;
  }
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  st.view.x = drag.vx - (e.clientX - drag.x) * d / st.view.scale; st.view.y = drag.vy - (e.clientY - drag.y) * d / st.view.scale; clampView(); st.viewWant = viewCentre();
});
ui.view.addEventListener('pointerup', e => {
  const was = drag; drag = null; ui.view.classList.remove('drag');
  if (!was || was.moved || was.mini || !st.session) return;
  const r = ui.view.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  if (was.pv) {   // player view: frame point -> map pixel through the camera
    const pt = pvPoint(e); if (!inRect(pt, MAP_RECT)) return;
    inspectAt(st.pv.lastView.x + pt.x - MAP_RECT.x, st.pv.lastView.y + pt.y - MAP_RECT.y, pvPlayer());
  } else inspectAt(st.view.x + (e.clientX - r.left) * d / st.view.scale, st.view.y + (e.clientY - r.top) * d / st.view.scale, +ui.fog.value);
});
ui.view.addEventListener('wheel', e => {
  if (!st.session || st.pv.on) return;   // the player view keeps the game's own scale
  e.preventDefault();
  const d = window.devicePixelRatio || 1, r = ui.view.getBoundingClientRect(), v = st.view;
  const mx = (e.clientX - r.left) * d, my = (e.clientY - r.top) * d;
  const wx = v.x + mx / v.scale, wy = v.y + my / v.scale;
  v.scale = Math.max(0.1, Math.min(8, v.scale * Math.exp(-e.deltaY * 0.0015)));
  v.x = wx - mx / v.scale; v.y = wy - my / v.scale; clampView(); st.viewWant = viewCentre();
}, { passive: false });
function miniMove(e) {
  const r = ui.mini.getBoundingClientRect(), M = mapPx();
  centreOn((e.clientX - r.left) / r.width * M, (e.clientY - r.top) / r.height * M);
}
let miniDrag = false;
ui.mini.addEventListener('pointerdown', e => { if (!st.session) return; miniDrag = true; ui.mini.setPointerCapture(e.pointerId); miniMove(e); });
ui.mini.addEventListener('pointermove', e => { if (miniDrag) miniMove(e); });
ui.mini.addEventListener('pointerup', () => { miniDrag = false; });

let lastPanel = 0, lastDraw = 0;
// Player view: the game's 640x480 screen (playerview.js PlayerFrame) scaled to fit the canvas.
function drawPlayerView(ctx, W, H, m) {
  const now = performance.now(), dt = lastDraw ? Math.min(250, now - lastDraw) : 0;
  const p = pvPlayer(), sel = selectionOf(m, p), s = st.session;
  let view = st.pv.cam.update(m, p, st.busy ? 0 : dt);
  const tr = st.pv.camRec ? pvRecTrack() : null, rec = tr ? camAt(tr, camTime(), st.tickMs) : null;
  if (rec) {   // the player's own viewport (tiles), as recorded
    const c = st.pv.cam; c.x = rec.vx * 32; c.y = rec.vy * 32; c.clamp(m); view = { x: Math.round(c.x), y: Math.round(c.y) };
  }
  const ticks = st.pv.lastTick < 0 || s.tick < st.pv.lastTick || s.tick - st.pv.lastTick > 400 ? -1 : s.tick - st.pv.lastTick;
  st.pv.lastTick = s.tick; st.pv.lastView = view;
  const c = st.pv.frame.render({ m, p, renderer: st.renderer, fog: st.fog, view, selection: sel, counterFrames: ticks,
    messages: visibleMessages(st.pv.messages, p, s.tick, st.tickMs) });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  let k = Math.min(W / FRAME_W, H / FRAME_H);
  if (k >= 1) k = Math.max(1, Math.floor(k * 4) / 4);   // crisp: quarter steps when scaling up
  const w = Math.round(FRAME_W * k), h = Math.round(FRAME_H * k), x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
  ctx.imageSmoothingEnabled = k < 1;
  ctx.drawImage(c, 0, 0, FRAME_W, FRAME_H, x, y, w, h);
  st.pv.rect = { x, y, k };
  const iu = inspectedUnit(m);
  if (iu) {   // the inspected unit's box, inside the map pane
    ctx.save(); ctx.beginPath(); ctx.rect(x + MAP_RECT.x * k, y + MAP_RECT.y * k, MAP_RECT.w * k, MAP_RECT.h * k); ctx.clip();
    inspectBox(ctx, m, iu, view.x - MAP_RECT.x, view.y - MAP_RECT.y, k, x, y);
    ctx.restore();
  }
  const cur = rec && cursorFor(p);
  if (cur) {   // the game's cursor at the recorded mouse point (clipped to the 640x480 screen)
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(cur.cv, x + (rec.mx - cur.hx) * k, y + (rec.my - cur.hy) * k, cur.w * k, cur.h * k);
    ctx.restore();
  }
  ui.follow.hidden = pvFollowing();
}
// Free view: the recorded viewports and mouse cursors of the shown players (fog player, or all).
function drawCams(ctx, m, mctx, mk) {
  const fp = +ui.fog.value, t = camTime(), v = st.view, d = window.devicePixelRatio || 1, M = m.r16(A.MapSize);
  const players = readPlayers(m), colour = p => { const q = players.find(x => x.id === p); return q && st.tileset.rgb[q.colorIdx] || [255, 255, 255]; };
  for (const [p, tr] of st.cam.tracks) {
    if (fp >= 0 && p !== fp) continue;
    const c = camAt(tr, t, st.tickMs); if (!c) continue;
    const g = trackGeometry(tr), [r, gg, b] = colour(p), col = `rgb(${r},${gg},${b})`;
    const X = (c.vx * 32 - v.x) * v.scale, Y = (c.vy * 32 - v.y) * v.scale, W = g.tilesW * 32 * v.scale, H = g.tilesH * 32 * v.scale;
    ctx.save();
    ctx.lineWidth = 2 * d; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeRect(X + d, Y + d, W, H);
    ctx.strokeStyle = col; ctx.strokeRect(X, Y, W, H);
    ctx.font = `${Math.round(11 * d)}px sans-serif`; ctx.textBaseline = 'bottom'; ctx.fillStyle = col;
    ctx.fillText(st.pv.names[p] || `player ${p + 1}`, X + 2 * d, Y - 2 * d);
    const mt = mouseTarget(c, g, M);
    if (mt.where !== 'panel') {
      const sx = (mt.x - v.x) * v.scale, sy = (mt.y - v.y) * v.scale, cur = cursorFor(p);
      if (mt.where === 'map' && cur) { ctx.imageSmoothingEnabled = false; ctx.drawImage(cur.cv, sx - cur.hx * d, sy - cur.hy * d, cur.w * d, cur.h * d); }
      else { ctx.lineWidth = 1.5 * d; ctx.beginPath(); ctx.arc(sx, sy, 6 * d, 0, 2 * Math.PI); ctx.moveTo(sx - 9 * d, sy); ctx.lineTo(sx + 9 * d, sy); ctx.moveTo(sx, sy - 9 * d); ctx.lineTo(sx, sy + 9 * d); ctx.stroke(); }
    }
    ctx.restore();
    mctx.strokeStyle = col; mctx.lineWidth = 1;
    mctx.strokeRect(c.vx * 32 * mk + 0.5, c.vy * 32 * mk + 0.5, g.tilesW * 32 * mk, g.tilesH * 32 * mk);
  }
}
function draw() {
  const m = st.session.mem(), ctx = ui.view.getContext('2d'), W = ui.view.width, H = ui.view.height;
  if (st.pv.on && st.pv.frame) {
    drawPlayerView(ctx, W, H, m);
    lastDraw = performance.now();
    if (lastDraw - lastPanel > 200) { lastPanel = lastDraw; drawInspect(m); }
    if (st.screen && updateScreen()) drawScreen(ctx, W, H);
    updateClock();
    return;
  }
  lastDraw = performance.now();
  clampView();
  st.renderer.draw(ctx, W, H, st.view, m, st.fog);
  { const iu = inspectedUnit(m); if (iu && !st.screen) inspectBox(ctx, m, iu, st.view.x, st.view.y, st.view.scale, 0, 0); }
  if (st.screen && updateScreen()) drawScreen(ctx, W, H);
  // minimap
  const mc = st.renderer.drawMinimap(m, st.fog), mctx = ui.mini.getContext('2d'), S = ui.mini.width, n = mc.width;
  mctx.imageSmoothingEnabled = false;
  mctx.drawImage(mc, 0, 0, n, n, 0, 0, S, S);
  const k = S / mapPx(), v = st.view;
  mctx.strokeStyle = '#fff'; mctx.lineWidth = 1;
  mctx.strokeRect(v.x * k + 0.5, v.y * k + 0.5, W / v.scale * k, H / v.scale * k);
  if (camOn() && !st.screen) drawCams(ctx, m, mctx, k);
  updateClock();
  const now = performance.now();
  if (now - lastPanel > 200) { lastPanel = now; drawPlayers(m); drawInspect(m); }
}

// ---------------------------------------------------------------- click to inspect (unitinfo.js)
// A click on the map picks the unit / building under it (what that view shows: the fog player's view of it),
// its stats go into the side panel (#inspect) and a white box marks it; Esc or a click on nothing clears it.
function inspectAt(px, py, fp) {
  const m = st.session.mem(), R = st.renderer, keep = R.fogPlayer;
  const u = pickUnit(m, px, py, fp >= 0 ? a => { R.fogPlayer = fp; const v = m.r8(a + 0x2c) === fp || R._unitVisible(m, a); R.fogPlayer = keep; return v; } : null);
  st.inspect = unitRef(m, u);
  drawInspect(m);
}
function inspectedUnit(m) {
  const r = st.inspect;
  return r && refAlive(m, r) === 'ok' && !(m.r16(r.addr + 0x1e) & 8) ? r.addr : 0;
}
// 1 px white box with a dark edge around the type box (map pixels -> canvas: (p - v) * s + o)
function inspectBox(ctx, m, u, vx, vy, s, ox, oy) {
  const t = m.r8(u + 0x27), bw = (m.r16(A.TypeBox + 4 * t) << 16) >> 16, bh = (m.r16(A.TypeBox + 4 * t + 2) << 16) >> 16;
  const cx = m.s16(u) + 16 * m.r16(A.TypeSize + 4 * t), cy = m.s16(u + 2) + 16 * m.r16(A.TypeSize + 4 * t + 2);
  const X = ox + (cx - bw / 2 - 3 - vx) * s, Y = oy + (cy - bh / 2 - 3 - vy) * s, w = (bw + 6) * s, h = (bh + 6) * s;
  ctx.lineWidth = Math.max(1, s); ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeRect(X - ctx.lineWidth, Y - ctx.lineWidth, w + 2 * ctx.lineWidth, h + 2 * ctx.lineWidth);
  ctx.strokeStyle = '#fff'; ctx.strokeRect(X, Y, w, h);
}
function drawInspect(m) {
  const esc = x => String(x).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  const el = ui.inspect, r = st.inspect;
  if (!r) { if (!el.hidden) { el.hidden = true; el.innerHTML = ''; } return; }
  const alive = refAlive(m, r);
  let html;
  if (alive === 'gone') html = `<div class="inspHead"><span>${esc(st.inspectName || 'Unit')}</span><button class="inspX" title="Close (Esc)">×</button></div><div class="inspNote">no longer exists</div>`;
  else {
    const I = unitInfo(m, r.addr, { tbl: st.pv.art && st.pv.art.statTxt, tickMs: st.tickMs, names: st.pv.names, extended: !!m.r32(A.Extended) });
    st.inspectName = I.name;
    const c = I.owner < 8 ? st.tileset.rgb[m.r8(A.PlayerColor + I.owner)] || [128, 128, 128] : [160, 160, 160];
    const hpf = I.maxHp ? Math.min(1, I.hp / I.maxHp) : 0, hpc = hpf > 0.5 ? '#2c2' : hpf > 0.25 ? '#dc2' : '#d22';
    html = `<div class="inspHead"><span>${esc(I.name)}</span><button class="inspX" title="Close (Esc)">×</button></div>` +
      `<div class="inspOwner"><i style="background:rgb(${c.join(',')})"></i>${esc(I.ownerName)}${alive === 'dead' ? ' · <b>dead</b>' : ''}</div>` +
      (I.maxHp ? `<div class="inspBar"><b style="width:${(100 * hpf).toFixed(1)}%;background:${hpc}"></b><span>${I.hp} / ${I.maxHp} HP</span></div>` : '') +
      I.bars.map(b => `<div class="inspLbl">${esc(b.label)}</div><div class="inspBar prog"><b style="width:${(100 * b.frac).toFixed(1)}%"></b><span>${esc(b.text)}${b.left ? ` · ${esc(b.left)} left` : ''}</span></div>`).join('') +
      (I.rows.length ? `<table>${I.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : '') +
      (I.notes.length ? `<div class="inspNote">${I.notes.map(esc).join(' · ')}</div>` : '');
  }
  if (html !== el._html) { el.innerHTML = html; el._html = html; el.querySelector('.inspX').onclick = () => { st.inspect = null; drawInspect(m); }; }
  el.hidden = false;
}

function drawPlayers(m) {
  const units = readUnits(m), html = [];
  const ended = st.session.ended && st.tracker;
  for (const p of readPlayers(m, units)) {
    const c = st.tileset.rgb[p.colorIdx] || [128, 128, 128];
    const ps = playerStats(m, p.id);   // the game's running stats (g_Stat*), as on the end screen
    const oc = ended && st.tracker.players.includes(p.id) ? OUTCOME_TEXT[outcome(m, p.id, st.tracker.left).kind] : '';
    html.push(`<div class="player${p.defeated ? ' out' : ''}"><span class="sw" style="background:rgb(${c})"></span>
      <span class="nm">${esc(p.name || `Player ${p.id + 1}`)}</span><span class="meta">${p.raceName} · ${p.colorName}${p.ctrl ? ' · ' + p.ctrlName : ''}${p.defeated ? ' · defeated' : ''}${oc ? ' · ' + oc.replace('!', '') : ''}</span>
      <span class="res"><span>gold ${p.gold}</span><span>lumber ${p.lumber}</span><span>oil ${p.oil}</span><span>food ${p.food}/${p.foodMax}</span>
      <span>units ${p.liveUnits}</span><span>buildings ${p.liveBldgs}</span></span>
      <span class="res stats"><span>score ${ps.score}</span><span>kills ${ps.kills}</span><span>razings ${ps.razed}</span>
      <span title="units produced, including lost ones (the end screen's Units column)">units made ${ps.units}</span><span title="buildings produced, including lost ones">buildings made ${ps.bldgs}</span></span></div>`);
  }
  ui.players.innerHTML = html.join('');
}
const esc = s => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- event log (hook ring, w2hooks.h)
const HK = { SOUND: 1, VOICE_SELECT: 2, VOICE_ACK: 3, STATUS_MSG: 4, MSG_TIMED: 5, STATUS_LINE: 6, ALERT: 8, MUSIC: 12 };
function logEvents(evs) {
  if (!evs.length) return;
  const m = st.session.mem(), lines = [];
  for (const e of evs) {
    let cls, text;
    switch (e.kind) {
      case HK.SOUND: if (!ui.logSounds.checked) continue; cls = 'snd'; text = `sound ${(st.sounds[e.a - 1] || '#' + e.a).replace(/^.*\\/, '')}`; break;
      case HK.VOICE_SELECT: case HK.VOICE_ACK: {
        if (!ui.logVoices.checked) continue;
        const type = e.kind === HK.VOICE_ACK ? e.b : e.c;
        cls = 'voice'; text = `${e.kind === HK.VOICE_ACK ? 'acknowledge' : 'selected'}: ${UNIT_NAMES[type] || 'type ' + type}`; break;
      }
      case HK.STATUS_MSG: case HK.MSG_TIMED:   // HKM_OTHER: another player's own message (listed when viewing it)
        if (e.kind === HK.STATUS_MSG && (e.d & 0x100) && +ui.fog.value !== (e.d & 7)) continue;
        cls = 'msg'; text = m.cstr(e.a, 120); break;
      case HK.STATUS_LINE: cls = 'msg'; text = e.a > 0x400000 ? m.cstr(e.a, 120) : `status line #${e.a}`; break;
      case HK.ALERT: cls = 'alert'; text = `alert at ${e.a},${e.b}`; break;
      default: continue;
    }
    lines.push(`<div class="k-${cls}"><span class="t">${fmtTime(e.tick * st.tickMs)}</span>${esc(text)}</div>`);
  }
  if (!lines.length) return;
  const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 4;
  ui.log.insertAdjacentHTML('beforeend', lines.join(''));
  while (ui.log.childElementCount > 400) ui.log.firstElementChild.remove();
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}
