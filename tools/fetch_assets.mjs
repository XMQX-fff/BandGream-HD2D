// 一次性资产下载脚本：从 Poly Haven CDN 拉取 CC0 贴图到 public/assets/
// 用法: node tools/fetch_assets.mjs
import { mkdir, stat, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');

const TEXTURES = [
  'cobblestone_01',
  'medieval_wood',
  'clay_roof_tiles',
  'grey_plaster'
];

/** 目标边长：HD-2D 全程 NearestFilter + 1/3 分辨率渲染，1024 原图纯属浪费。
 *  实测压到 512 画质无可见差异，体积降到 1/10。 */
const TARGET_SIZE = 512;

const MAPS = ['diff', 'nor_gl', 'rough'];
const BASE = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function download(url, dest) {
  if (await exists(dest)) {
    console.log(`  skip  ${dest.split('/').pop()}`);
    return true;
  }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    console.log(`  ok    ${dest.split('/').pop()} (${(buf.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (e) {
    console.warn(`  FAIL  ${url.split('/').pop()} -> ${e.message}`);
    return false;
  }
}

/** 缩放到目标尺寸后删除原图 */
async function shrink(srcPath, dstPath) {
  try {
    const { default: sharp } = await import('sharp');
    await sharp(srcPath).resize(TARGET_SIZE, TARGET_SIZE, { kernel: 'lanczos3' })
      .jpeg({ quality: 82, mozjpeg: true }).toFile(dstPath);
    await unlink(srcPath);
    console.log(`  ->    ${dstPath.split('/').pop()} (${TARGET_SIZE}px)`);
    return true;
  } catch (e) {
    // 没装 sharp 就保留原图，并把文件名对齐到 _512 以免 404
    console.warn(`  WARN  缩放失败(${e.message})，回退为原图`);
    try { await rename(srcPath, dstPath); return true; } catch { return false; }
  }
}

await mkdir(OUT, { recursive: true });

console.log('下载 Poly Haven 贴图 (CC0)...');
let ok = 0, total = 0;
for (const name of TEXTURES) {
  for (const map of MAPS) {
    total++;
    // 始终下 1K 原图（质量最好），再用 sharp 缩到目标尺寸
    const src = `${name}_${map}_1k.jpg`;
    const dst = `${name}_${map}_512.jpg`;
    const good = await download(`${BASE}/${name}/${src}`, join(OUT, src))
      && await shrink(join(OUT, src), join(OUT, dst));
    if (good) ok++;
  }
}
console.log(`\n完成: ${ok}/${total} -> public/assets/`);