// MPQ v1 reader (Storm archives as used by Warcraft II BNE: War2Dat.mpq, War2Patch.mpq). No dependencies;
// runs in browsers and node. Supports: v1 header (also at a 512-byte aligned offset / behind MPQ\x1b user
// data), encrypted hash and block tables, per-file encryption (key from the base name, FIX_KEY), sector
// offset tables, single-unit files, stored sectors and every Storm sector codec up to Warcraft III: PKWARE DCL
// implode ("explode", 0x08), Huffman (0x01), IMA ADPCM mono/stereo (0x40/0x80), bzip2 (0x10) and zlib (0x02,
// async only, through DecompressionStream), also combined in one multi-compression mask byte (applied in
// StormLib's order). Not supported: sparse (0x20) and LZMA (0x12), Starcraft II only.
// War2Dat.mpq itself uses only PKWARE and stored sectors (its .wav files too); the other codecs are checked
// against StormLib on archives built by tools/mpq/mpqmk (test_mpq.mjs --codecs).
//
//   const a = new MpqArchive(uint8array);
//   a.has('rez\\unitdata.dat'); a.read('rez\\unitdata.dat') -> Uint8Array | null  (sync; throws on zlib)
//   await a.readAsync(name)                                                       (any supported method)
//   a.listfile() -> [names] from the internal (listfile), if any
//   const fs = new MpqSet([patch, dat]);  // first archive that has the name wins (patch overrides dat)

const CRYPT = (() => {
  const t = new Uint32Array(0x500);
  let seed = 0x00100001;
  for (let i1 = 0; i1 < 0x100; i1++) {
    for (let i = 0, i2 = i1; i < 5; i++, i2 += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab; const hi = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab; const lo = seed & 0xffff;
      t[i2] = (hi | lo) >>> 0;
    }
  }
  return t;
})();

// Storm's HashString. type 0: hash-table index, 1/2: name check A/B, 3: file key. Case-insensitive,
// '/' is the same as '\\' (Storm upcases and the game always passes backslashes).
export function hashString(str, type) {
  let s1 = 0x7fed7fed, s2 = 0xeeeeeeee;
  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i) & 0xff;
    if (ch >= 0x61 && ch <= 0x7a) ch -= 0x20;
    if (ch === 0x2f) ch = 0x5c;
    s1 = (CRYPT[type * 0x100 + ch] ^ ((s1 + s2) >>> 0)) >>> 0;
    s2 = (ch + s1 + s2 + (s2 << 5) + 3) >>> 0;
  }
  return s1;
}

// In-place decrypt of the whole dwords of `u8` (a trailing partial dword is stored plain).
function decrypt(u8, key) {
  const n = u8.length >>> 2;
  const dv = new DataView(u8.buffer, u8.byteOffset, n * 4);
  let s2 = 0xeeeeeeee;
  key >>>= 0;
  for (let i = 0; i < n; i++) {
    s2 = (s2 + CRYPT[0x400 + (key & 0xff)]) >>> 0;
    const ch = (dv.getUint32(4 * i, true) ^ ((key + s2) >>> 0)) >>> 0;
    dv.setUint32(4 * i, ch, true);
    key = ((((~key) << 21) + 0x11111111) | (key >>> 11)) >>> 0;
    s2 = (ch + s2 + (s2 << 5) + 3) >>> 0;
  }
}

// ---- PKWARE Data Compression Library "explode" (port of zlib's contrib/blast/blast.c by Mark Adler) ----
const MAXBITS = 13;
function construct(rep) {
  const length = [];
  for (const b of rep) { let left = (b >> 4) + 1; const len = b & 15; while (left--) length.push(len); }
  const count = new Uint16Array(MAXBITS + 1), symbol = new Uint16Array(length.length), offs = new Uint16Array(MAXBITS + 1);
  for (const l of length) count[l]++;
  for (let l = 1; l < MAXBITS; l++) offs[l + 1] = offs[l] + count[l];
  for (let s = 0; s < length.length; s++) if (length[s]) symbol[offs[length[s]]++] = s;
  return { count, symbol };
}
const LIT = construct([11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
  9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
  8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
  44, 173]);
