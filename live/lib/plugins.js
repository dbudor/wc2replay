// War2Combat plugin builds the sim knows (Peon2k: src/lift/mod_peon2k.c behind W2_PATCH_PEON2K_*; see viewer.js
// "War2Combat plugin rules"), told apart by the CRC-32 of the released .w2p files. Used by the viewer and by the
// live recorder (web/live/w2live.mjs), which hashes the game folder's plugin/*.w2p.
import { crc32 } from './pcap.js';

export const RULES = { 0: 'original rules', 0x100: 'Peon2k 0.2.2 rules', 0x200: 'Peon2k 0.2.3 rules', 0x500: 'Peon2k 0.2.2.1 rules',
  0xd00: 'Peon2k 0.2.2.1 vision rules', 0x600: 'Peon2k 0.2.3.1 rules', 0xe00: 'Peon2k 0.2.3.1 vision rules' };
export const PLUGIN_BUILDS = { 0xefea1697: 0x100, 0x86b57ae2: 0x200,   // CRC-32 of the released peon2k.w2p / peon2kvision.w2p files
  0x85197383: 0x500, 0xa95308f6: 0xd00, 0x5b73c898: 0x600, 0x4f1681a2: 0xe00 };
export function pluginInfo(bytes, name) {
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
