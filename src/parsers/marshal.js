/* =========================================================================
   Ruby Marshal 读写器
   RPG Maker XP 的 .rxdata、VX / VX Ace 的 .rvdata 都是 Ruby Marshal 格式。
   支持：nil / true / false / Fixnum / Float / String / Symbol / Array /
        Hash / Object(ivar) / UserDef(Table、Color、Tone 等)
   特点：读出来 → 改 → 写回去，字节级一致（本工具改写数据文件时靠它兜底）。
   ========================================================================= */

/* ---------------------------------------------------------------- 读取 */

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
    this.symbols = [];
    this.objects = [];          // Marshal 对象引用表（'@' 指向它）
    this.trace = null;          // 设成数组就会记录每个 read() 的起始偏移
  }
  u8() { return this.b[this.p++]; }
  bytes(n) { const s = this.b.slice(this.p, this.p + n); this.p += n; return s; }
  // Marshal 的可变长整数
  long() {
    let c = this.u8();
    if (c === 0) return 0;
    if (c > 127) c -= 256;                       // 有符号
    if (c > 4) return c - 5;
    if (c < -4) return c + 5;
    let x = 0, i;
    if (c > 0) {
      for (i = 0; i < c; i++) x |= this.u8() << (8 * i);
      return x >>> 0;
    }
    x = -1;
    for (i = 0; i < -c; i++) {
      x &= ~(0xff << (8 * i));
      x |= this.u8() << (8 * i);
    }
    return x;
  }
  sym() {
    // 直接调用时前面可能还带着 ':' 类型字节，先吃掉
    if (this.b[this.p] === 0x3a) this.p++;
    if (this.b[this.p] === 0x3b) {               // ';' 符号链接表
      this.p++;
      const idx = this.long();
      if (this.trace) this.trace.push({ op: 'symlink', at: this.p, v: idx });
      return this.symbols[idx];
    }
    const at = this.p;
    const len = this.long();
    const name = this.bytes(len).toString('latin1');
    this.symbols.push(name);
    if (this.trace) this.trace.push({ op: 'sym', at, len, name });
    return name;
  }
  read() {
    if (this.trace) this.trace.push({ op: 'read', at: this.p });
    const t = this.u8();
    switch (String.fromCharCode(t)) {
      case '0': return null;
      case 'T': return true;
      case 'F': return false;
      case 'i': return this.long();
      case '@': {
        const idx = this.long();
        return this.objects[idx];
      }
      case ':': return { __sym: this.sym() };
      case '"': {
        const n = this.long();
        const s = { __str: this.bytes(n) };
        this.objects.push(s);
        return s;
      }
      case '[': {
        const n = this.long();
        const a = { __arr: [] };
        this.objects.push(a);
        for (let i = 0; i < n; i++) a.__arr.push(this.read());
        return a;
      }
      case '{': {
        const n = this.long();
        const h = { __hash: [] };
        this.objects.push(h);
        for (let i = 0; i < n; i++) {
          const k = this.read(), v = this.read();
          h.__hash.push([k, v]);
        }
        return h;
      }
      case 'o': {
        const cls = this.sym();
        const n = this.long();
        const o = { __obj: cls, __iv: [] };
        this.objects.push(o);
        for (let i = 0; i < n; i++) {
          const k = this.sym();
          o.__iv.push([k, this.read()]);
        }
        return o;
      }
      case 'I': {
        const holder = { __ivar: null, __iv: [] };
        this.objects.push(holder);
        holder.__ivar = this.read();
        const n = this.long();
        for (let i = 0; i < n; i++) {
          const k = this.sym();
          holder.__iv.push([k, this.read()]);
        }
        return holder;
      }
      case 'u': {
        const cls = this.sym();
        const n = this.long();
        const u = { __user: cls, __data: this.bytes(n) };
        this.objects.push(u);
        return u;
      }
      case 'f': {
        const n = this.long();
        const f = { __float: parseFloat(this.bytes(n).toString('latin1')) };
        this.objects.push(f);
        return f;
      }
      case 'l': {
        const sign = String.fromCharCode(this.u8());
        const n = this.long();
        const words = [];
        for (let i = 0; i < n; i++) words.push(this.u16le());
        const b = { __big: (sign === '-' ? '-' : '') + words.map(w => w.toString(16)).join(''), __words: words, __sign: sign };
        this.objects.push(b);
        return b;
      }
      case 'C': {
        const cls = this.sym();
        const holder = { __sub: cls, __value: null };
        this.objects.push(holder);
        holder.__value = this.read();
        return holder;
      }
      case 'e': {
        const cls = this.sym();
        const holder = { __ext: cls, __value: null };
        this.objects.push(holder);
        holder.__value = this.read();
        return holder;
      }
      default:
        throw new Error('不认识的 Marshal 类型 0x' + t.toString(16) + ' @' + (this.p - 1));
    }
  }
  u16le() { const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
}