const LEN = construct([2, 35, 36, 53, 38, 23]);
const DIST = construct([2, 20, 53, 230, 247, 151, 248]);
const LBASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LEXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

export function explode(src, outSize) {
  const out = new Uint8Array(outSize);
  let ip = 0, op = 0, bitbuf = 0, bitcnt = 0;
  const bits = need => {
    let val = bitbuf;
    while (bitcnt < need) {
      if (ip >= src.length) throw new Error('explode: input exhausted');
      val |= src[ip++] << bitcnt; bitcnt += 8;
    }
    bitbuf = val >>> need; bitcnt -= need;
    return val & ((1 << need) - 1);
  };
  const decode = h => {   // codes are stored bit-inverted
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= bits(1) ^ 1;
      const count = h.count[len];
      if (code < first + count) return h.symbol[index + (code - first)];
      index += count; first = (first + count) << 1; code <<= 1;
    }
    throw new Error('explode: bad code');
  };
  const lit = bits(8), dict = bits(8);
  if (lit > 1 || dict < 4 || dict > 6) throw new Error(`explode: bad header ${lit}/${dict}`);
  for (;;) {
    if (bits(1)) {
      const sym = decode(LEN);
      const len = LBASE[sym] + bits(LEXTRA[sym]);
      if (len === 519) break;
      const sh = len === 2 ? 2 : dict;
      const dist = ((decode(DIST) << sh) + bits(sh)) + 1;
      if (dist > op) throw new Error('explode: distance too far back');
      for (let i = 0; i < len; i++, op++) { if (op >= outSize) return out; out[op] = out[op - dist]; }
    } else {
      if (op >= outSize) return out;
      out[op++] = lit ? decode(LIT) : bits(8);
    }
  }
  return op === outSize ? out : out.subarray(0, op);
}

// ---- Storm Huffman (compression mask 0x01; StormLib huff.cpp semantics) ----
// Adaptive Huffman over a doubly linked list sorted by weight (highest first, the root) in which siblings are
// adjacent: an inner node stores only its lower-weight child, the higher-weight one is that child's predecessor.
// The first byte of the stream selects the initial weight table; type 0 is adaptive (weights grow per byte),
// symbol 0x101 inserts a new literal (8 raw bits), 0x100 ends the stream. Bits are read LSB first.
// Weight tables: StormLib's DataDistributions (huff.cpp, index = compression type).
const HUFF_WEIGHTS_B64 = [
  'CgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg==',   // sparse (type 0, adaptive)
  'VBYWDQwIBgUGBQYDBAQDBQ4LFBMTCQsGBQQDAgMCAgINBwkGBgQDAgQDAwMDAwICCQYEBAQEAwIDAgICAgMCBAgDBAcJBQMDAwMCAgIDAgIDAgICAgICAgIBAQECAQICBgoICAYHBAMEBAICBAIDAwQDBwcJBgQDAwIBAgICAgIKAgIDAgIBAQICAgYDBQIDAgEBAQEBAQEBAQECAwEBAQIBAQEBAQECBAQEBwkIDAIBAQEBAQEBAQEBAQECAQEDBAECBAUBAQEBAQEBAgEBAQQBAQEBAQIBAQEBAQEBAQECAQEBAQEBAQMBAQEBAQEBAgEBAQEBAQICAQECAgIGSw==',   // binary
  '/wsHBQsCAgIGAgIBBAIBAwkBAQEDBAEBAgEBAQIBAQEFAQEBDQEBAQEBAQEBAQEBAgEBAwEBAQEBAQECAQEBAQoEAgEGAwIBAQEBAQMBAQEFAgMEAwMDAgEBAQIBAgMDAQMBAQIFAQEEAwUBAwEDAwIBBAMKBgEBAQEBAQEBAQECAgEKAgUBAQIHAhcBBQEBDgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBBgIBBAUBAQIBAQEBAgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQcBAQIBAQEBAgEBAQEBAQECAQEBAQEBEQ==',   // general
  'AAAAAAAAAAAAAycAACMAAAAAAAAAAAAAAAAAAAAAAAD/AQEBAQEBAQICAQEGDhAEBggFBAQDAwICAwMBAQIBAQEEAgQCAgIBAQQBAQIDAwIDAQMGBAEBAQEBAQIBAgEBASkHFhJACgoRJQEDFxAmKhABIyMvEAYHAgkBAQEBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',   // text
  '//uYmoSFY2Q+PiIiExMYFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',   // ADPCM 4-bit
  '//GdnpqbmpeTk4yOhoiAgnx8cnNpa19gVVZKS0BBNzcvLycnISEbHBcXExMQEA0NCwsJCQgIBwcGBQUEBAQZGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',   // ADPCM 6-bit
  'w8v1Qf979yEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL/M8kD9fPciAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6RgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',   // stereo 3
  'w9nvPfl86R79q/Es/Fv+FwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL3Z7D31fegd+67wLPtc/xgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',   // stereo 4
  'usXaM+Nt2BjllNoj30rREO6v5CzqWt4V9IfpIfZD/BIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALDH2DPja9YY55XYI9tJ0BHpsuIr6FzdFfGH5yD3RP8TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfngAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',   // stereo 5
];
let HUFF_WEIGHTS = null;
const b64bytes = s => { const t = atob(s), u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };

