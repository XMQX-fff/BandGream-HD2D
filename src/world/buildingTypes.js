/**
 * 建筑类型库 —— 城区多样化建筑的程序化装配
 * ============================================================================
 *
 * 【为什么需要这个文件】
 * 此前整座城区只有**一种**建筑（props.js 的 createHouse：灰泥墙盒子 +
 * 赭红陶瓦坡屋顶 + 木质角柱）。无论街区怎么排，玩家看到的永远是
 * 同一个剪影 —— 换句话说，房子有200 栋，但「种类」只有 1 种。
 * 沿街看过去读作「复制粘贴」，这正是「建筑太基础」的根因：
 * 不是数量不够，是**类型维度缺失**。
 *
 * ============================================================================
 *  设计依据：2 单位模块化网格
 * ============================================================================
 *
 * 本项目已经下载了 Quaternius 的 CC0 中世纪村庄 Megakit
 *（assets-source/3d-buildings/，176 个模块 / 11.8 万面，CC0 可商用）。
 * 逐个检视它的模块尺寸后发现一套严格的模数：
 *
 *   Wall_Plaster_Straight         2.00 宽 × 3.12 高 × 0.41 深
 *   Wall_Plaster_Door_Round       同上（门嵌在墙里）
 *   Wall_Plaster_Window_*         同上（窗嵌在墙里）
 *   Corner_Exterior_Wood          0.22 × 3.00 角柱
 *   Roof_RoundTiles_4x4           5.51 × 5.56（4×4 模数）
 *   Door_1_Flat1.12 × 2.13
 *
 * 即**墙以 2 单位为模数、层高 3.12**，这是欧洲中世纪城镇的真实营造模数
 * （1 模数 ≈ 1~1.2 米）。本文件不去引入 glTF 资产，理由有三：
 *
 *  1. **风格一致性**：Megakit 是 PBR 纯色材质 + 标准 UV，
 *     我们的场景是程序化 HD-2D 贴图 + 像素化后处理。
 *     两者混用会出现「一部分物体有贴图、一部分是纯色」的割裂感，
 *     在像素化之后尤其明显（贴图分辨率与像素网格不匹配）。
 *  2. **draw call**：2000 栋房子若每栋多个 mesh，合并前会炸掉帧率。
 *     而本文件生成的构件全部走共享材质池，mergeStatics 能压成几十个 mesh。
 *  3. **阻塞登记**：相机的视线避障依赖一份包围盒列表，
 *     引入外部 glTF 意味着这些模型也得逐个登记遮挡 —— 极易漏。
 *
 * 所以采取的路线是：**采纳它的模数与结构设计，用程序化方式实现**。
 * 这样风格 100% 统一、零额外带宽、遮挡登记照旧，
 * 同时建筑类型从 1 种扩展到 9 种。
 * （原始资产包保留在 assets-source/3d-buildings/ 供后续比对参考。）
 *
 * ============================================================================
 *  9 种建筑类型
 * ============================================================================
 *
 *   类型          特征                     尺寸（模数）
 *   ------------  -----------------------  ------------------
 *   cottage       小民居，1 层，坡屋顶       4×3
 *   townhouse     联排民居，2 层，带挑檐      4×4 / 6×4
 *   workshop      工坊，1 层宽体 + 烟囱+ 雨棚 6×4
 *   warehouse     仓库，砖石，长而矮，平顶     8×5
 *   tower         塔楼，3~4 层，锥顶           4×4
 *   chapel        小教堂，尖拱窗 + 钟楼       6×7
 *   marketStall   市集棚，木架 + 条纹顶棚4×3
 *   house_with_garden  带院墙的独栋           5×4
 *   shed          杂物棚，最小               3×2
 *
 * 每种都有**明确不同的剪影**，这是「多样」的核心 ——
 * 玩家在主街上一眼能说出「那边是教堂、这边是仓库」。
 *
 * ============================================================================
 *  遮挡登记（务必读）
 * ============================================================================
 *
 * 每个建筑工厂在 return 之前**必须**调declareBuildingSight()，
 * 登记它的高度与占地。这是 camera.js 视线避障的唯一数据来源，
 * 漏登记的后果是「相机认为视线通畅，实际被房子糊住」
 * （这个 bug 已经犯过两轮，见city.js 顶部的说明）。
 */

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Shape,
  ExtrudeGeometry,
  Mesh,
  Group,
  MeshStandardMaterial,
  MeshBasicMaterial
} from 'three';
import * as HD2D_GEN from './hd2dTextures.js';
import { initHD2D } from './textures.js';
import { createBlobShadow } from './props.js';

const HD2D = initHD2D(HD2D_GEN);

/* ================================================================== */
/*  模数常量 —— 与 Quaternius Megakit 对齐，改这里等于改它的规格        */
/* ================================================================== */

/**
 * 墙的模数宽度（世界单位）。
 *
 * 取 2.0 的依据：Megakit 的 Wall_Plaster_* 系列实测宽度恰为 2.00，
 * 且门(1.12)、窗(1.36/1.61)、角柱(0.22) 都是它的子模数。
 * 采用同一套模数，墙上门窗的位置才不会显得任意。
 */
export const MODULE = 2.0;

/**
 * 层高。Megakit 的墙高 3.12。
 * 之所以不取整3.0：3.12 略高于MODULE×1.5，两层楼才不会显得又矮又胖。
 */
export const STOREY = 3.12;

/** 墙厚。Megakit 的墙是 0.41（含内外两面）。这里取 0.34——比它薄，
 *  因为斜俯视下墙厚几乎不可见，薄一点能省三角面。 */
const WALL_T = 0.34;