/* ---------------------------------------------------------------- 写出 */

class Writer {
  constructor() { this.parts = []; this.symbols = []; this.objects = new Map(); this.order = 0; }
  push(b) { this.parts.push(Buffer.isBuffer(b) ? b : Buffer.from([b])); }
  long(v) {
    if (v === 0) return this.push(0);
    if (v > 0 && v < 123) return this.push(v + 5);
    if (v < 0 && v > -124) return this.push(256 + (v - 5));
    // 正数：最短的无符号字节数；负数：最短的有符号（补码）字节数
    let n = 1;
    if (v > 0) {
      while (v >= Math.pow(2, 8 * n)) n++;
    } else {
      while (v < -Math.pow(2, 8 * n)) n++;
    }
    const bytes = [];
    for (let i = 0; i < n; i++) {
      bytes.push((v >> (8 * i)) & 0xff);
    }
    this.push(v < 0 ? (256 - n) : n);
    this.push(Buffer.from(bytes));
  }
  sym(name) {
    const idx = this.symbols.indexOf(name);
    if (idx >= 0) { this.push(0x3b); this.long(idx); return; }
    this.symbols.push(name);
    this.push(0x3a);
    const b = Buffer.from(name, 'latin1');
    this.long(b.length);
    this.push(b);
  }
  write(o) {
    if (o === null || o === undefined) { this.push(0x30); return; }
    if (o === true) { this.push(0x54); return; }
    if (o === false) { this.push(0x46); return; }
    if (typeof o === 'number') {
      if (Number.isInteger(o)) { this.push(0x69); this.long(o); }
      else {
        const s = Buffer.from(String(o), 'latin1');
        this.push(0x66); this.long(s.length); this.push(s);
      }
      return;
    }
    // 非立即对象：先查引用表
    if (this.objects.has(o)) {
      this.push(0x40);
      this.long(this.objects.get(o));
      return;
    }
    this.objects.set(o, this.order++);
    if (Buffer.isBuffer(o)) { this.push(0x22); this.long(o.length); this.push(o); return; }
    if (o.__sym !== undefined) { this.push(0x3a); const b = Buffer.from(o.__sym, 'latin1'); this.long(b.length); this.push(b); return; }
    if (o.__str !== undefined) { this.push(0x22); this.long(o.__str.length); this.push(o.__str); return; }
    if (o.__float !== undefined) { const s = Buffer.from(String(o.__float), 'latin1'); this.push(0x66); this.long(s.length); this.push(s); return; }
    if (o.__big !== undefined) {
      this.push(0x6c);
      this.push(o.__sign === '-' ? 0x2d : 0x2b);
      const words = o.__words || [];
      this.long(words.length);
      for (const w of words) { this.push(w & 0xff); this.push((w >> 8) & 0xff); }
      return;
    }
    if (o.__arr) {
      this.push(0x5b); this.long(o.__arr.length);
      for (const x of o.__arr) this.write(x);
      return;
    }
    if (o.__hash) {
      this.push(0x7b); this.long(o.__hash.length);
      for (const [k, v] of o.__hash) { this.write(k); this.write(v); }
      return;
    }
    if (o.__obj !== undefined) {
      this.push(0x6f); this.sym(o.__obj); this.long(o.__iv.length);
      for (const [k, v] of o.__iv) { this.sym(k); this.write(v); }
      return;
    }
    if (o.__ivar !== undefined) {
      this.push(0x49); this.write(o.__ivar); this.long(o.__iv.length);
      for (const [k, v] of o.__iv) { this.sym(k); this.write(v); }
      return;
    }
    if (o.__user !== undefined) {
      this.push(0x75); this.sym(o.__user); this.long(o.__data.length); this.push(o.__data);
      return;
    }
    if (o.__sub !== undefined) { this.push(0x43); this.sym(o.__sub); this.write(o.__value); return; }
    if (o.__ext !== undefined) { this.push(0x65); this.sym(o.__ext); this.write(o.__value); return; }
    throw new Error('无法序列化的对象: ' + JSON.stringify(o).slice(0, 80));
  }
  toBuffer() { return Buffer.concat(this.parts); }
}