export function huffDecompress(src, outSize) {
  if (!HUFF_WEIGHTS) HUFF_WEIGHTS = HUFF_WEIGHTS_B64.map(b64bytes);
  let ip = 0, bb = 0, bc = 0;
  const bit = () => { if (!bc) { bb = ip < src.length ? src[ip++] : 0; bc = 8; } const b = bb & 1; bb >>= 1; bc--; return b; };
  const byte8 = () => { let v = 0; for (let i = 0; i < 8; i++) v |= bit() << i; return v; };
  const H = { weight: 0, prev: null, next: null };   // list head; H.next = first (root), H.prev = last
  H.prev = H.next = H;
  const byByte = new Array(0x102).fill(null);
  let maxWeight = 0;
  const remove = it => { if (it.next) { it.prev.next = it.next; it.next.prev = it.prev; it.next = it.prev = null; } };
  const linkAfter = (a, b) => { b.next = a.next; b.prev = a; a.next.prev = b; a.next = b; };
  const create = (value, weight, front) => {
    const it = { value, weight, prev: null, next: null, parent: null, lo: null };
    if (front) linkAfter(H, it); else linkAfter(H.prev, it);
    return it;
  };
  const higherOrEqual = (it, w) => { for (; it !== H; it = it.prev) if (it.weight >= w) return it; return H; };
  const fixup = it => {
    if (it.weight < maxWeight) { const hi = higherOrEqual(H.prev, it.weight); remove(it); linkAfter(hi, it); }
    else maxWeight = it.weight;
  };
  const incWeights = it => {
    for (; it; it = it.parent) {
      it.weight++;
      const higher = higherOrEqual(it.prev, it.weight), swap = higher.next;
      if (swap === it) continue;
      remove(swap); linkAfter(it, swap);
      remove(it); linkAfter(higher, it);
      const swapParentLo = swap.parent.lo, par = it.parent;
      if (par.lo === it) par.lo = swap;
      if (swapParentLo === swap) swap.parent.lo = it;
      it.parent = swap.parent; swap.parent = par;
    }
  };
  const type = byte8();
  if ((type & 0x0f) > 8) throw new Error(`huffman: bad compression type ${type}`);
  const adaptive = type === 0, W = HUFF_WEIGHTS[type & 0x0f];
  for (let i = 0; i < 0x100; i++) if (W[i]) fixup(byByte[i] = create(i, W[i], true));
  byByte[0x100] = create(0x100, 1, false);
  byByte[0x101] = create(0x101, 1, false);
  for (let lo = H.prev; lo !== H;) {
    const hi = lo.prev;
    if (hi === H) break;
    const p = create(0, hi.weight + lo.weight, true);
    lo.parent = hi.parent = p; p.lo = lo;
    fixup(p);
    lo = hi.prev;
  }
  const out = new Uint8Array(outSize);
  let op = 0;
  while (op < outSize) {
    if (ip >= src.length && !bc) break;   // StormLib: no more input bits -> stop (error)
    let it = H.next;
    while (it.lo) it = bit() ? it.lo.prev : it.lo;
    let v = it.value;
    if (v === 0x100) break;
    if (v === 0x101) {
      v = byte8();
      const last = H.prev;   // InsertNewBranchAndRebalance(last.value, v)
      const hiC = create(last.value, last.weight, false); hiC.parent = last; byByte[last.value] = hiC;
      const loC = create(v, 0, false); loC.parent = last; last.lo = loC; byByte[v] = loC;
      incWeights(loC);
      if (!adaptive) incWeights(byByte[v]);
    }
    out[op++] = v;
    if (adaptive) incWeights(byByte[v]);
  }
  return op === outSize ? out : out.subarray(0, op);
}