/** 屋顶出挑：墙外多伸出多少。Megakit 的 Overhang_* 系列就是干这个的。 */
const EAVE = 0.5;

/* ================================================================== */
/*  材质池—— 与 city.js 同理，共享才能被 mergeStatics 合并                */
/* ================================================================== */

/**
 * 【为什么必须是共享材质，而不是每个建筑 new 一个】
 * optimize.js 的 mergeStatics 是**按材质对象分桶合并**的。
 * 材质不共享 → 永远落在「只有一个 mesh」的分支 → 一个构件一次 draw call。
 * 2000 栋 × 8 构件 = 16000 次绘制，帧率直接归零。
 *
 * 所以这里只准备固定的一小组材质，全城共用。
 * 代价是颜色变化受限——但 OT2 远景的色差本身就很微妙，
 * 靠「亮面/暗面」而非「本体色差」建立层次，这是它的典型画法。
 */

// ---------------------------------------------------------------------------
//  色板 —— 「多样」的最后一环
// ---------------------------------------------------------------------------
// 【为什么必须改这里，而不是接受「统一色调」】
// 第一版色板是 5 种浅色（0xfff4ec / 0xf8e6da / ...）配同一组贴图参数
// （hue 13、sat 0.44），渲出来**全是同一个赭红**——
// 5 个色位之间的差异小于人眼的分辨阈，于是 9 种建筑在画面上
// 只剩「都是红屋顶 + 都是米黄墙」。
//
// 数据上「9种类型全部出现」不等于画面上「看得出 9 种」：
// 截图实测印证了这一点 —— 剪影确实有差异（锥顶/钟楼/烟囱），
// 但整屏色调是单一的，读作「一个模子出来的房子」。
//
// 【配色依据：中世纪小镇的屋顶从来不是同一种瓦】
// 真实城镇的瓦来自不同窑口、不同批次，也有人用板岩、石板、
// 甚至草苫。所以色相要拉开，而不只是明度微调。
// 墙体同理：灰泥、裸石、抹白、木构各不相同。

// 墙体：6 种灰泥/裸石/木构色，跨度从冷灰到暖赭
const WALL_COLORS = [
  0xfaf4e8,  // 暖白灰泥
  0xf0e6d2,  // 米黄灰泥
  0xe6dcc8,  // 陈旧灰泥（略暗）
  0xdcd0bc,  // 冷灰石粉
  0xe8d8c0,  // 土黄抹墙
  0xf4ece0   // 新刷白灰
];
// 砖石墙体：4 种（仓库 / 教堂 / 塔楼用，比灰泥更沉、更冷）
const STONE_COLORS = [
  0xe8dcc6,  // 暖砂岩
  0xd8cbb4,  // 青灰石
  0xe0d2b8,  // 土黄石
  0xcfc4b0   // 旧石（最暗）
];
// 屋顶：6 种瓦/板岩色，**跨度必须大到肉眼可辨**
// 赭红陶瓦是主角，但不能只有它 —— 加上板岩灰、褪色瓦、暗棕瓦，
// 整片屋顶才有「不同批次」的质感。
const ROOF_COLORS = [
  0xd9714a,  // 主赭红陶瓦（OT2 常见的暖橙红）
  0xc25a3c,  // 深砖红瓦
  0xe08a5c,  // 褪色浅瓦
  0x7d8288,  // 板岩灰（冷色，与暖瓦强烈对比）
  0x9a8f84,  // 灰褐石板
  0x8a4a3a   // 暗棕瓦（老旧）
];
// 木构件
const WOOD_COLOR = 0xa8865c;

/**
 * 屋顶贴图参数表。
 *
 * 【关键：色相必须跟着色板走，不能写死】
 * 第一版 `roofMat` 里 hue 固定 13、sat 固定 0.44，
 * 于是 ROOF_COLORS 里那些色位全被拉回同一个赭红 ——
 * 色板改了等于没改。这里让 hue/sat/light 随色位一起变，
 * 保证「色板差异 → 画面差异」真正传导下去。
 */
const ROOF_TINTS = [
  { hue: 14, sat: 0.52, baseL: 0.46 },  // 赭红
  { hue: 10, sat: 0.48, baseL: 0.36 },  // 深砖红
  { hue: 22, sat: 0.38, baseL: 0.56 },  // 褪色浅瓦
  { hue: 210, sat: 0.06, baseL: 0.40 }, // 板岩灰（冷）
  { hue: 28, sat: 0.10, baseL: 0.38 },  // 灰褐石板
  { hue: 12, sat: 0.42, baseL: 0.30 }   // 暗棕瓦
];

const MATS = {};

function mat(key, genName, opts, repeat = 1, tint = 0xffffff) {
  const k = key + ':' + repeat + ':' + tint;
  if (MATS[k]) return MATS[k];
  const m = new MeshStandardMaterial({
    map: HD2D.tex(genName, opts, repeat),
    roughness: 0.94,
    metalness: 0.0
  });
  m.color.setHex(tint);
  MATS[k] = m;
  return m;
}

/**
 * 按 index 取一个共享墙材质（index 由调用方传入，保证确定性）。
 *
 * 【hue 也必须随色位走】与 roofMat 同理：
 * 第一版 hue 固定 36、sat 固定 0.09，把 4 个墙色全部拉成同一种米黄，
 * 于是「4 种灰泥色」实际上只有1 种。贴图参数与色板必须成对变化。
 */
function wallMat(i) {
  const n = WALL_COLORS.length;
  const k = ((i % n) + n) % n;
  // 三个色相带：暖白 / 土黄 / 冷灰，与色板的实际色相符
  const hues = [38, 30, 210, 28, 34, 40];
  const sats = [0.09, 0.13, 0.05, 0.10, 0.15, 0.07];
  return mat(`wall${k}`, 'plasterWall',
    { seed: 77 + k * 13, hue: hues[k], sat: sats[k], baseL: 0.85 },
    Math.max(1, Math.round(MODULE / 2)), WALL_COLORS[k]);
}

