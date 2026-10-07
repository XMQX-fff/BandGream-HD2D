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
  NearestFilter,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  CanvasTexture
} from 'three';

const cache = new Map();

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
/*  外部贴图加载 —— 已移除                                                  */
/* ------------------------------------------------------------------ */
/*
 * 这里原本有三组基于「下载的外部贴图文件」的加载器：
 *
 *   loadPixel(name)          → assets/retro/<name>.png     （Kenney Retro, CC0）
 *   loadPhoto(name, _, map)  → assets/<name>_<map>_512.jpg （Poly Haven, CC0）
 *   loadColor / loadNormal / loadRough  → loadPixel 的别名
 *   makePixelTexture(tex)     → 手工配置纹理采样器
 *
 * 全部删除，理由是逐项核对后确认从未被调用：
 *   - loadPixel：scene.js 里有一行 `import { loadPixel }`，但没有任何调用点。
 *     只看 import 会误以为「在用」，实际是遗留的未使用导入。
 *   - loadPhoto / loadColor / loadNormal / loadRough / makePixelTexture：零引用。
 *   - vite 构建产物里不含这些函数，tree-shaking 早就剔除了它们 ——
 *     属于纯死代码，留在源码里只会误导后来的人。
 *
 * 随之删除的资源文件（共 27 个）：
 *   public/assets/retro/*.png                15 个（无任何代码引用）
 *   public/assets/*_diff_512.jpg 等12 个      （只被 loadPhoto 引用）
 *
 * 画面中所有贴图都由 hd2dTextures.js 用 Canvas 程序化生成
 * （见 initHD2D / HD2D.tex），不依赖任何外部图片 ——
 * 这也是本项目仅靠约 661KB 的 JS 产物就能完整运行的原因。
 */