// ---- IMA ADPCM (masks 0x40 mono / 0x80 stereo; StormLib adpcm.cpp DecompressADPCM) ----
const ADPCM_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88,
  97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132,
  7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const ADPCM_NEXT = [-1, 0, -1, 4, -1, 2, -1, 6, -1, 1, -1, 5, -1, 3, -1, 7, -1, 1, -1, 5, -1, 3, -1, 7, -1, 2, -1, 4, -1, 6, -1, 8];

export function adpcmDecompress(src, outSize, channels) {
  const out = new Uint8Array(outSize), dv = new DataView(out.buffer);
  let ip = 0, op = 0;
  const write = s => { if (op + 2 > outSize) return false; dv.setInt16(op, s, true); op += 2; return true; };
  const done = () => op === outSize ? out : out.subarray(0, op);
  if (src.length < 2) return done();
  const shift = src[1]; ip = 2;   // byte 0 unused, byte 1 = bit shift
  const pred = [0, 0], step = [0x2c, 0x2c];
  for (let c = 0; c < channels; c++) {
    if (ip + 2 > src.length) return done();
    pred[c] = (src[ip] | src[ip + 1] << 8) << 16 >> 16; ip += 2;
    if (!write(pred[c])) return done();
  }
  let ch = channels - 1;
  while (ip < src.length) {
    const e = src[ip++];
    ch = (ch + 1) % channels;
    if (e & 0x80) {
      switch (e & 0x7f) {
        case 0:
          if (step[ch]) step[ch]--;
          if (!write(pred[ch])) return done();
          break;
        case 1:
          step[ch] += 8; if (step[ch] > 0x58) step[ch] = 0x58;
          ch = (ch + 1) % channels;
          break;
        case 2:
          ch = (ch + 1) % channels;
          break;
        default:
          step[ch] -= 8; if (step[ch] < 0) step[ch] = 0;
          ch = (ch + 1) % channels;
          break;
      }
    } else {
      const ss = ADPCM_STEP[step[ch]];
      let d = ss >> shift;
      if (e & 0x01) d += ss;
      if (e & 0x02) d += ss >> 1;
      if (e & 0x04) d += ss >> 2;
      if (e & 0x08) d += ss >> 3;
      if (e & 0x10) d += ss >> 4;
      if (e & 0x20) d += ss >> 5;
      let p = pred[ch];
      if (e & 0x40) { p -= d; if (p <= -32768) p = -32768; } else { p += d; if (p >= 32767) p = 32767; }
      pred[ch] = p;
      if (!write(p)) break;
      let s = step[ch] + ADPCM_NEXT[e & 0x1f];
      step[ch] = s < 0 ? 0 : s > 88 ? 88 : s;
    }
  }
  return done();
}

