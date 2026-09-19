/**
 * 极简 PNG 像素读取（零依赖）——用于「断言真实渲染颜色」，而不是只信计算样式。
 *
 * 为什么需要它：DOM/计算样式与**实际画出来的像素**会不一致（层叠、覆盖、_float 层、
 * 未重绘的旧帧），历史上这个项目就是靠截图才发现「面板透明」这类 bug。
 * 这里把 PNG 拆成真像素，让 E2E 能直接断言 rgb()。
 *
 * 支持：8bit、colorType 2(RGB) / 6(RGBA) —— CDP Page.captureScreenshot 的输出就是这两种。
 *
 * 用法：
 *   import { pixelAt } from './png-pixel.mjs';
 *   const { r, g, b } = pixelAt(fs.readFileSync('shot.png'), 700, 400);
 *   命令行：node tools/png-pixel.mjs shot.png 700 400
 */
import zlib from 'node:zlib';

function parse(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9];
      if (depth !== 8) throw new Error('只支持 8bit 深度，当前 ' + depth);
      if (ctype !== 2 && ctype !== 6) throw new Error('只支持 RGB/RGBA，当前 colorType ' + ctype);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;               // len + type(4) + data + crc(4)
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;      // 左
      const b = prev[x];                          // 上
      const c = x >= bpp ? prev[x - bpp] : 0;     // 左上
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, data: out };
}

const cache = new WeakMap();
function img(buf) {
  let i = cache.get(buf);
  if (!i) { i = parse(buf); cache.set(buf, i); }
  return i;
}

export function pixelAt(buf, x, y) {
  const { w, h, bpp, data } = img(buf);
  if (x < 0 || y < 0 || x >= w || y >= h) throw new Error(`坐标越界 ${x},${y}（图 ${w}×${h}）`);
  const o = (y * w + x) * bpp;
  return { r: data[o], g: data[o + 1], b: data[o + 2], a: bpp === 4 ? data[o + 3] : 255, w, h };
}

export const sizeOf = buf => { const { w, h } = img(buf); return { w, h }; };
/** 感知亮度，便于判断"深浅" */
export const lumAt = (buf, x, y) => { const p = pixelAt(buf, x, y); return +(0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b).toFixed(1); };

/* 某些点可能压到卡片封面等元素上 —— 取一小片区域的**众数颜色**更稳 */
export function modeColor(buf, x0, y0, x1, y1) {
  const m = new Map();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const p = pixelAt(buf, x, y);
    const k = `${p.r},${p.g},${p.b}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  let best = null, n = -1;
  for (const [k, c] of m) if (c > n) { n = c; best = k; }
  const [r, g, b] = best.split(',').map(Number);
  return { r, g, b, count: n, ratio: +(n / ((x1 - x0 + 1) * (y1 - y0 + 1))).toFixed(2) };
}

if (process.argv[1] && process.argv[1].endsWith('png-pixel.mjs')) {
  const [file, x, y] = process.argv.slice(2);
  const buf = (await import('node:fs')).readFileSync(file);
  console.log(JSON.stringify({ size: sizeOf(buf), at: [+x, +y], pixel: pixelAt(buf, +x || 0, +y || 0) }));
}