function stoneMat(i) {
  const n = STONE_COLORS.length;
  const k = ((i % n) + n) % n;
  const hues = [32, 205, 28, 34];
  const sats = [0.11, 0.06, 0.14, 0.08];
  const lights = [0.68, 0.60, 0.66, 0.56];
  return mat(`stone${k}`, 'stoneBlocks',
    { seed: 91 + k * 11, hue: hues[k], sat: sats[k], baseL: lights[k] },
    Math.max(1, Math.round(MODULE / 2)), STONE_COLORS[k]);
}

function roofMat(i) {
  // 【色相/饱和/明度随色位走】—— 见 ROOF_TINTS 的说明：
  // 固定 hue 会把所有色位拉回同一个赭红，色板改了等于没改。
  const n = ROOF_COLORS.length;
  const k = ((i % n) + n) % n;
  const t = ROOF_TINTS[k];
  return mat(`roof${k}`, 'clayTiles',
    { seed: 51 + k * 7, hue: t.hue, sat: t.sat, baseL: t.baseL },
    Math.max(3, Math.round(MODULE * 1.8)), ROOF_COLORS[k]);
}

function woodMat() {
  return mat('wood', 'woodPlanks', { seed: 63, hue: 28, sat: 0.30, baseL: 0.50 },
    1, WOOD_COLOR);
}

/** 深色构件：门、窗框、桁架 —— 用来在浅墙上读出「结构」 */
function darkMat() {
  return mat('dark', 'woodPlanks', { seed: 41, hue: 24, sat: 0.32, baseL: 0.32 },
    1, 0x8a7050);
}

/** 门扇：偏红木色，与深色窗框区分开 */
function doorMat() {
  return mat('door', 'woodPlanks', { seed: 52, hue: 20, sat: 0.36, baseL: 0.38 },
    1, 0xa8785a);
}

/** 窗玻璃：自发光，参与 bloom —— 夜景与黄昏的暖黄光源感 */
let glassMat = null;
function glass() {
  if (!glassMat) {
    glassMat = new MeshBasicMaterial({ color: 0xffd894, fog: true });
  }
  return glassMat;
}

/* ================================================================== */
/*  基础构件                                                            */
/* ================================================================== */

function box(w, h, d, m, x = 0, y = 0, z = 0) {
  const mesh = new Mesh(new BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 一面墙（含门或窗）。
 *
 * @param {number} span 墙的宽度（模数数× MODULE）
 * @param {number} h 墙高
 * @param {string} m 材质
 * @param {'none'|'door'|'window'|'arch'} opening 开口类型
 * @param {number} seed 决定开口位置
 */
function wallPanel(span, h, m, opening = 'none', seed = 0) {
  const g = new Group();
  g.add(box(span, h, WALL_T, m, 0, h / 2, 0));
  const dark = darkMat();

  if (opening === 'door') {
    // 门：偏心放置（seed 决定左右），避免每栋房子的门都在正中间
    const dx = ((seed % 3) - 1) * (span * 0.22);
    g.add(box(1.12, 2.13, 0.1, doorMat(), dx, 1.07, WALL_T / 2 + 0.03));
    // 门框与门楣
    g.add(box(1.36, 0.14, 0.14, dark, dx, 2.2, WALL_T / 2 + 0.04));
    g.add(box(0.12, 2.2, 0.14, dark, dx - 0.62, 1.1, WALL_T / 2 + 0.04));
    g.add(box(0.12, 2.2, 0.14, dark, dx + 0.62, 1.1, WALL_T / 2 + 0.04));
  } else if (opening === 'window') {
    // 窗：位置在层高偏上，符合真实比例
    const dy = h * 0.58;
    for (const sx of span > 4 ? [-span * 0.28, span * 0.28] : [0]) {
      g.add(box(1.3, 1.0, 0.06, glass(), sx, dy, WALL_T / 2 + 0.02));
      g.add(box(1.46, 0.12, 0.12, dark, sx, dy + 0.56, WALL_T / 2 + 0.04));
      g.add(box(1.46, 0.12, 0.12, dark, sx, dy - 0.56, WALL_T / 2 + 0.04));
      g.add(box(0.1, 1.24, 0.12, dark, sx, dy, WALL_T / 2 + 0.04));
      // 窗台：一条外挑的小檐，能在墙上投下影子
      g.add(box(1.6, 0.1, 0.22, m, sx, dy - 0.66, WALL_T / 2 + 0.08));
    }
  } else if (opening === 'arch') {
    // 尖拱窗：教堂专用。形状挤出而不是贴图—— 拱形是教堂最强的剪影特征。
    const shape = new Shape();
    shape.moveTo(-0.62, 0);
    shape.lineTo(0.62, 0);
    shape.lineTo(0.62, 0.9);
    shape.quadraticCurveTo(0.62, 1.5, 0, 1.86);
    shape.quadraticCurveTo(-0.62, 1.5, -0.62, 0.9);
    shape.closePath();
    const geo = new ExtrudeGeometry(shape, { depth: 0.06, bevelEnabled: false });
    const win = new Mesh(geo, glass());
    win.position.set(0, h * 0.42, WALL_T / 2 + 0.02);
    g.add(win);
    // 拱框
    const ring = new Shape();
    ring.moveTo(-0.78, 0);
    ring.lineTo(0.78, 0);
    ring.lineTo(0.78, 0.9);
    ring.quadraticCurveTo(0.78, 1.66, 0, 2.06);
    ring.quadraticCurveTo(-0.78, 1.66, -0.78, 0.9);
    ring.closePath();
    const hole = new Shape();
    hole.moveTo(-0.62, 0.05);
    hole.lineTo(0.62, 0.05);
    hole.lineTo(0.62, 0.9);
    hole.quadraticCurveTo(0.62, 1.5, 0, 1.86);
    hole.quadraticCurveTo(-0.62, 1.5, -0.62, 0.9);
    hole.closePath();
    ring.holes.push(hole);
    const ringGeo = new ExtrudeGeometry(ring, { depth: 0.1, bevelEnabled: false });
    const ringMesh = new Mesh(ringGeo, m);
    ringMesh.position.set(0, h * 0.42, WALL_T / 2 + 0.01);
    g.add(ringMesh);
  }
  return g;
}

/**
 * 坡屋顶（沿 X 走向的屋脊，向 ±Z 落坡）。
 *
 * 与 props.js 的createHouse 同样的构造，但**增加了出挑**与**山墙填充**，
 * 并且尺寸按模数走。
 */
function gableRoof(spanW, spanD, roofH, m, yBase) {
  const g = new Group();
  const slope = Math.atan2(roofH, spanD / 2);
  const len = Math.hypot(roofH, spanD / 2);
  const w = spanW + EAVE * 2;
  for (const s of [1, -1]) {
    const panel = new Mesh(new BoxGeometry(w, 0.26, len), m);
    panel.position.set(0, yBase + roofH / 2 - 0.08, (s * spanD) / 4);
    panel.rotation.x = s * slope;
    panel.castShadow = true;
    panel.receiveShadow = true;
    g.add(panel);
  }
  // 屋脊
  g.add(box(w + 0.24, 0.28, 0.4, m, 0, yBase + roofH - 0.06, 0));
  return g;
}

/** 山墙三角：填满屋顶下那块三角空间，否则侧面看是空壳 */
function gableTri(spanW, spanD, roofH, m, yBase) {
  const shape = new Shape();
  shape.moveTo(-spanD / 2, 0);
  shape.lineTo(spanD / 2, 0);
  shape.lineTo(0, roofH);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: false });
  geo.rotateY(Math.PI / 2);
  geo.rotateZ(Math.PI / 2);
  const out = new Group();
  for (const s of [-1, 1]) {
    const mesh = new Mesh(geo, m);
    mesh.position.set((s * (spanW - 0.16)) / 2, yBase - 0.08, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/** 角柱：木构架的竖向构件，四个角各一根 */
function cornerPosts(spanW, spanD, h, m) {
  const g = new Group();
  const p = 0.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(p, h, p, m, (sx * (spanW - p)) / 2, h / 2, (sz * (spanD - p)) / 2));
    }
  }
  return g;
}