/* ------------------------------------------------------------ 顶层接口 */

function load(buf) {
  const r = new Reader(buf);
  const major = r.u8(), minor = r.u8();
  if (major !== 4) throw new Error('不是 Marshal 4.x 格式: ' + major + '.' + minor);
  return r.read();
}

function dump(obj) {
  const w = new Writer();
  w.push(4); w.push(8);
  w.write(obj);
  return w.toBuffer();
}

/* --------------------------------------------------- RGSS 内建类型帮助函数 */

// Table：20 字节头（dim,xsize,ysize,zsize,size，各 int32 LE）+ size 个 int16
function tableParse(user) {
  const d = user.__data;
  const dim = d.readInt32LE(0), x = d.readInt32LE(4), y = d.readInt32LE(8), z = d.readInt32LE(12), size = d.readInt32LE(16);
  const data = new Int16Array(size);
  for (let i = 0; i < size; i++) data[i] = d.readInt16LE(20 + i * 2);
  return { dim, x, y, z, size, data };
}

function tableBuild(t) {
  if (t.size === undefined) t = { ...t, size: t.x * (t.y || 1) * (t.z || 1) };
  const head = Buffer.alloc(20);
  head.writeInt32LE(t.dim, 0); head.writeInt32LE(t.x, 4); head.writeInt32LE(t.y, 8);
  head.writeInt32LE(t.z, 12); head.writeInt32LE(t.size, 16);
  const body = Buffer.alloc(t.size * 2);
  for (let i = 0; i < t.size; i++) body.writeInt16LE(t.data[i], i * 2);
  return { __user: 'Table', __data: Buffer.concat([head, body]) };
}

// Color / Tone：都是 4 个 double（小端）
function doublesParse(user) {
  const d = user.__data, out = [];
  for (let i = 0; i + 8 <= d.length; i += 8) out.push(d.readDoubleLE(i));
  return out;
}
function doublesBuild(cls, arr) {
  const b = Buffer.alloc(arr.length * 8);
  arr.forEach((v, i) => b.writeDoubleLE(v, i * 8));
  return { __user: cls, __data: b };
}

/* --------------------------------------------------------- 便捷访问器 */

const sym = (name) => ({ __sym: name });
const str = (text) => ({ __str: Buffer.from(text, 'utf8') });

function getIv(obj, name) {
  if (!obj || !obj.__iv) return undefined;
  for (const [k, v] of obj.__iv) if (k === name) return v;
  return undefined;
}
function setIv(obj, name, value) {
  for (const pair of obj.__iv) if (pair[0] === name) { pair[1] = value; return; }
  obj.__iv.push([name, value]);
}
function strVal(o) { return o && o.__str ? o.__str.toString('utf8') : ''; }

export {
  load, dump, Reader, Writer,
  tableParse, tableBuild, doublesParse, doublesBuild,
  sym, str, getIv, setIv, strVal
};
