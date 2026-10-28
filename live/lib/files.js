// The game files the wasm sim may ask for, served from the user's MPQs. The VFS (sim/src/core/vfs.c) has a
// provider hook, but a wasm-side provider would need a synchronous JS import; instead the viewer preloads
// the complete set the boot can touch (verified by w2w_vfs_misses(): the sim logs every name it looked up
// and did not find):
//   - the boot set of web/extract.sh (rez tables, unitdata/upgrades, ai/script, the 4 tilesets' files)
//   - rez\fileflt2.tbl and every OrigMaps\Multi\*.pud (built-in maps; game1 = war8.pud, res id 0x4dd)
// Names are what the game passes to Storm (backslashes; the VFS is case-insensitive).

// Tileset file names are not hard-coded: tileset.js reads them from the game's descriptor table 0x496e04
// (0 Forest, 1 Iceland = winter, 2 Swamp = wasteland, 3 XSwamp = swamp).

export function bootFileNames(mpq) {
  const L = ['rez\\network.tbl', 'rez\\stat_txt.tbl', 'rez\\unitdata.dat', 'rez\\upgrades.dat', 'rez\\ai.bin', 'rez\\script.bin', 'rez\\fileflt2.tbl'];
  for (const [d, p] of [['forest', 'nf'], ['iceland', 'ni'], ['swamp', 'ns'], ['xswamp', 'nx']]) {
    for (const e of ['cv4', 'vr4', 'vx4', 'ppl']) L.push(`art\\bgs\\${d}\\${d}.${e}`);
    for (const e of ['rock', 'tree', 'wall']) L.push(`art\\bgs\\${d}\\${p}_${e}.bin`);
  }
  for (const n of mpq.listfile()) if (/^origmaps\\multi\\[^\\]+\.pud$/i.test(n)) L.push(n);
  return [...new Set(L)];
}
