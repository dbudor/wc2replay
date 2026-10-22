// Tiny x86-32 interpreter for the game's command-button predicates (presentation only).
//
// The button tables at 0x4a3998 (Ui_UpdateCommandButtons 0x44b890) gate every button with a predicate in
// 0x443dd0..0x445230 ("is the next weapon upgrade level n?", "may this building train X?", ...). They are
// tiny leaf functions over globals (g_LocalPlayer 0x4acb18, g_UiSelPrimary 0x4bdc78, g_UiSelection 0x4bdca0,
// g_UiSelCount 0x4bdc90 and per-player tables) written with ~20 opcodes: mov/xor/test/cmp/jcc/setcc/and/shl/
// add/sub/not/dec/push/pop/ret. Rather than re-typing 60 of them, the viewer runs the original bytes (they
// are in the arena: the exe image is loaded at its own addresses) against the arena READ-ONLY, with an
// overlay that substitutes the UI globals of the viewed player. Any write outside the private stack, any
// call into a function that writes, or an unknown opcode aborts the run (result null = "unknown").

const STACK_TOP = 0x7ff00000;
const RET_MAGIC = 0x7fe0dead;

export class X86Abort extends Error {}

// mem: { r8(addr) } (arena reader); overlay: Map addr -> byte for the substituted globals.
export function runPredicate(mem, fn, args = [], overlay = new Map(), maxSteps = 2000) {
  const R = new Uint32Array(8);            // eax ecx edx ebx esp ebp esi edi
  const stack = new Map();                 // private stack bytes
  let eip = fn >>> 0, zf = 0, sf = 0, cf = 0, of = 0;
  R[4] = STACK_TOP;
  const rd8 = a => {
    a >>>= 0;
    if (a >= STACK_TOP - 0x10000 && a < STACK_TOP + 0x100) return stack.get(a) || 0;
    if (overlay.has(a)) return overlay.get(a);
    return mem.r8(a);
  };
  const wr8 = (a, v) => {
    a >>>= 0;
    if (a >= STACK_TOP - 0x10000 && a < STACK_TOP + 0x100) { stack.set(a, v & 0xff); return; }
    throw new X86Abort(`write to ${a.toString(16)}`);
  };
  const rdN = (a, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = (v * 256) + rd8(a + i); return v >>> 0; };
  const wrN = (a, n, v) => { for (let i = 0; i < n; i++) wr8(a + i, (v >>> (8 * i)) & 0xff); };
  const push = v => { R[4] -= 4; wrN(R[4], 4, v); };
  const pop = () => { const v = rdN(R[4], 4); R[4] += 4; return v; };
  for (let i = args.length - 1; i >= 0; i--) push(args[i] >>> 0);
  push(RET_MAGIC);

  const fetch8 = () => rd8(eip++);
  const fetch16 = () => { const v = rdN(eip, 2); eip += 2; return v; };
  const fetch32 = () => { const v = rdN(eip, 4); eip += 4; return v; };
  const s8 = v => (v << 24) >> 24;
  // registers by size: 1 -> al cl dl bl ah ch dh bh, 2 -> ax.., 4 -> eax..
  const getReg = (r, n) => n === 4 ? R[r] : n === 2 ? R[r] & 0xffff : r < 4 ? R[r] & 0xff : (R[r - 4] >>> 8) & 0xff;
  const setReg = (r, n, v) => {
    if (n === 4) R[r] = v >>> 0;
    else if (n === 2) R[r] = ((R[r] & 0xffff0000) | (v & 0xffff)) >>> 0;
    else if (r < 4) R[r] = ((R[r] & 0xffffff00) | (v & 0xff)) >>> 0;
    else R[r - 4] = ((R[r - 4] & 0xffff00ff) | ((v & 0xff) << 8)) >>> 0;
  };
  // ModRM -> { reg, loc } where loc = { r } (register) or { a } (memory address)
  const modrm = () => {
    const b = fetch8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    if (mod === 3) return { reg, loc: { r: rm } };
    let a;
    if (rm === 4) {
      const sib = fetch8(), sc = 1 << (sib >> 6), idx = (sib >> 3) & 7, base = sib & 7;
      a = idx === 4 ? 0 : R[idx] * sc;
      if (base === 5 && mod === 0) a += fetch32(); else a += R[base];
    } else if (rm === 5 && mod === 0) a = fetch32();
    else a = R[rm];
    if (mod === 1) a += s8(fetch8()); else if (mod === 2) a += fetch32() | 0;
    return { reg, loc: { a: a >>> 0 } };
  };
  const get = (loc, n) => loc.r !== undefined ? getReg(loc.r, n) : rdN(loc.a, n);
  const set = (loc, n, v) => { if (loc.r !== undefined) setReg(loc.r, n, v); else wrN(loc.a, n, v); };
  const mask = n => n === 4 ? 0xffffffff : n === 2 ? 0xffff : 0xff;
  const sign = (v, n) => (v >>> (8 * n - 1)) & 1;
  const logic = (v, n) => { v = (v & mask(n)) >>> 0; zf = v === 0 ? 1 : 0; sf = sign(v, n); cf = 0; of = 0; return v; };
  const sub = (a, b, n) => {
    const m = mask(n), r = ((a - b) & m) >>> 0;
    zf = r === 0 ? 1 : 0; sf = sign(r, n); cf = (a >>> 0) < (b >>> 0) ? 1 : 0;
    of = (sign(a, n) !== sign(b, n) && sign(r, n) !== sign(a, n)) ? 1 : 0;
    return r;
  };
  const add = (a, b, n) => {
    const m = mask(n), r = ((a + b) & m) >>> 0;
    zf = r === 0 ? 1 : 0; sf = sign(r, n); cf = (a + b) > m ? 1 : 0;
    of = (sign(a, n) === sign(b, n) && sign(r, n) !== sign(a, n)) ? 1 : 0;
    return r;
  };
  const cond = c => {
    switch (c) {
      case 0: return of; case 1: return !of; case 2: return cf; case 3: return !cf;
      case 4: return zf; case 5: return !zf; case 6: return cf || zf; case 7: return !cf && !zf;
      case 8: return sf; case 9: return !sf; case 12: return sf !== of; case 13: return sf === of;
      case 14: return zf || sf !== of; case 15: return !zf && sf === of;
      default: throw new X86Abort('cond ' + c);
    }
  };
  // group-1 ALU: op 0 add, 1 or, 4 and, 5 sub, 6 xor, 7 cmp
  const alu = (op, a, b, n) => {
    switch (op) {
      case 0: return add(a, b, n);
      case 1: return logic(a | b, n);
      case 4: return logic(a & b, n);
      case 5: case 7: return sub(a, b, n);
      case 6: return logic(a ^ b, n);
      default: throw new X86Abort('alu ' + op);
    }
  };

  for (let steps = 0; steps < maxSteps; steps++) {
    if (eip === RET_MAGIC) return R[0];
    let n = 4, op = fetch8();
    if (op === 0x66) { n = 2; op = fetch8(); }
    const nb = (op & 1) ? n : 1;          // byte form for even opcodes of the classic ALU rows
    switch (op) {
      case 0x90: break;
      // ALU r/m, r and r, r/m: 00-3b
      case 0x00: case 0x01: case 0x02: case 0x03: case 0x08: case 0x09: case 0x0a: case 0x0b:
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x28: case 0x29: case 0x2a: case 0x2b:
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x38: case 0x39: case 0x3a: case 0x3b: {
        const g = op >> 3, dirReg = op & 2, { reg, loc } = modrm();
        const rv = getReg(reg, nb), mv = get(loc, nb);
        if (dirReg) { const r = alu(g, rv, mv, nb); if (g !== 7) setReg(reg, nb, r); }
        else { const r = alu(g, mv, rv, nb); if (g !== 7) set(loc, nb, r); }
        break;
      }
      case 0x04: case 0x0c: case 0x24: case 0x2c: case 0x34: case 0x3c: { const r = alu(op >> 3, getReg(0, 1), fetch8(), 1); if ((op >> 3) !== 7) setReg(0, 1, r); break; }
      case 0x05: case 0x0d: case 0x25: case 0x2d: case 0x35: case 0x3d: { const iv = n === 4 ? fetch32() : fetch16(); const r = alu(op >> 3, getReg(0, n), iv, n); if ((op >> 3) !== 7) setReg(0, n, r); break; }
      case 0x80: case 0x81: case 0x83: {
        const sz = op === 0x80 ? 1 : n, { reg, loc } = modrm();
        const iv = op === 0x81 ? (n === 4 ? fetch32() : fetch16()) : (op === 0x83 ? s8(fetch8()) & mask(sz) : fetch8());
        const r = alu(reg, get(loc, sz), iv >>> 0, sz); if (reg !== 7) set(loc, sz, r);
        break;
      }
      case 0x84: case 0x85: { const { reg, loc } = modrm(); logic(get(loc, nb) & getReg(reg, nb), nb); break; }
      case 0xa8: logic(getReg(0, 1) & fetch8(), 1); break;
      case 0xa9: logic(getReg(0, n) & (n === 4 ? fetch32() : fetch16()), n); break;
      case 0x88: case 0x89: { const { reg, loc } = modrm(); set(loc, nb, getReg(reg, nb)); break; }
      case 0x8a: case 0x8b: { const { reg, loc } = modrm(); setReg(reg, nb, get(loc, nb)); break; }
      case 0x8d: { const { reg, loc } = modrm(); if (loc.a === undefined) throw new X86Abort('lea reg'); setReg(reg, n, loc.a); break; }
      case 0xa0: setReg(0, 1, rd8(fetch32())); break;
      case 0xa1: setReg(0, n, rdN(fetch32(), n)); break;
      case 0xa2: wrN(fetch32(), 1, getReg(0, 1)); break;
      case 0xa3: wrN(fetch32(), n, getReg(0, n)); break;
      case 0xc6: { const { loc } = modrm(); set(loc, 1, fetch8()); break; }
      case 0xc7: { const { loc } = modrm(); set(loc, n, n === 4 ? fetch32() : fetch16()); break; }
      case 0xf6: case 0xf7: {
        const sz = op === 0xf6 ? 1 : n, { reg, loc } = modrm();
        if (reg === 0) logic(get(loc, sz) & (sz === 1 ? fetch8() : sz === 2 ? fetch16() : fetch32()), sz);
        else if (reg === 2) set(loc, sz, ~get(loc, sz) & mask(sz));
        else if (reg === 3) set(loc, sz, sub(0, get(loc, sz), sz));
        else throw new X86Abort('f6/f7 /' + reg);
        break;
      }
      case 0xfe: case 0xff: {
        const sz = op === 0xfe ? 1 : n, { reg, loc } = modrm();
        if (reg === 0 || reg === 1) { const c0 = cf; set(loc, sz, reg ? sub(get(loc, sz), 1, sz) : add(get(loc, sz), 1, sz)); cf = c0; }
        else if (reg === 6 && sz !== 1) push(get(loc, 4));
        else throw new X86Abort('fe/ff /' + reg);
        break;
      }
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const sz = (op & 1) ? n : 1, { reg, loc } = modrm();
        const cnt = (op <= 0xc1 ? fetch8() : op <= 0xd1 ? 1 : getReg(1, 1)) & 31;
        let v = get(loc, sz);
        if (!cnt) break;
        if (reg === 4) { cf = (v >>> (8 * sz - cnt)) & 1; v = (v << cnt) & mask(sz); }
        else if (reg === 5) { cf = (v >>> (cnt - 1)) & 1; v = v >>> cnt; }
        else if (reg === 7) { const sv = sz === 4 ? v | 0 : sz === 2 ? (v << 16) >> 16 : (v << 24) >> 24; cf = (sv >> (cnt - 1)) & 1; v = (sv >> cnt) & mask(sz); }
        else throw new X86Abort('shift /' + reg);
        v >>>= 0; zf = v === 0 ? 1 : 0; sf = sign(v, sz); of = 0;
        set(loc, sz, v);
        break;
      }
      case 0x0f: {
        const op2 = fetch8();
        if (op2 >= 0x90 && op2 <= 0x9f) { const { loc } = modrm(); set(loc, 1, cond(op2 & 15) ? 1 : 0); }
        else if (op2 >= 0x80 && op2 <= 0x8f) { const d = fetch32() | 0; if (cond(op2 & 15)) eip = (eip + d) >>> 0; }
        else if (op2 === 0xb6 || op2 === 0xb7) { const { reg, loc } = modrm(); setReg(reg, n, get(loc, op2 === 0xb6 ? 1 : 2)); }
        else if (op2 === 0xbe || op2 === 0xbf) { const { reg, loc } = modrm(); const v = get(loc, op2 === 0xbe ? 1 : 2); setReg(reg, n, op2 === 0xbe ? (v << 24) >> 24 : (v << 16) >> 16); }
        else throw new X86Abort('0f ' + op2.toString(16));
        break;
      }
      case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7c: case 0x7d: case 0x7e: case 0x7f: { const d = s8(fetch8()); if (cond(op & 15)) eip = (eip + d) >>> 0; break; }
      case 0xeb: { const d = s8(fetch8()); eip = (eip + d) >>> 0; break; }
      case 0xe9: { const d = fetch32() | 0; eip = (eip + d) >>> 0; break; }
      case 0xe8: { const d = fetch32() | 0; push(eip); eip = (eip + d) >>> 0; break; }
      case 0xc3: eip = pop(); break;
      case 0xc2: { const k = fetch16(); eip = pop(); R[4] += k; break; }
      case 0x6a: push(s8(fetch8()) >>> 0); break;
      case 0x68: push(fetch32()); break;
      default:
        if (op >= 0x50 && op <= 0x57) push(R[op - 0x50]);
        else if (op >= 0x58 && op <= 0x5f) R[op - 0x58] = pop();
        else if (op >= 0x40 && op <= 0x47) { const c0 = cf; setReg(op - 0x40, n, add(getReg(op - 0x40, n), 1, n)); cf = c0; }
        else if (op >= 0x48 && op <= 0x4f) { const c0 = cf; setReg(op - 0x48, n, sub(getReg(op - 0x48, n), 1, n)); cf = c0; }
        else if (op >= 0xb0 && op <= 0xb7) setReg(op - 0xb0, 1, fetch8());
        else if (op >= 0xb8 && op <= 0xbf) setReg(op - 0xb8, n, n === 4 ? fetch32() : fetch16());
        else throw new X86Abort(`opcode ${op.toString(16)} at ${(eip - 1).toString(16)}`);
    }
  }
  throw new X86Abort('step limit');
}

// Safe wrapper: the predicate's value, or null when it could not be evaluated.
export function tryPredicate(mem, fn, args, overlay) {
  try { return runPredicate(mem, fn, args, overlay); } catch (e) { if (e instanceof X86Abort) return null; throw e; }
}
