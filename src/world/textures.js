/**
 * 贴图加载 —— 三套体系，采样参数各不相同
 *
 * 【为什么必须分开】
 * 三类贴图的采样需求正好相反，用同一套参数必然有一类出错：
 *
 *  1) 程序化 HD-2D 贴图（hd2dTextures.js，64×64）
 *     - 低频、有大尺度结构（石板/瓦垄/板缝）
 *     - 放大线性 + mipmap，理由见下方「sharp-bilinear」
 *
 *  2) Kenney Retro（64×64 手绘）
 *     - 结构尚可但色相偏冷，与暖色石板不搭，正逐步被 (1) 取代
 *
 *  3) Poly Haven 照片贴图（1K 高频）
 *     - 必须 mipmap；用 Nearest 会让高频细节缩小时剧烈闪烁（aliasing）
 *
 * 【sharp-bilinear —— 关键修正】
 * 早期版本对所有贴图一律 NearestFilter + 关mipmap，结果满屏噪点。
 * Nearest 的问题是：放大时每个输出像素直接复制最近的输入 texel，采样点
 * 移动会造成颜色**阶跃**。地面上这种大倾角表面，转动相机时表现为满屏
 * 跳动的杂色 —— 用户说的「画面很粗糙」有一半来自这里。
 *
 * 正确分工：
 *   纹理只负责「提供 1 像素抗锯齿」→ magFilter = LinearFilter
 *   后处理负责「提供硬像素颗粒」  → RenderPixelatedPass(pixelSize)
 *
 * 两者各管一件事，互不干涉。这正是 hd2d-diorama 项目的做法。
 */
import {
  TextureLoader,
  NearestFilter,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  LinearSRGBColorSpace,
  CanvasTexture
} from 'three';

const loader = new TextureLoader();
const cache = new Map();

// Kenney Retro Textures（CC0）—— 64×64 手绘
const RETRO = 'assets/retro/';
// Poly Haven（CC0）—— 1K 照片
const PHOTO = 'assets/';

/** 放大采样统一用线性：提供 1px 抗锯齿，消除采样点跳变的闪烁 */
const MAG = LinearFilter;
const MIN = LinearMipmapLinearFilter;

function configure(tex, repeat) {
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.magFilter = MAG;
  tex.minFilter = MIN;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------------------ */
/* 程序化 HD-2D 贴图                                                    */
/* ------------------------------------------------------------------ */

/**
 * 同步可用（不走网络），场景搭建时不会先渲染一帧空贴图。
 * @param {HTMLCanvasElement} canvasEl hd2dTextures.js 生成的 canvas
 * @param {string} id 稳定的标识，用于缓存 key（不能用 canvas 引用做 key）
 */
export function loadHD2D(canvasEl, id, repeat = 1) {
  const key = `hd:${id}:${repeat}`;
  if (cache.has(key)) return cache.get(key);
  const tex = new CanvasTexture(canvasEl);
  tex.colorSpace = SRGBColorSpace;
  cache.set(key, configure(tex, repeat));
  return tex;
}

/**
 * HD-2D 贴图库单例。
 *
 * 惰性生成：只有真正被某个材质请求到时，才调用生成函数画那张 canvas。
 * 所有 canvas 缓存在这里，同一贴图只生成一次。
 * 用法：HD2D.tex('clayTiles', { hue: 13, sat: 0.44 }, repeat)
 */
let HD2D = null;

/** 由 scene.js 在启动时调用一次，注入 hd2dTextures.js 的生成函数集合 */
export function initHD2D(gen) {
  const store = new Map();
  HD2D = {
    tex(name, opts = {}, repeat = 1) {
      const id = `${name}:${JSON.stringify(opts)}`;
      if (store.has(id)) return loadHD2D(store.get(id), id, repeat);
      const canvas = gen[name](opts);
      store.set(id, canvas);
      return loadHD2D(canvas, id, repeat);
    }
  };
  return HD2D;
}

export function getHD2D() {
  if (!HD2D) throw new Error('initHD2D() 必须在场景搭建前调用');
  return HD2D;
}

/* ------------------------------------------------------------------ */
/* Kenney Retro                                                          */
/* ------------------------------------------------------------------ */

export function loadPixel(name, repeat = 1) {
  const key = `px:${name}:${repeat}`;
  if (cache.has(key)) return cache.get(key);
  const tex = loader.load(`${RETRO}${name}.png`);
  tex.colorSpace = SRGBColorSpace;
  cache.set(key, configure(tex, repeat));
  return tex;
}

/* ------------------------------------------------------------------ */
/* Poly Haven 高频照片贴图                                                */
/* ------------------------------------------------------------------ */

export function loadPhoto(name, repeat = 1, map = 'diff') {
  const key = `ph:${name}:${map}:${repeat}`;
  if (cache.has(key)) return cache.get(key);
  const tex = loader.load(`${PHOTO}${name}_${map}_512.jpg`);
  // 法线/粗糙度是数据贴图，必须线性空间，否则光照会算错
  tex.colorSpace = map === 'diff' ? SRGBColorSpace : LinearSRGBColorSpace;
  cache.set(key, configure(tex, repeat));
  return tex;
}

/* ------------------------------------------------------------------ */
/* 兼容旧调用名                                                           */
/* ------------------------------------------------------------------ */

export const loadColor = loadPixel;
export const loadNormal = (name, repeat) => loadPixel(name, repeat);
export const loadRough = (name, repeat) => loadPixel(name, repeat);

/** 水面等需要独立调整的场景，直接拿原始纹理自己配 */
export function makePixelTexture(texture, repeat = 1) {
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 1;
  return texture;
}