/** 烟囱：石砌，顶部略外挑 */
function chimney(x, y, z, m, h = 1.6) {
  const g = new Group();
  g.add(box(0.72, h, 0.72, m, x, y + h / 2, z));
  g.add(box(0.92, 0.16, 0.92, m, x, y + h + 0.08, z));
  return g;
}

/* ================================================================== */
/*  遮挡登记                                                            */
/* ================================================================== */

/**
 * 建筑遮挡物登记表（与 city.js 的 BLOCKERS 合并成同一份）。
 *
 * 为什么不直接 import city.js 的 registerBlocker：
 * 那是个模块级私有函数+ 私有数组，导出会造成循环依赖
 * （city.js 要 import 建筑类型库，类型库再 import city.js）。
 * 所以这里导出自己的登记函数，由 city.js 汇总调用。
 *
 * 【漏登记的后果已经犯过两轮】
 * 相机避障完全依赖这份列表。漏掉一栋房子，相机就认为视线通畅，
 * 玩家看到的是一堵墙糊在镜头前 —— 而所有静态检查都显示「正常」。
 */
let SIGHT_REGISTRY = null;

/** 由 city.js 在建城前调用一次，交出登记表 */
export function bindSightRegistry(fn) {
  SIGHT_REGISTRY = fn;
}

/**
 * 登记一栋建筑的视线遮挡体积。
 * @param {number} x @param {number} z 中心
 * @param {number} w 宽（含出挑） @param {number} d 深（含出挑）
 * @param {number} top 总高
 * @param {boolean} [solid] 是否实心。默认 true。
 */
function declareBuildingSight(x, z, w, d, top, solid) {
  if (SIGHT_REGISTRY) SIGHT_REGISTRY(x, z, w, d, top, solid !== false);
}

/* ================================================================== */
/*  9 种建筑类型                                                        */
/* ================================================================== */

/**
 * 建筑类型表—— 城区生成器按权重从这里取类型。
 *
 * 每项：
 *   label    中文名（诊断脚本读它来报告「玩家看到什么」）
 *   weight   出现权重
 *   storey   几层的量级（决定高度档位）
 *   make(x, z, opts) → Group
 */