// ---- bzip2 (mask 0x10; Warcraft III and later, not used by War2 but cheap to support) ----
export function bunzip2(src, outSize) {
  let ip = 0, bb = 0, bc = 0;
  const bits = n => {
    while (bc < n) { if (ip >= src.length) throw new Error('bzip2: input exhausted'); bb = (bb << 8 | src[ip++]) >>> 0; bc += 8; }
    bc -= n; const v = (bb >>> bc) & ((1 << n) - 1); bb &= (1 << bc) - 1; return v;
  };
  if (bits(8) !== 0x42 || bits(8) !== 0x5a || bits(8) !== 0x68) throw new Error('bzip2: bad header');
  const level = bits(8) - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');
  const out = new Uint8Array(outSize);
  let op = 0;
  const tt = new Uint32Array(level * 100000);
  for (;;) {
    const m1 = bits(24), m2 = bits(24);
    if (m1 === 0x177245 && m2 === 0x385090) break;   // end of stream
    if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block magic');
    bits(16); bits(16);   // block CRC
    if (bits(1)) throw new Error('bzip2: randomised blocks not supported');
    const origPtr = bits(24);
    const used = bits(16), seqToUnseq = [];
    for (let i = 0; i < 16; i++) if (used & (0x8000 >> i)) { const w = bits(16); for (let j = 0; j < 16; j++) if (w & (0x8000 >> j)) seqToUnseq.push(16 * i + j); }
    if (!seqToUnseq.length) throw new Error('bzip2: no symbols');
    const nGroups = bits(3), nSel = bits(15);
    if (nGroups < 2 || nGroups > 6 || !nSel) throw new Error('bzip2: bad tables');
    const mtfG = [0, 1, 2, 3, 4, 5].slice(0, nGroups), sel = new Uint8Array(nSel);
    for (let i = 0; i < nSel; i++) {
      let j = 0; while (bits(1)) { if (++j >= nGroups) throw new Error('bzip2: bad selector'); }
      const v = mtfG[j]; mtfG.splice(j, 1); mtfG.unshift(v); sel[i] = v;
    }
    const alpha = seqToUnseq.length + 2, tabs = [];
    for (let g = 0; g < nGroups; g++) {
      const len = new Uint8Array(alpha);
      let l = bits(5);
      for (let s = 0; s < alpha; s++) {
        for (;;) { if (l < 1 || l > 20) throw new Error('bzip2: bad code length'); if (!bits(1)) break; l += bits(1) ? -1 : 1; }
        len[s] = l;
      }
      let minL = 32, maxL = 0;
      for (const x of len) { if (x < minL) minL = x; if (x > maxL) maxL = x; }
      // canonical codes: per length, symbols in increasing order
      const perm = [], limit = new Int32Array(maxL + 2), base = new Int32Array(maxL + 2);
      for (let L = minL; L <= maxL; L++) for (let s = 0; s < alpha; s++) if (len[s] === L) perm.push(s);
      let code = 0, k = 0;
      for (let L = minL; L <= maxL; L++) {
        let n = 0; for (let s = 0; s < alpha; s++) if (len[s] === L) n++;
        base[L] = k - code;            // perm index = code + base[L]
        code += n; k += n;
        limit[L] = code - 1;           // last code of this length
        code <<= 1;
      }
      tabs.push({ minL, maxL, perm, limit, base, len });
    }
    const mtf = []; for (let i = 0; i < 256; i++) mtf.push(i);
    const unzftab = new Uint32Array(256);
    const EOB = alpha - 1, max = level * 100000;
    let n = 0, gi = 0, gleft = 0, t = null, run = 0, runW = 1;
    const flushRun = () => {
      if (!run) return;
      const b = seqToUnseq[mtf[0]];
      if (n + run > max) throw new Error('bzip2: block overflow');
      unzftab[b] += run; while (run--) tt[n++] = b;
      run = 0; runW = 1;
    };
    for (;;) {
      if (!gleft) { if (gi >= nSel) throw new Error('bzip2: selectors exhausted'); t = tabs[sel[gi++]]; gleft = 50; }
      gleft--;
      let L = t.minL, c = bits(L);
      while (L <= t.maxL && c > t.limit[L]) { c = c << 1 | bits(1); L++; }
      if (L > t.maxL) throw new Error('bzip2: bad code');
      const sym = t.perm[c + t.base[L]];
      if (sym <= 1) { run += runW << sym; runW <<= 1; continue; }   // RUNA / RUNB
      flushRun();
      if (sym === EOB) break;
      const j = sym - 1, v = mtf[j];
      mtf.copyWithin(1, 0, j); mtf[0] = v;
      if (n >= max) throw new Error('bzip2: block overflow');
      const b = seqToUnseq[v]; unzftab[b]++; tt[n++] = b;
    }
    if (origPtr >= n) throw new Error('bzip2: bad origPtr');
    // inverse BWT
    const cftab = new Uint32Array(257);
    for (let i = 0; i < 256; i++) cftab[i + 1] = cftab[i] + unzftab[i];
    for (let i = 0; i < n; i++) { const b = tt[i] & 0xff; tt[cftab[b]++] |= i << 8; }
    let pos = tt[origPtr] >>> 8, last = -1, cnt = 0;
    for (let i = 0; i < n; i++) {
      const e = tt[pos], b = e & 0xff; pos = e >>> 8;
      if (cnt === 4) {   // RLE1: 4 equal bytes then a repeat count
        for (let r = 0; r < b; r++) { if (op >= outSize) return out; out[op++] = last; }
        cnt = 0; last = -1; continue;
      }
      if (b === last) cnt++; else { cnt = 1; last = b; }
      if (op >= outSize) return out;
      out[op++] = b;
    }
  }
  return op === outSize ? out : out.subarray(0, op);
}

