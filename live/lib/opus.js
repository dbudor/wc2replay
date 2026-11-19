// The viewer's Opus decoder (opus.wasm: libopus 1.5.2, fixed point; opus/build.sh) for CamRec audio packets of
// kind 7 (camrec.js). Loaded once (opusInit, before replays are decoded); then decoding is synchronous, like the
// ADPCM path. Without it (not loaded / failed) Opus audio decodes as silence and opusReady() is false.
let ex = null, inBuf = null, outBuf = null, failed = false;
export async function opusInit(bytes) {
  if (ex || failed) return !!ex;
  try {
    if (!bytes) bytes = await (await fetch(new URL('./opus.wasm', import.meta.url))).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    ex = instance.exports;
    if (ex.od_reset() !== 0) throw new Error('od_reset');
    inBuf = () => new Uint8Array(ex.memory.buffer, ex.od_in(), 1276);
    outBuf = n => new Int16Array(ex.memory.buffer, ex.od_out(), n);
  } catch (e) { ex = null; failed = true; console.warn('opus.wasm:', e); }
  return !!ex;
}
export const opusReady = () => !!ex;
// The one decoder: reset() before a stretch of speech, then decode(packet, out, off) per 20 ms packet
// (null / empty: a lost packet, concealed) -> samples written to out[off..] as -1..1 floats (320 for 20 ms).
export const opusDecoder = {
  reset() { if (ex) ex.od_reset(); },
  decode(pkt, out, off, frame = 320) {
    let n = -1;
    if (ex) {
      const len = pkt && pkt.length <= 1276 ? pkt.length : 0;
      if (len) inBuf().set(pkt);
      n = ex.od_decode(len);
    }
    if (n < 0) { out.fill(0, off, Math.min(out.length, off + frame)); return frame; }
    const s = outBuf(n), m = Math.min(n, out.length - off);
    for (let i = 0; i < m; i++) out[off + i] = s[i] / 32768;
    return n;
  },
};