export const BUILDING_TYPES = {
  /* ---------------- 1. 小民居：最常见，1 层坡屋顶 ---------------- */
  cottage: {
    label: '民居',
    weight: 30,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 2;          // 4
      const d = MODULE * 1.5;        // 3
      const h = STOREY * 0.92;
      const m = wallMat(seed);
      const rm = roofMat(seed);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      g.add(wallPanel(w * 0.34, h, m, 'door', seed).translateX(-w * 0.32).translateZ(d / 2));
      g.add(wallPanel(w * 0.34, h, m, 'window', seed).translateX(w * 0.28).translateZ(d / 2));
      g.add(gableRoof(w, d, 1.5, rm, h));
      g.add(gableTri(w, d, 1.5, m, h));
      if (lod === 0) {
        g.add(chimney(w * 0.3, h + 0.9, -d * 0.2, stoneMat(seed)));
        g.add(cornerPosts(w, d, h, woodMat()));
      }
      return finish(g, x, z, w, d, h + 1.5, rot, seed);
    }
  },

  /* ---------------- 2. 联排民居：2 层 + 挑檐（半木结构感） --------- */
  townhouse: {
    label: '联排民居',
    weight: 22,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 2;
      const d = MODULE * 2;
      const h = STOREY * 1.72;       // 两层
      const m = wallMat(seed + 1);
      const rm = roofMat(seed + 2);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      // 一层开门
      g.add(wallPanel(w * 0.36, STOREY, m, 'door', seed).translateX(-w * 0.3).translateZ(d / 2));
      // 二层开两扇窗
      for (const sx of [-w * 0.26, w * 0.26]) {
        const p = wallPanel(w * 0.34, STOREY, m, 'window', seed);
        p.position.set(sx, STOREY, d / 2);
        g.add(p);
      }
      // 挑檐：两层之间的外挑带 —— 联排民居最强的识别特征，
      // 欧洲 timber frame 建筑就是这样一层的
      g.add(box(w + 0.7, 0.22, d + 0.7, woodMat(), 0, STOREY + 0.11, 0));
      // 挑檐下的斜撑
      for (const sx of [-1, 1]) {
        const br = new Mesh(new BoxGeometry(0.14, 0.14, 0.9), woodMat());
        br.position.set(sx * (w / 2 - 0.3), STOREY - 0.3, d / 2 + 0.32);
        br.rotation.x = -0.6;
        g.add(br);
      }
      g.add(gableRoof(w, d, 1.7, rm, h));
      g.add(gableTri(w, d, 1.7, m, h));
      if (lod === 0) {
        g.add(chimney(-w * 0.3, h + 1.0, -d * 0.18, stoneMat(seed)));
        g.add(cornerPosts(w, d, h, woodMat()));
      }
      return finish(g, x, z, w, d, h + 1.7, rot, seed);
    }
  },

  /* ---------------- 3. 工坊：宽体 + 大烟囱 + 雨棚 ---------------- */
  workshop: {
    label: '工坊',
    weight: 12,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 3;
      const d = MODULE * 2;
      const h = STOREY * 1.1;
      const m = wallMat(seed + 3);
      const rm = roofMat(seed + 1);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      // 大门：工坊需要能进车马，宽度是民居的两倍
      g.add(wallPanel(2.2, h, m, 'door', seed).translateX(-w * 0.2).translateZ(d / 2));
      g.add(wallPanel(2.0, h, m, 'window', seed).translateX(w * 0.3).translateZ(d / 2));
      g.add(gableRoof(w, d, 1.4, rm, h));
      g.add(gableTri(w, d, 1.4, m, h));
      // 大烟囱：工坊的锅炉烟囱，明显高于民居
      g.add(chimney(w * 0.34, h + 0.7, -d * 0.2, stoneMat(seed), 2.6));
      if (lod === 0) {
        // 雨棚：木架+ 斜撑，贴着大门口
        const cw = box(2.6, 0.12, 1.3, woodMat(), -w * 0.2, 2.5, d / 2 + 0.65);
        cw.rotation.x = -0.16;
        g.add(cw);
        for (const sx of [-1.1, 1.1]) {
          const post = box(0.12, 2.5, 0.12, woodMat(), -w * 0.2 + sx, 1.25, d / 2 + 1.2);
          g.add(post);
        }
        g.add(cornerPosts(w, d, h, woodMat()));
      }
      return finish(g, x, z, w, d, h + 3.4, rot, seed);
    }
  },

  /* ---------------- 4. 仓库：砖石长体 + 平顶 ---------------- */
  warehouse: {
    label: '仓库',
    weight: 10,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 4;
      const d = MODULE * 2.5;
      const h = STOREY * 1.05;
      const m = stoneMat(seed + 2);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      // 货装门：两扇并列大板门
      g.add(wallPanel(2.4, h, m, 'door', seed).translateX(-w * 0.24).translateZ(d / 2));
      g.add(wallPanel(1.8, h, m, 'window', seed).translateX(w * 0.26).translateZ(d / 2));
      // 平顶女儿墙：仓库的标志 —— 与民居的坡屋顶形成明确剪影对比
      g.add(box(w + 0.4, 0.4, d + 0.4, m, 0, h + 0.2, 0));
      for (const sz of [-1, 1]) {
        g.add(box(w + 0.4, 0.5, 0.34, m, 0, h + 0.65, (sz * (d + 0.4)) / 2));
      }
      for (const sx of [-1, 1]) {
        g.add(box(0.34, 0.5, d + 0.4, m, (sx * (w + 0.4)) / 2, h + 0.65, 0));
      }
      // 屋顶上的搬运吊臂：港口仓库必须有这个才读得出「码头用途」
      const arm = new Group();
      arm.add(box(0.24, 0.24, 2.6, woodMat(), 0, h + 1.9, 0));
      const post = box(0.28, 2.2, 0.28, woodMat(), 0, h + 1.0, -1.0);
      arm.add(post);
      arm.add(box(0.08, 1.1, 0.08, darkMat(), 0, h + 1.35, 1.1));
      arm.add(box(0.4, 0.3, 0.4, woodMat(), 0, h + 0.78, 1.1));
      g.add(arm);
      return finish(g, x, z, w, d, h + 2.6, rot, seed);
    }
  },

  /* ---------------- 5. 塔楼：多层 + 锥顶 ---------------- */
  tower: {
    label: '塔楼',
    weight: 7,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 2;
      const d = MODULE * 2;
      const storeys = 3 + (seed % 2);
      const h = STOREY * storeys;
      const m = stoneMat(seed);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      // 每层开窗（越高窗越小，符合真实比例）
      for (let f = 0; f < storeys; f++) {
        const y = f * STOREY;
        for (const sx of [-MODULE * 0.5, MODULE * 0.5]) {
          const p = wallPanel(1.5, STOREY, m, 'window', seed + f);
          p.position.set(sx, y, d / 2);
          // 顶层收窄
          p.scale.set(f === storeys - 1 ? 0.75 : 1, 1, 1);
          g.add(p);
        }
      }
      g.add(wallPanel(1.4, STOREY, m, 'arch', seed).translateX(0).translateZ(d / 2).translateY(0));
      // 顶层出挑檐口
      g.add(box(w + 0.8, 0.24, d + 0.8, m, 0, h + 0.12, 0));
      // 锥顶：八棱锥，读作塔楼
      const cone = new Mesh(new ConeGeometry(Math.max(w, d) * 0.78, 3.0, 8), roofMat(seed));
      cone.position.set(0, h + 0.24 + 1.5, 0);
      cone.castShadow = true;
      g.add(cone);
      // 顶尖
      const finial = new Mesh(new CylinderGeometry(0.06, 0.06, 0.7, 6), darkMat());
      finial.position.set(0, h + 0.24 + 3.0 + 0.35, 0);
      g.add(finial);
      return finish(g, x, z, w, d, h + 0.24 + 3.4, rot, seed);
    }
  },

  /* ---------------- 6. 小教堂：尖拱 + 钟楼 ---------------- */
  chapel: {
    label: '教堂',
    weight: 5,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 3;
      const d = MODULE * 3.5;
      const h = STOREY * 1.5;
      const m = stoneMat(seed + 1);
      const rm = roofMat(seed + 3);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      // 侧面的尖拱窗列 —— 教堂正面的识别符号
      for (const sx of [-w * 0.26, w * 0.26]) {
        const p = wallPanel(1.6, h, m, 'arch', seed);
        p.position.set(sx, 0, d / 2);
        g.add(p);
      }
      // 侧墙的窗（贴 ±X）
      for (const sz of [-d * 0.24, d * 0.24]) {
        const p = wallPanel(1.5, h, m, 'arch', seed + 1);
        p.position.set(w / 2, 0, sz);
        p.rotation.y = Math.PI / 2;
        g.add(p);
      }
      // 正门
      g.add(wallPanel(1.6, h, m, 'arch', seed).translateX(0).translateZ(d / 2).translateY(0));
      g.add(gableRoof(w, d, 2.4, rm, h));
      g.add(gableTri(w, d, 2.4, m, h));
      // 钟楼：贴在正门上方偏一侧，比主体窄、比主体高
      const tw = MODULE * 1.2;
      const th = STOREY * 1.1;
      g.add(box(tw, th, tw, m, -w * 0.24, h + 2.4 + th / 2 - 1.0, d / 2 - 0.6));
      const spire = new Mesh(new ConeGeometry(tw * 0.86, 2.6, 4), roofMat(seed + 2));
      spire.position.set(-w * 0.24, h + 2.4 + th - 1.0 + 1.3, d / 2 - 0.6);
      spire.rotation.y = Math.PI / 4;
      spire.castShadow = true;
      g.add(spire);
      // 钟面：深色圆盘
      const face = new Mesh(new CylinderGeometry(0.5, 0.5, 0.1, 12), darkMat());
      face.rotation.x = Math.PI / 2;
      face.position.set(-w * 0.24, h + 2.4 + th - 1.8, d / 2 - 0.6 + tw / 2);
      g.add(face);
      return finish(g, x, z, w, d, h + 2.4 + th + 1.6, rot, seed);
    }
  },

  /* ---------------- 7. 市集棚：木架 + 条纹顶棚 ---------------- */
  marketStall: {
    label: '市集棚',
    weight: 8,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 2;
      const d = MODULE * 1.5;
      const h = 2.5;                // 只有一层，且是敞开的
      const wood = woodMat();

      // 四根立柱
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          g.add(box(0.16, h, 0.16, wood, (sx * (w - 0.2)) / 2, h / 2, (sz * (d - 0.2)) / 2));
        }
      }
      // 柜台
      g.add(box(w - 0.3, 0.9, d * 0.5, wood, 0, 0.45, 0));
      g.add(box(w + 0.2, 0.12, d * 0.56, darkMat(), 0, 0.95, 0));
      // 顶棚：双坡 + 条纹（用两个色块交替读出布幔感）
      const slope = Math.atan2(0.7, d / 2);
      const len = Math.hypot(0.7, d / 2);
      for (const s of [1, -1]) {
        const c = wallMat(seed + (s > 0 ? 0 : 1));
        const panel = new Mesh(new BoxGeometry(w + 0.5, 0.08, len), c);
        panel.position.set(0, h + 0.35, (s * d) / 4);
        panel.rotation.x = s * slope;
        panel.castShadow = true;
        g.add(panel);
      }
      // 摊布：前沿垂下的布条
      g.add(box(w + 0.5, 0.5, 0.06, wallMat(seed + 2), 0, h + 0.12, d / 2 + 0.22));
      // 货物：几个彩色方块，读作「摆着东西」
      if (lod === 0) {
        for (let i = 0; i < 4; i++) {
          const c = box(0.34, 0.3, 0.34, wallMat(seed + i), -w * 0.3 + i * (w * 0.2), 1.16, 0);
          c.castShadow = false;
          g.add(c);
        }
      }
      // 棚顶会挡视线（走进去相机要抬），但立柱之间是空当，人应该穿得过。
      // 两者诉求不同：视线遮挡照常登记，碰撞则放行。
      return finish(g, x, z, w, d, h + 0.8, rot, seed, false);
    }
  },

  /* ---------------- 8. 带院独栋：外加一圈院墙 ---------------- */
  houseWithGarden: {
    label: '带院独栋',
    weight: 9,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 2.5;
      const d = MODULE * 2;
      const h = STOREY * 1.05;
      const m = wallMat(seed + 2);
      const rm = roofMat(seed + 4);

      // 主体
      g.add(box(w, h, d, m, 0, h / 2, 0));
      g.add(wallPanel(1.4, h, m, 'door', seed).translateX(-w * 0.22).translateZ(d / 2));
      g.add(wallPanel(1.6, h, m, 'window', seed).translateX(w * 0.26).translateZ(d / 2));
      g.add(gableRoof(w, d, 1.6, rm, h));
      g.add(gableTri(w, d, 1.6, m, h));
      if (lod === 0) {
        g.add(chimney(-w * 0.28, h + 1.0, -d * 0.2, stoneMat(seed)));
        g.add(cornerPosts(w, d, h, woodMat()));
      }
      // 院墙：只做三面（留出朝街的开口），
      // 让「独栋」在剪影上与联排区分开
      const yard = MODULE * 0.8;
      const wallH = 0.9;
      const ym = stoneMat(seed + 1);
      g.add(box(w + yard * 2, wallH, 0.22, ym, 0, wallH / 2, (d + yard) / 2));
      for (const sx of [-1, 1]) {
        g.add(box(0.22, wallH, d + yard, ym, (sx * (w + yard * 2)) / 2, wallH / 2, -yard / 2));
      }
      return finish(g, x, z, w + yard * 2, d + yard * 1.2, h + 1.6, rot, seed);
    }
  },

  /* ---------------- 9. 杂物棚：最小体量 ---------------- */
  shed: {
    label: '杂物棚',
    weight: 11,
    make(x, z, { seed = 0, rot = 0, lod = 0 } = {}) {
      const g = new Group();
      const w = MODULE * 1.5;
      const d = MODULE;
      const h = STOREY * 0.7;
      const m = woodMat();
      const rm = roofMat(seed + 2);

      g.add(box(w, h, d, m, 0, h / 2, 0));
      // 板条墙：用几根横木条读出「木板拼的」
      for (let i = 0; i < 3; i++) {
        g.add(box(w + 0.06, 0.1, 0.08, darkMat(), 0, h * (0.25 + i * 0.25), d / 2 + 0.02));
      }
      // 单坡顶（往一侧落坡）—— 与其他建筑的双坡形成对比
      const slope = Math.atan2(0.8, d);
      const panel = new Mesh(new BoxGeometry(w + 0.5, 0.2, Math.hypot(0.8, d)), rm);
      panel.position.set(0, h + 0.4, 0);
      panel.rotation.x = slope;
      panel.castShadow = true;
      g.add(panel);
      // 实心小屋：挡路。此前误传了 false（沿用旧的 walkable 语义），
      // 玩家能直接穿过棚子 —— 视觉上是 bug。
      return finish(g, x, z, w, d, h + 0.9, rot, seed, true);
    }
  }
};