// One compressed sector: mask byte + data. Codecs run in StormLib's dcmp_table order (bzip2, PKWARE, zlib,
// Huffman, ADPCM stereo, ADPCM mono). Returns bytes, or a Promise when zlib is involved and `async` is set.
const SECTOR_STEPS = [0x10, 0x08, 0x02, 0x01, 0x80, 0x40];
export function decompressSector(data, usize, async = false, name = '') {
  const mask = data[0];
  if ((mask & ~0xdb) || mask === 0x12) throw new Error(`mpq: unsupported compression 0x${mask.toString(16)}${name ? ' in ' + name : ''}`);
  const run = (i, buf) => {
    for (; i < SECTOR_STEPS.length; i++) {
      const b = SECTOR_STEPS[i];
      if (!(mask & b)) continue;
      if (b === 0x02) {
        if (!async) throw new NeedAsync('zlib');
        const next = i + 1;
        return inflateZlib(buf).then(d => run(next, d.length > usize ? d.subarray(0, usize) : d));
      }
      buf = b === 0x10 ? bunzip2(buf, usize) : b === 0x08 ? explode(buf, usize) : b === 0x01 ? huffDecompress(buf, usize)
        : adpcmDecompress(buf, usize, b === 0x80 ? 2 : 1);
    }
    return buf;
  };
  return run(0, data.subarray(1));
}