/** 建筑类型名列表（按权重降序），供加权抽样 */
export const BUILDING_KEYS = Object.keys(BUILDING_TYPES);

/**
 * 各类型的**进深**（沿街方向占用的长度）与总高。
 *
 * 【为什么必须导出这张表，而不是让 city.js 自己去量】
 * 沿街排布时，调用方要按「上一个建筑的进深 + 墙缝」推进光标 ——
 * 这是「联排立面贴住」的实现基础。
 * 如果让 city.js 用 `child.children[0].geometry.boundingBox` 去反推，
 * 就得在测每个建筑时强制计算包围盒（几百次额外计算），
 * 而且量到的是含出挑的屋顶、不是墙的进深，会算错。
 * 所以这里直接给出「设计进深」，作为与几何同一数据源的显式声明。
 *
 * 【注意houseWithGarden 为什么是 4.0 而不是 4.8】
 * 它的几何上带一圈院墙（院墙在主体之外 0.8*MODULE 处），
 * 但**院墙不该计入沿街推进长度** —— 院墙是围合空间的，
 * 沿街立面由主体构成。若把 4.8 算进去，相邻两栋之间会多留 0.8 的缝，
 * 联排立面就断了。这张表记的是「参与沿街排布的那部分」。
 *
 * 【另一个用途：静态交叉校验】
 * tools/verify_assets.py 会核对这里声明的 depth 与 make() 里的
 * `const d = MODULE * x` 是否一致，防止改了几何却忘了改表。
 */
export const TYPE_FOOTPRINT = {
  cottage:         { depth: 3.0, height: 4.4 },
  townhouse:       { depth: 4.0, height: 7.1 },
  workshop:        { depth: 4.0, height: 7.0 },
  warehouse:       { depth: 5.0, height: 5.7 },
  tower:           { depth: 4.0, height: 16.7 },
  chapel:          { depth: 7.0, height: 13.4 },
  marketStall:     { depth: 3.0, height: 3.3 },
  // 注意：4.0 是主体进深，不含院墙。见上方说明。
  houseWithGarden: { depth: 4.0, height: 4.9 },
  shed:            { depth: 2.0, height: 3.1 }
};


/**
 * 加权抽取一个建筑类型。
 * @param {function():number} rng 确定性随机源
 * @param {string} tier 档位：'main' 主街 / 'cross' 横街 / 'fill' 街区内部
 *
 * 【为什么按档位分配权重 —— 分布协调的核心】
 * 主街是玩家 90% 时间在走的地方，必须以「可辨识的立面」为主：
 * 联排民居 + 教堂 + 塔楼在这里出现，视觉节奏丰富。
 * 街区内部只是远景剪影，用小体量的民居/杂物棚填充就够了 ——
 * 在那里堆教堂塔楼既看不见、又是无意义的性能开销。
 */