async function inflateZlib(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('zlib sector but no DecompressionStream');
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

const F_IMPLODE = 0x100, F_COMPRESS = 0x200, F_ENCRYPTED = 0x10000, F_FIX_KEY = 0x20000,
  F_SINGLE = 0x1000000, F_CRC = 0x4000000, F_EXISTS = 0x80000000;

class NeedAsync extends Error {}

export class MpqArchive {
  constructor(bytes) {
    // plain Uint8Array view (a node Buffer's slice() would not copy)
    this.b = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
    const dv = this.dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
    let base = -1;
    for (let o = 0; o + 32 <= this.b.length; o += 512) {
      const m = dv.getUint32(o, true);
      if (m === 0x1a51504d) { base = o; break; }           // 'MPQ\x1a'
      if (m === 0x1b51504d) { base = o + dv.getUint32(o + 8, true); break; }   // user data -> header offset
    }
    if (base < 0 || dv.getUint32(base, true) !== 0x1a51504d) throw new Error('not an MPQ archive');
    this.base = base;
    this.sectorSize = 512 << dv.getUint16(base + 14, true);
    const htPos = dv.getUint32(base + 16, true), btPos = dv.getUint32(base + 20, true);
    const htN = dv.getUint32(base + 24, true), btN = dv.getUint32(base + 28, true);
    const ht = this.b.slice(base + htPos, base + htPos + 16 * htN); decrypt(ht, hashString('(hash table)', 3));
    const bt = this.b.slice(base + btPos, base + btPos + 16 * btN); decrypt(bt, hashString('(block table)', 3));
    this.ht = new Uint32Array(ht.buffer); this.htN = htN;
    this.bt = new Uint32Array(bt.buffer); this.btN = btN;
  }
  // Block index of a name, or -1. Prefers the neutral locale (0) over the others.
  find(name) {
    const i0 = hashString(name, 0) % this.htN, a = hashString(name, 1), b = hashString(name, 2);
    let best = -1;
    for (let k = 0, i = i0; k < this.htN; k++, i = (i + 1) % this.htN) {
      const h = 4 * i, blk = this.ht[h + 3];
      if (blk === 0xffffffff) break;
      if (blk === 0xfffffffe) continue;
      if (this.ht[h] === a && this.ht[h + 1] === b && blk < this.btN) {
        const locale = this.ht[h + 2] & 0xffff;
        if (locale === 0) return blk;
        if (best < 0) best = blk;
      }
    }
    return best;
  }
  has(name) { const k = this.find(name); return k >= 0 && (this.bt[4 * k + 3] & F_EXISTS) !== 0; }
  size(name) { const k = this.find(name); return k >= 0 ? this.bt[4 * k + 2] : -1; }
  flags(name) { const k = this.find(name); return k >= 0 ? this.bt[4 * k + 3] >>> 0 : 0; }
  read(name) { return this._read(name, false); }
  async readAsync(name) {
    try { return this._read(name, false); } catch (e) { if (!(e instanceof NeedAsync)) throw e; }
    return this._read(name, true);   // returns a Promise
  }
  _read(name, async) {
    const k = this.find(name);
    if (k < 0) return null;
    const pos = this.bt[4 * k], csize = this.bt[4 * k + 1], fsize = this.bt[4 * k + 2], flags = this.bt[4 * k + 3] >>> 0;
    if (!(flags & F_EXISTS)) return null;
    const off = this.base + pos;
    let key = 0;
    if (flags & F_ENCRYPTED) {
      key = hashString(name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1), 3);
      if (flags & F_FIX_KEY) key = ((key + pos) ^ fsize) >>> 0;
    }
    const compressed = (flags & (F_IMPLODE | F_COMPRESS)) !== 0;
    const pending = [];
    const unpack = (data, usize, idx, out, at) => {   // one sector into out[at..]
      if (flags & F_ENCRYPTED) decrypt(data, (key + idx) >>> 0);
      if (!compressed || data.length === usize) { out.set(data.subarray(0, usize), at); return; }
      if (flags & F_IMPLODE) { out.set(explode(data, usize), at); return; }
      const r = decompressSector(data, usize, async, name);
      if (r instanceof Promise) pending.push(r.then(d => out.set(d.length > usize ? d.subarray(0, usize) : d, at)));
      else out.set(r.length > usize ? r.subarray(0, usize) : r, at);
    };
    const out = new Uint8Array(fsize);
    if (flags & F_SINGLE) {
      unpack(this.b.slice(off, off + csize), fsize, 0, out, 0);
    } else {
      const ss = this.sectorSize, ns = Math.ceil(fsize / ss);
      if (!compressed) {
        for (let s = 0; s < ns; s++) {
          const n = Math.min(ss, fsize - s * ss);
          unpack(this.b.slice(off + s * ss, off + s * ss + n), n, s, out, s * ss);
        }
      } else {
        const nt = ns + 1 + ((flags & F_CRC) ? 1 : 0);
        const tab = this.b.slice(off, off + 4 * nt);
        if (flags & F_ENCRYPTED) decrypt(tab, (key - 1) >>> 0);
        const t = new DataView(tab.buffer);
        for (let s = 0; s < ns; s++) {
          const a = t.getUint32(4 * s, true), b = t.getUint32(4 * s + 4, true);
          unpack(this.b.slice(off + a, off + b), Math.min(ss, fsize - s * ss), s, out, s * ss);
        }
      }
    }
    if (pending.length) return Promise.all(pending).then(() => out);
    return async ? Promise.resolve(out) : out;
  }
  listfile() {
    const d = this.has('(listfile)') ? this.read('(listfile)') : null;
    if (!d) return [];
    return new TextDecoder('latin1').decode(d).split(/[\r\n;]+/).map(s => s.trim()).filter(Boolean);
  }
}

// Several archives searched in order: pass [War2Patch, War2Dat] so patch files override dat files.
export class MpqSet {
  constructor(archives) { this.archives = archives.filter(Boolean); }
  has(name) { return this.archives.some(a => a.has(name)); }
  read(name) { for (const a of this.archives) if (a.has(name)) return a.read(name); return null; }
  async readAsync(name) { for (const a of this.archives) if (a.has(name)) return a.readAsync(name); return null; }
  listfile() { const s = new Set(); for (const a of this.archives) for (const n of a.listfile()) s.add(n); return [...s]; }
}