export function pickBuildingType(rng, tier = 'fill') {
  const table = {
    main: [['townhouse', 30], ['cottage', 22], ['houseWithGarden', 14],
      ['workshop', 12], ['marketStall', 10], ['chapel', 6], ['tower', 3], ['shed', 3]],
    // 【横街也要有地标 —— 实测校准】
    // 旧权重表里横街没有 chapel / tower，于是全城 13 单位以上的建筑
    // 只有 13 栋，且全部挤在主街上。主街只有 76 栋、其余 1172栋在别处，
    // 于是从横街或街区内部看出去，城市的天际线是平的。
    //
    // 横街同样是玩家会走、也会远眺的通道（它把城市切成四块），
    // 所以这里给 chapel/tower 各 4~5 的权重 —— 比主街低但非零。
    cross: [['cottage', 28], ['townhouse', 22], ['houseWithGarden', 14],
      ['workshop', 12], ['shed', 10], ['warehouse', 5],
      ['chapel', 5], ['tower', 4], ['marketStall', 4]],
    // 【街区内部也要有少量高类型 —— 否则城市轮廓是平的】
    // 围合占全城 76% 的建筑量，如果这里全是 3~5 米的民房与杂物棚，
    // 那么从任何位置远眺，背景轮廓就是一条平线，
    // 玩家读作「一大片同质化的郊区」。
    //
    // 但也不能多：内部是远景，堆教堂塔楼既看不见、又是性能开销。
    // 所以只给 6% 的塔楼 + 4% 的工坊（大烟囱，剪影高），
    // 合计 10% —— 站在街上时背景有起伏，走到内部时又仍是生活区。
    fill: [['cottage', 38], ['shed', 28], ['houseWithGarden', 18],
      ['townhouse', 10], ['tower', 6]]
  }[tier] || [['cottage', 1]];

  let total = 0;
  for (const [, w] of table) total += w;
  let r = rng() * total;
  for (const [key, w] of table) {
    r -= w;
    if (r <= 0) return key;
  }
  return table[0][0];
}

/* ================================================================== */
/*  收尾                                                                */
/* ================================================================== */

/**
 * 统一收尾：定位、旋转、接触阴影、遮挡登记。
 *
 * 【为什么要单独抽出来】
 * 9 种建筑都要做这三件事。此前它们散落在各工厂里，
 * 于是「某一种忘了登记遮挡」这种 bug 极难发现 ——
 * 代码看起来每种都差不多，漏了一种也看不出来。
 * 收在一处之后，漏登记在语法上就不可能发生。
 *
 * 【关于 solid】
 * solid 决定两件事：角色能否穿过（character.js 只撞 solid）、
 * 以及是否参与相机遮挡统计。
 * 严格说市集棚的棚顶**会**挡视线（该挡），但它的四根立柱之间是空当，
 * 人应该能穿过去走 —— 两者诉求不同，此处按「角色可穿过」取舍。
 * 棚顶挡视线由 declareBuildingSight 单独登记解决，两者不互相绑架。
 *
 * @param {boolean} solid 是否实心（挡角色）。默认 true。
 */
function finish(g, x, z, w, d, top, rot, seed, solid = true) {
  g.position.set(x, 0, z);
  // 轻微偏转：绝对平行的房子读作复制粘贴。
  // ±0.08弧度（约 4.6°）足够破除规整感，又不会让沿街面出现明显折角。
  g.rotation.y = rot !== undefined && rot !== 0
    ? rot
    : ((seed % 7) - 3) * 0.026;
  g.add(createBlobShadow(Math.max(w, d) * 0.6, 0.32, 0.8));
  // 登记时把出挑算进去：EAVE 让屋顶比墙宽，
  // 只登记墙宽的话屋脊会戳出登记盒（这个坑犯过一次）。
  declareBuildingSight(x, z, w + EAVE * 2, d + EAVE * 2, top, solid);
  return g;
}

/* ================================================================== */
/*  统计标签                                                            */
/* ================================================================== */

const TAG_LOG = [];

/**
 * 记录一栋建筑的类型与尺寸，供诊断工具精确统计。
 *
 * 【为什么必须显式打标签，而不是靠几何反推】
 * 第一版 city_report.py 用「登记盒进深」反推类型，结果是：
 * cottage 占 79%、5 种类型显示为 0。
 * 看着像「新建筑没生效」，实际是反推规则本身错了——
 * 带院独栋的主体进深 4.0，但登记盒含院墙是 5.92，
 * 于是它被误判成 warehouse（进深 5.0）；
 * 而杂物棚（进深 2.0）落在 cottage 的容差范围内，被吞掉了。
 * 几何反推在有出挑/院墙/旋转时永远不可靠。
 * 类型必须由工厂自己报出来 —— 它是唯一知道真相的地方。
 */
function tagBuilding(g, key, x, z, depth, top, zone) {
  TAG_LOG.push({ key, x, z, depth, top, zone: zone || 'unknown' });
}

export { tagBuilding };

/**
 * 取走并清空建筑标签表。诊断脚本专用。
 * 与 exportBlockers 同款「取走即清空」语义：每个场景只统计一次。
 */
export function exportBuildingTags() {
  return TAG_LOG.splice(0, TAG_LOG.length);
}
