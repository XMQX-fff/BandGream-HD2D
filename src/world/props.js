/**
 * 港口道具与建筑
 *
 * 材质原则（去塑料感）：
 *   roughness 0.85~1.0、metalness 0 —— 漫反射主导，几乎没有镜面高光。
 *   压低 roughness 会产生锐利白色高光，正是"塑料玩具感"的主要来源。
 *
 * 贴图全部改用程序化 HD-2D 贴图（hd2dTextures.js），
 * 理由见 scene.js 里createGround 的说明 —— 简言之：素材包的贴图是
 * 随机噪点，放大后满屏杂色，而 HD-2D 需要的是「大尺度结构」。
 */
import {
  BoxGeometry,
  CylinderGeometry,
  ConeGeometry,
  Shape,
  ExtrudeGeometry,
  IcosahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  Mesh,
  Group,
  MeshStandardMaterial,
  MeshBasicMaterial,
  PlaneGeometry,
  CanvasTexture,
  RepeatWrapping,
  LinearFilter,
  Color
} from 'three';
import * as HD2D_GEN from './hd2dTextures.js';
import { initHD2D } from './textures.js';

// 程序化贴图库单例。由本模块自己初始化，因为 props 是第一个用到它的。
// （避免依赖 main.js 的调用顺序 —— 场景搭建只需import 本模块就能用）
const HD2D = initHD2D(HD2D_GEN);

const MATS = {};

/**
 * 声明一个道具的「视线遮挡体积」。
 *
 * 【为什么需要它】
 * 相机的避障完全依赖一份遮挡物列表。这份列表原先只有 city.js 里的
 * 房子与树 —— 也就是说灯柱、木桶堆、长椅这些**实际会挡住视线**的道具
 * 从来没被登记过。相机于���认为视线通畅，玩家却看到一盏灯横在面前。
 * （诊断日志里那条 `(无名):Box @28` 就是漏登记的路灯。）
 *
 * 用法：在工厂函数 return 之前写一行
 *   g.userData.sight = { r: 0.5, top: 3.8, solid: true };
 *
 * 字段：
 *   r     —— 水平遮挡半径（圆柱近似，比 AABB 更贴道具实际形状）
 *   top   —— 遮挡物顶面离地高度
 *   solid —— true=也挡路（玩家不能穿过）；false=只挡视线
 *            （树/长椅应填 false：玩家应该能从旁边走过）
 *
 * scene.js 会遍历场景收集所有带此标记的对象并转成 blocker，
 * 所以**新增道具只要加这一行声明就自动生效**，不会再漏登记。
 *
 * @param {Group} g 道具根节点
 * @param {number} r 水平半径
 * @param {number} top 顶面高度
 * @param {boolean} solid 是否挡路
 * @returns {Group} 原节点，便于链式调用
 */
function declareSight(g, r, top, solid) {
  g.userData.sight = { r, top, solid };
  return g;
}

/**
 * 建筑/道具材质
 *
 * @param {string} genName hd2dTextures.js 里的生成函数名
 * @param {object} opts生成参数（色相/明度/种子）
 * @param {number} repeat 平铺次数
 * @param {number} colorTint 乘法微调（只该动明度，色相必须来自贴图）
 */
function mat(genName, opts, repeat = 1, colorTint = 0xffffff) {
  const key = `m:${genName}:${JSON.stringify(opts)}:${repeat}:${colorTint}`;
  if (MATS[key]) return MATS[key];
  const m = new MeshStandardMaterial({
    map: HD2D.tex(genName, opts, repeat),
    roughness: 0.95,
    metalness: 0.0
  });
  m.color.setHex(colorTint);
  MATS[key] = m;
  return m;
}

function box(w, h, d, m, x = 0, y = 0, z = 0) {
  const mesh = new Mesh(new BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ================================================================== */
/*  接触阴影 —— HD-2D 立体感的第一要素                                     */
/* ================================================================== */

/**
 * 贴地的软阴影贴片（blob shadow）。
 *
 * 【为什么必须加】
 * three 的 shadowMap 有一个致命弱点：它**照不进 sprite**，
 * 而 HD-2D 场景里最显眼的物体（角色）恰恰是 sprite。更根本的是，
 * 阴影贴图在像素化之后会被 RenderPixelatedPass 一起降采样 —— 一块
 * 本来柔和的接触阴影被压成硬边色块，读作「一个深色的椭圆贴纸」，
 * 完全不像影子。
 *
 * OT2 的做法（以及 Godot HD-2D 模板的做法）是在角色脚下摆一张
 * 径向渐变的椭圆贴片。它有两个不可替代的好处：
 *   1. 在像素化管线里它是**第一个被量化的东西**，边界与像素网格对齐
 *   2. 不依赖 shadowMap，可以自由调形状/浓度/朝向
 *
 * 太阳在场景左后方（见 SUN_OFFSET），因此阴影要往**右下**偏移，
 * 否则会和光从上方来的直觉冲突。
 */
let blobTex = null;
function blobShadowTexture() {
  if (blobTex) return blobTex;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // 分段更陡：中心实、中间过渡快、边缘干净收尾。
  // 纯 smoothstep 的径向渐变在像素化后会在外圈留下一圈明显的深色环。
  g.addColorStop(0.0, 'rgba(0,0,0,0.72)');
  g.addColorStop(0.42, 'rgba(0,0,0,0.60)');
  g.addColorStop(0.68, 'rgba(0,0,0,0.28)');
  g.addColorStop(0.86, 'rgba(0,0,0,0.07)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  blobTex = new CanvasTexture(c);
  // 阴影贴片是柔和渐变，用线性采样（它不需要参与像素化风格的硬边）
  blobTex.magFilter = LinearFilter;
  blobTex.minFilter = LinearFilter;
  blobTex.generateMipmaps = false;
  return blobTex;
}

let blobMat = null;
function blobMaterial(opacity = 1) {
  if (!blobMat) {
    blobMat = new MeshBasicMaterial({
      map: blobShadowTexture(),
      transparent: true,
      depthWrite: false,
      // 用纯黑 + opacity 控制强度。给 MeshBasicMaterial 设 color 会走乘法，
      // 结果和 opacity 叠加后难以预测，保持单一变量更好调。
      color: 0x000000,
      fog: true
    });
  }
  const m = blobMat.clone();
  m.opacity = opacity;
  return m;
}

/**
 * 生成一片接触阴影。
 * @param {number} r 椭圆半长（世界单位）
 * @param {number} skew 阴影偏移比例（0.5 = 往右下偏移半个身位）
 * @param {number} opacity 强度0~1
 */
export function createBlobShadow(r = 1.2, skew = 0.5, opacity = 1) {
  const mesh = new Mesh(new PlaneGeometry(r * 2, r * 1.35), blobMaterial(opacity));
  mesh.rotation.x = -Math.PI / 2;
  // 太阳来自左后上方（-X, +Z），影子落在 +X, -Z 方向
  mesh.position.set(r * skew, 0.028, -r * skew);
  mesh.renderOrder = 2;
  // 显式命名：诊断脚本要能把接触阴影与「漏注入淡出的建筑」区分开。
  // 之前只能靠「transparent + depthWrite=false」去猜，
  // 而这两个特征别的材质也可能带（比如水面）——
  // 靠猜的断言迟早会把无辜材质误判成漏注入。
  mesh.name = 'blob-shadow';
  return mesh;
}

/* ================================================================== */
/*  建筑                                                                */
/* ================================================================== */

/**
 * 一栋中世纪港屋：灰泥墙 + 赭红陶瓦坡屋顶 + 木质梁架
 */
export function createHouse({
  w = 6, d = 5, h = 4.5,
  roofH = 2.2,
  wallTint = 0xffffff,
  roofTint = 0xffffff,
  seed = 0
} = {}) {
  const g = new Group();
  const slope = Math.atan2(roofH, d / 2);
  const roofLen = Math.hypot(roofH, d / 2);   // 坡面斜长

  // 墙面：程序化灰泥。seed 让每栋房的斑驳位置不同，
  // 否则一片建筑群会读作「同一个贴图贴了二十遍」。
  const wallMat = mat('plasterWall', { seed: 200 + seed * 13, hue: 36, sat: 0.09, baseL: 0.85 },
    Math.max(1, Math.round(w / 4.5)), wallTint);

  // 屋顶：程序化陶瓦。
  //
  // 【关键：瓦垄必须沿屋脊方向排列，且不沿坡面重复】
  // 瓦垄在贴图里是竖条纹（沿 v 方向延伸）。要让它正确地横铺过坡面：
  //   - u（沿屋脊 X 向）需要重复，才能横向铺满多垄瓦
  //   - v（沿坡长 Z 向）必须 repeat = 1，否则瓦垄被切成一段一段
  //
// 之前用 set(repeat, repeat) 两个方向都重复 —— 瓦垄被斜切成
  // 「一格一格的鱼鳞」，在像素化下读作「搓衣板」。这是屋顶显得
  // 平淡发扁的直接原因。
  //
  // 物理尺寸对齐：瓦片宽约 0.35 单位，坡长约 5 单位 → u 重复 w/0.35 次。
  const roofTexU = Math.max(3, Math.round((w + 0.7) / 0.42));
  const roofMat = mat('clayTiles', { seed: 300 + seed * 7, hue: 13, sat: 0.44, baseL: 0.44 },
    roofTexU, roofTint);
  // 只让 u 方向重复：v 必须锁死为 1
  roofMat.map = roofMat.map.clone();
  roofMat.map.repeat.set(roofTexU, 1);
  roofMat.map.needsUpdate = true;

  const woodMat = mat('woodPlanks', { seed: 400 + seed * 3, hue: 27, sat: 0.32, baseL: 0.44 },
    1, 0xc8b090);

  // 主体
  g.add(box(w, h, d, wallMat, 0, h / 2, 0));

  // 坡屋顶：两个斜面盒体（屋脊沿 X，向 ±Z 落坡）
  for (const s of [1, -1]) {
    const panel = new Mesh(new BoxGeometry(w + 0.7, 0.28, roofLen), roofMat);
    panel.position.set(0, h + roofH / 2 - 0.1, (s * d) / 4);
    panel.rotation.x = s * slope;
    panel.castShadow = true;
    panel.receiveShadow = true;
    g.add(panel);
  }
  // 屋脊
  g.add(box(w + 0.9, 0.3, 0.42, roofMat, 0, h + roofH - 0.05, 0));

  // 山墙：屋顶下方那块三角形空间必须填实。
  // 少了它，从侧面看房子就是一个「只有两片斜屋顶、内部全空」的壳子。
  for (const s of [-1, 1]) {
    const shape = new Shape();
    shape.moveTo(-d / 2, 0);
    shape.lineTo(d / 2, 0);
    shape.lineTo(0, roofH);
    shape.closePath();
    const gableGeo = new ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false });
    gableGeo.rotateY(Math.PI / 2);
    gableGeo.rotateZ(Math.PI / 2);
    const gable = new Mesh(gableGeo, wallMat);
    gable.position.set((s * (w + 0.2)) / 2, h - 0.1, 0);
    gable.castShadow = true;
    gable.receiveShadow = true;
    g.add(gable);
  }

  // 木质角柱（半木结构感）
  const post = 0.28;
  for (const sx of [-1, 1]) {
    g.add(box(post, h, post, woodMat, (sx * (w - post)) / 2, h / 2, d / 2 + 0.02));
    g.add(box(post, h, post, woodMat, (sx * (w - post)) / 2, h / 2, -d / 2 - 0.02));
  }
  // 横向木梁
  g.add(box(w + 0.06, 0.24, 0.14, woodMat, 0, h * 0.62, d / 2 + 0.03));
  g.add(box(w + 0.06, 0.24, 0.14, woodMat, 0, h * 0.24, d / 2 + 0.03));

  // 门（朝向 +Z）
  const doorMat = mat('woodPlanks', { seed: 500, hue: 24, sat: 0.34, baseL: 0.34, vertical: false }, 1, 0xd0b090);
  g.add(box(1.05, 2.0, 0.12, doorMat, 0, 1.0, d / 2 + 0.08));
  // 门框
  g.add(box(1.3, 0.16, 0.16, woodMat, 0, 2.06, d / 2 + 0.08));

  // 窗（朝向 +Z）—— 自发光，参与 bloom
  const winMat = new MeshBasicMaterial({ color: 0xffd894, fog: true });
  const winFrame = mat('woodPlanks', { seed: 520, hue: 26, sat: 0.3, baseL: 0.3 }, 1, 0x9a8058);
  for (const wx of [-w * 0.28, w * 0.28]) {
    const wy = h * 0.5;
    const wz = d / 2 + 0.06;
    const win = new Mesh(new BoxGeometry(0.62, 0.72, 0.06), winMat);
    win.position.set(wx, wy, wz + 0.03);
    g.add(win);
    g.add(box(0.78, 0.1, 0.12, winFrame, wx, wy + 0.4, wz + 0.03));
    g.add(box(0.78, 0.1, 0.12, winFrame, wx, wy - 0.4, wz + 0.03));
    // 竖向窗棂：一条中挺，读作「窗」而不是「一块黄板」
    g.add(box(0.07, 0.72, 0.1, winFrame, wx, wy, wz + 0.04));
  }

  // 烟囱
  if (seed % 2 === 0) {
    const chim = box(0.7, 1.7, 0.7, wallMat, w * 0.28, h + roofH * 0.5 + 0.6, -d * 0.2);
    g.add(chim);
  }

  // 接触阴影：房子体量大，shadowMap 虽有，但加一层贴地暗影能让
  // 「建筑坐在地上」这件事在俯视角下更明确。
  g.add(createBlobShadow(Math.max(w, d) * 0.62, 0.32, 0.85));

  g.userData.height = h + roofH;
  return g;
}

/* ================================================================== */
/*  道具                                                                */
/* ================================================================== */

export function createBarrel() {
  const woodMat = mat('woodPlanks', { seed: 600, hue: 26, sat: 0.34, baseL: 0.48 }, 1, 0xd0b890);
  const g = new Group();
  const body = new Mesh(new CylinderGeometry(0.42, 0.36, 0.95, 10), woodMat);
  body.position.y = 0.48;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  // 铁箍
  const bandMat = new MeshStandardMaterial({ color: 0x3c4049, roughness: 0.82, metalness: 0.12 });
  for (const y of [0.28, 0.68]) {
    const b = new Mesh(new CylinderGeometry(0.435, 0.435, 0.09, 10), bandMat);
    b.position.y = y;
    g.add(b);
  }
  g.add(createBlobShadow(0.62, 0.5, 0.8));
  // 半径取桶身 0.42，顶部 0.95+0.05 留一点余量
  return declareSight(g, 0.45, 1.0, true);
}

export function createCrate(s = 0.9) {
  const g = new Group();
  g.add(box(s, s * 0.82, s, mat('woodPlanks', { seed: 610, hue: 27, sat: 0.33, baseL: 0.46 }, 1), 0, (s * 0.82) / 2, 0));
  // 边框：比箱体略暗，读作"加箍"
  const edge = mat('woodPlanks', { seed: 610, hue: 27, sat: 0.33, baseL: 0.46 }, 1, 0x8a6a48);
  const t = 0.1;
  g.add(box(s + 0.04, t, s + 0.04, edge, 0, s * 0.82, 0));
  g.add(box(s + 0.04, t, s + 0.04, edge, 0, t, 0));
  g.add(createBlobShadow(s * 0.82, 0.5, 0.8));
  // 箱体对角一半：挡视线也挡路
  return declareSight(g, s * 0.72, s * 0.95, true);
}

/** 木桶堆 / 木板堆等装饰堆 */
export function createBarrelStack() {
  const g = new Group();
  const positions = [
    [0, 0, 0],
    [0.92, 0, 0.25],
    [0.46, 0.86, 0.12]
  ];
  for (const [x, y, z] of positions) {
    const b = createBarrel();
    b.position.set(x, y, z);
    b.rotation.y = (x * 2.7 + z) % Math.PI;
    // 堆叠时下面那几筒自带阴影会互相叠加成脏块，去掉内部的
    b.children = b.children.filter((c) => c.renderOrder !== 2);
    g.add(b);
  }
  g.add(createBlobShadow(1.9, 0.42, 0.9));
  // 堆高约 1.3，最外一只偏心 0.92，半径按最远边算
  return declareSight(g, 1.45, 1.35, true);
}

/** 路灯（带发光灯罩，为 bloom 提供高光） */
export function createLampPost() {
  const g = new Group();
  const woodMat = mat('woodPlanks', { seed: 620, hue: 25, sat: 0.32, baseL: 0.3 }, 1);
  const post = new Mesh(new CylinderGeometry(0.09, 0.12, 3.1, 8), woodMat);
  post.position.y = 1.55;
  post.castShadow = true;
  g.add(post);

  const base = new Mesh(new CylinderGeometry(0.24, 0.3, 0.3, 8), woodMat);
  base.position.y = 0.15;
  g.add(base);

  // 灯罩（自发光，参与 bloom）
  const glowMat = new MeshBasicMaterial({ color: 0xffd98a, fog: false });
  const lamp = new Mesh(new CylinderGeometry(0.26, 0.2, 0.44, 6), glowMat);
  lamp.position.y = 3.24;
  g.add(lamp);

  const cap = new Mesh(new ConeGeometry(0.34, 0.26, 6), woodMat);
  cap.position.y = 3.58;
  g.add(cap);

  g.add(createBlobShadow(0.52, 0.55, 0.75));
  g.userData.glow = glowMat;
  // 柱身很细（r=0.12），但灯罩挑到 3.7 —— 会遮住远处街景，
  // 必须登记：漏了它相机会认为视线通畅，玩家却看到一盏灯横在面前。
  return declareSight(g, 0.42, 3.75, true);
}

/** 系船柱 */
export function createMooringBollard() {
  const m = new MeshStandardMaterial({ color: 0x4a5058, roughness: 0.85, metalness: 0.1 });
  const g = new Group();
  const body = new Mesh(new CylinderGeometry(0.2, 0.24, 0.72, 10), m);
  body.position.y = 0.36;
  body.castShadow = true;
  g.add(body);
  const cap = new Mesh(new CylinderGeometry(0.26, 0.2, 0.16, 10), m);
  cap.position.y = 0.78;
  g.add(cap);
  g.add(createBlobShadow(0.42, 0.55, 0.7));
  // 只到 0.86，太矮 —— 视线从上方越过，只挡路不挡视线
  return declareSight(g, 0.28, 0.9, true);
}

/** 栈桥（木板 + 支撑桩） */
export function createPier(len = 22, w = 5) {
  const g = new Group();
  const plankMat = mat('woodPlanks', { seed: 630, hue: 29, sat: 0.31, baseL: 0.56 }, 1);
  const pileMat = mat('woodPlanks', { seed: 640, hue: 25, sat: 0.33, baseL: 0.38 }, 1);

  // 甲板：木纹沿桥长方向（vertical=false 让板缝横排）
  const deck = new Mesh(new BoxGeometry(w, 0.3, len),
    mat('woodPlanks', { seed: 630, hue: 29, sat: 0.31, baseL: 0.56, vertical: false }, Math.max(2, Math.round(len / 4))));
  deck.position.y = 0.5;
  deck.receiveShadow = true;
  deck.castShadow = true;
  g.add(deck);
  plankMat.userData.unused = true;

  // 侧边梁
  for (const s of [-1, 1]) {
    g.add(box(0.18, 0.4, len, pileMat, (s * w) / 2, 0.34, 0));
  }

  // 支撑桩
  const n = Math.floor(len / 2.2);
  for (let i = 0; i <= n; i++) {
    const z = -len / 2 + (i * len) / n;
    for (const s of [-1, 1]) {
      const p = new Mesh(new CylinderGeometry(0.26, 0.29, 2.8, 8), pileMat);
      p.position.set((s * (w - 0.5)) / 2, -0.75, z);
      p.castShadow = true;
      g.add(p);
    }
  }

  // 栏杆 —— 没有竖直参照物时栈桥会读作一块浮空斜板
  const railMat = mat('woodPlanks', { seed: 650, hue: 27, sat: 0.3, baseL: 0.5 }, 1);
  for (const s of [-1, 1]) {
    g.add(box(0.12, 0.12, len, railMat, (s * w) / 2, 1.5, 0));
    const posts = Math.max(3, Math.round(len / 2.6));
    for (let i = 0; i <= posts; i++) {
      const z = -len / 2 + (i * len) / posts;
      g.add(box(0.13, 1.05, 0.13, railMat, (s * w) / 2, 0.98, z));
    }
  }
  return g;
}

/** 小船（船体 + 桅杆 + 帆） */
export function createBoat({ len = 6, tint = 0xffffff } = {}) {
  const g = new Group();
  const hullMat = mat('woodPlanks', { seed: 660, hue: 26, sat: 0.34, baseL: 0.44 }, 1, tint);

  // 船体：压扁的六棱柱，做出有棱角的船形
  const hull = new Mesh(new CylinderGeometry(0.95, 0.7, len, 6, 1, false), hullMat);
  hull.rotation.x = Math.PI / 2;
  hull.scale.set(1, 1, 0.55);
  hull.position.y = 0.36;
  hull.castShadow = true;
  hull.receiveShadow = true;
  g.add(hull);

  // 船首船尾：收窄的尖头，让轮廓是梭形而非桶形
  for (const s2 of [1, -1]) {
    const tip = new Mesh(new ConeGeometry(0.72, 1.5, 5), hullMat);
    tip.rotation.x = s2 * Math.PI / 2;
    tip.scale.set(1, 1, 0.55);
    tip.position.set(0, 0.36, (s2 * len) / 2 + s2 * 0.72);
    tip.castShadow = true;
    g.add(tip);
  }

  // 舷墙：沿船舷一圈略高的木条 —— 这是「船」最强的识别特征
  const railMat = mat('woodPlanks', { seed: 670, hue: 28, sat: 0.3, baseL: 0.5 }, 1);
  for (const s2 of [-1, 1]) {
    g.add(box(0.14, 0.34, len * 0.95, railMat, s2 * 0.82, 0.62, 0));
  }
  const stern = new Mesh(new BoxGeometry(1.5, 0.5, 0.14), railMat);
  stern.position.set(0, 0.6, -len / 2 - 0.5);
  g.add(stern);

  // 甲板
  const deck = new Mesh(new BoxGeometry(1.4, 0.1, len * 0.9),
    mat('woodPlanks', { seed: 680, hue: 30, sat: 0.3, baseL: 0.62, vertical: false }, 2));
  deck.position.y = 0.58;
  deck.receiveShadow = true;
  g.add(deck);

  // 桅杆
  const mastMat = mat('woodPlanks', { seed: 690, hue: 24, sat: 0.32, baseL: 0.36 }, 1);
  const mast = new Mesh(new CylinderGeometry(0.06, 0.09, 3.6, 6), mastMat);
  mast.position.y = 2.5;
  mast.castShadow = true;
  g.add(mast);
  const yard = new Mesh(new CylinderGeometry(0.05, 0.05, 1.9, 5), mastMat);
  yard.rotation.z = Math.PI / 2;
  yard.position.y = 3.2;
  g.add(yard);

  // 帆：微鼓的弧面
  const sailGeo = new SphereGeometry(1.5, 10, 6, 0, Math.PI * 1.1, Math.PI * 0.3, Math.PI * 0.42);
  const sailMat = new MeshStandardMaterial({ color: 0xfaf2e0, roughness: 0.98, metalness: 0, side: 2 });
  const sail = new Mesh(sailGeo, sailMat);
  sail.scale.set(0.85, 1.15, 0.5);
  sail.position.set(0, 2.5, 0.12);
  sail.castShadow = true;
  g.add(sail);

  return g;
}

/** 码头边的旗杆 + 三角旗 */
export function createBanner() {
  const g = new Group();
  const poleMat = mat('woodPlanks', { seed: 700, hue: 24, sat: 0.3, baseL: 0.42 }, 1);
  const pole = new Mesh(new CylinderGeometry(0.07, 0.08, 4.4, 6), poleMat);
  pole.position.y = 2.2;
  pole.castShadow = true;
  g.add(pole);

  // 旗面：条纹程序化贴图
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cf4a34';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#f2dc96';
  for (let i = 0; i < 4; i++) ctx.fillRect(i * 8, 0, 4, 32);
  const tex = new CanvasTexture(c);
  tex.colorSpace = 'srgb';
  tex.magFilter = LinearFilter;
  tex.wrapS = RepeatWrapping;

  const flagMat = new MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0, side: 2 });
  const flag = new Mesh(new BoxGeometry(1.5, 0.9, 0.04), flagMat);
  flag.position.set(0.78, 3.85, 0);
  flag.castShadow = true;
  g.add(flag);

  g.add(createBlobShadow(0.44, 0.6, 0.6));
  g.userData.flag = flag;
  // 旗杆细（r=0.08）但挑到 4.4，会挡住港口方向的远景
  return declareSight(g, 0.35, 4.5, true);
}

/** 街灯油灯（放在木箱上，制造高低层次） */
export function createLantern() {
  const g = new Group();
  const glowMat = new MeshBasicMaterial({ color: 0xffd98a, fog: false });
  const glass = new Mesh(new CylinderGeometry(0.16, 0.18, 0.34, 6), glowMat);
  glass.position.y = 0.62;
  g.add(glass);

  const metalMat = new MeshStandardMaterial({ color: 0x50555e, roughness: 0.8, metalness: 0.2 });
  const cap = new Mesh(new ConeGeometry(0.24, 0.16, 6), metalMat);
  cap.position.y = 0.85;
  g.add(cap);
  const base = new Mesh(new CylinderGeometry(0.2, 0.22, 0.12, 6), metalMat);
  base.position.y = 0.4;
  g.add(base);

  g.userData.glow = glowMat;
  // 油灯本身很小，只挡路不挡视线
  return declareSight(g, 0.3, 1.0, true);
}

/* ================================================================== */
/*  广场陈设                                                            */
/* ================================================================== */

/** 花坛：石砌边沿 + 泥土 + 灌木丛 */
export function createPlanter(r = 1.4) {
  const g = new Group();
  const stoneMat = mat('stoneBlocks', { seed: 800, hue: 32, sat: 0.10, baseL: 0.68 }, Math.max(2, Math.round(r * 2)));

  // 边沿（八边形砌块）
  const rim = new Mesh(new CylinderGeometry(r, r * 1.04, 0.42, 8), stoneMat);
  rim.position.y = 0.21;
  rim.castShadow = true;
  rim.receiveShadow = true;
  g.add(rim);

  // 泥土面
  const soilMat = new MeshStandardMaterial({
    map: HD2D.tex('grassPatch', { seed: 810, hue: 32, sat: 0.34, baseL: 0.34 }, 1),
    roughness: 1.0, metalness: 0
  });
  const soil = new Mesh(new CylinderGeometry(r * 0.82, r * 0.82, 0.1, 8), soilMat);
  soil.position.y = 0.44;
  soil.receiveShadow = true;
  g.add(soil);

  // 灌木：不同大小的球簇，形成蓬松轮廓
  const blobs = [
    [0, 0.72, 0, 0.52, 0],
    [-0.42, 0.6, 0.22, 0.36, 1],
    [0.4, 0.62, -0.2, 0.4, 2],
    [0.05, 0.92, 0.18, 0.3, 2]
  ];
  for (const [bx, by, bz, br, mi] of blobs) {
    const b = new Mesh(new IcosahedronGeometry(br, 0), leafMaterial(mi));
    b.position.set(bx, by, bz);
    b.scale.set(1, 0.82, 1);
    b.castShadow = true;
    g.add(b);
  }

  g.add(createBlobShadow(r * 1.25, 0.45, 0.85));
  // 花坛：挡住路，视线多半从上方越过
  return declareSight(g, r * 1.15, 1.0, true);
}

/**
 * 树冠材质：三个明度档，靠贴图提供内部层次
 *
 * ===================================================================
 * 【为什么不是鲜绿色】—— 截图验证发现这是全场景「廉价感」的最大来源
 * ===================================================================
 * 之前三档都用了 sat 0.32~0.36、色相 98~110（正绿偏冷）。
 * 问题在于树冠接受的是 2.75 强度的直射太阳：
 * 高饱和度的绿被强光一照，色相被推到极限，读作「塑料玩具树」——
 * 和 OT2 里那种沉静的、被阳光晒得微微发黄的深绿完全不是一回事。
 *
 * OT2 树冠的三个特征，这里逐条对应：
 *   1. **明度压低**—— 日光下的树冠本身是暗的，亮的是它被照到的那几块
 *   2. **饱和度降下来**—— 到 0.17~0.21，绿色不再「发光」
 *   3. **色相往黄偏**—— 88~96 而���是正绿。暖光照在黄绿上才是
 *      「被太阳晒过」，而不是「涂了一层绿漆」
 *
 * 三档明度差也拉开了（0.26/0.31/0.36，原来只差 0.05），
 * 让同一个树冠内部就有明暗层次，而不是一坨均匀的绿。
 */
const leafMatCache = new Map();
function leafMaterial(mi) {
  if (!leafMatCache.has(mi)) {
    const opts = [
      { seed: 900, hue: 88, sat: 0.17, baseL: 0.26 },
      { seed: 901, hue: 92, sat: 0.19, baseL: 0.31 },
      { seed: 902, hue: 96, sat: 0.21, baseL: 0.36 }
    ][mi];
    leafMatCache.set(mi, new MeshStandardMaterial({
      map: HD2D.tex('leafCanopy', opts, 1),
      roughness: 1.0,
      metalness: 0
    }));
  }
  return leafMatCache.get(mi);
}

/** 长椅：木座板 + 铸铁腿 + 靠背 */
export function createBench() {
  const g = new Group();
  const woodMat = mat('woodPlanks', { seed: 810, hue: 28, sat: 0.31, baseL: 0.5 }, 1);
  const ironMat = new MeshStandardMaterial({ color: 0x33363d, roughness: 0.72, metalness: 0.32 });

  const seat = new Mesh(new BoxGeometry(2.0, 0.12, 0.62), woodMat);
  seat.position.y = 0.62;
  seat.castShadow = true;
  seat.receiveShadow = true;
  g.add(seat);

  const back = new Mesh(new BoxGeometry(2.0, 0.5, 0.1), woodMat);
  back.position.set(0, 0.98, -0.26);
  back.rotation.x = -0.14;
  back.castShadow = true;
  g.add(back);

  for (const s of [-1, 1]) {
    const leg = new Mesh(new BoxGeometry(0.11, 0.62, 0.5), ironMat);
    leg.position.set(s * 1.0 - s * 0.14, 0.31, 0);
    leg.castShadow = true;
    g.add(leg);
  }
  g.add(createBlobShadow(1.15, 0.45, 0.8));
  // 座面高 0.5，靠背挑到 1.1；玩家应能从旁边走过
  return declareSight(g, 1.0, 1.15, false);
}

/** 广场树：树干 + 分枝 + 球簇树冠 */
export function createTree({ h = 5.4, spread = 2.3, tint = null, lod = 0 } = {}) {
  const g = new Group();

  const barkMat = mat('woodPlanks', { seed: 820, hue: 22, sat: 0.30, baseL: 0.34 }, 1);
  const trunkH = h * 0.52;
  const trunk = new Mesh(new CylinderGeometry(0.2, 0.36, trunkH, lod === 2 ? 5 : 7), barkMat);
  trunk.position.y = trunkH / 2;
  trunk.castShadow = lod === 0;
  trunk.receiveShadow = true;
  g.add(trunk);

  // 树枝：只在中近景做。
  // 【远处树砍掉枝杈的理由】两根枝各约 20 面，占单棵树的 40 面；
  // 而在 LOD2（190 单位外）它们被雾和树冠完全遮住，
  // 砍掉对画面零影响，是纯亏的面数。
  if (lod < 2) {
    for (const s of [-1, 1]) {
      const limb = new Mesh(new CylinderGeometry(0.07, 0.11, h * 0.26, 5), barkMat);
      limb.position.set(s * spread * 0.22, trunkH + h * 0.06, s * 0.1);
      limb.rotation.z = -s * 0.55;
      limb.rotation.x = s * 0.2;
      limb.castShadow = lod === 0;
      g.add(limb);
    }
  }

  // 树冠：多簇低面数球。外圈补足 8 颗把轮廓填满 —— OT2 的树冠是
  // 「实心团块」，稀疏的球簇会漏出天空，读作「棉花糖」。
  const blobs = [
    [0, 0.74, 0, 0.62, 0],
    [-spread * 0.42, 0.66, spread * 0.24, 0.52, 1],
    [spread * 0.40, 0.70, -spread * 0.22, 0.54, 1],
    [-spread * 0.26, 0.94, -spread * 0.32, 0.46, 2],
    [spread * 0.30, 0.90, spread * 0.30, 0.48, 2],
    [0, 1.10, 0, 0.44, 2],
    [-spread * 0.50, 0.50, -spread * 0.14, 0.44, 1],
    [spread * 0.52, 0.54, spread * 0.16, 0.46, 0],
    [-spread * 0.60, 0.78, -spread * 0.42, 0.40, 2],
    [spread * 0.58, 0.82, spread * 0.44, 0.42, 1],
    [-spread * 0.14, 0.62, -spread * 0.56, 0.40, 0],
    [spread * 0.18, 0.60, spread * 0.58, 0.42, 2],
    [-spread * 0.56, 1.02, spread * 0.18, 0.38, 0],
    [spread * 0.54, 1.00, -spread * 0.20, 0.38, 1],
    [-spread * 0.30, 1.16, spread * 0.34, 0.36, 1],
    [spread * 0.34, 1.14, -spread * 0.30, 0.36, 0]
  ];
  // tint 保留为可选的整体色偏（供不同季节/树种区分）
  const leafTint = tint !== null ? new Color(tint) : null;

  // ===================================================================
  // 【树的 LOD —— 这一节决定了 10倍地图能不能跑起来】
  // ===================================================================
  // 实测：900 棵满配树 = 900 × 15 颗 Icosahedron = 13500 个 mesh、
  // 33 万三角面，占全场景几何量的 99.9%，帧率直接掉到个位数。
  //
  // 树是这套画面里「数量最多 × 单体最不重要」的东西 ——
  // 站远了只看到一个绿色团块，15 颗球和 5 颗球在屏幕上没有区别。
  // 所以按距离砍球数是纯赚：
  //   lod 0（近，< 90）  15 颗球 + 投影 —— 完整轮廓
  //   lod 1（中，< 190） 6 颗球，不投影 —— 只保留剪影
  //   lod 2（远）        3 颗球，不投影 —— 一个色块够了
  const LOB_COUNT = [blobs.length, 6, 3][lod] ?? blobs.length;
  for (let bi = 0; bi < LOB_COUNT; bi++) {
    const [bx, by, bz, br, mi] = blobs[bi];
    const leaf = new Mesh(new IcosahedronGeometry(br * spread * 0.95, 0), leafMaterial(mi));
    leaf.position.set(bx, h * by, bz);
    leaf.rotation.set(bx * 1.7, bz * 2.3, by * 1.1);
    leaf.scale.set(1, 0.82, 1);
    leaf.castShadow = lod === 0;
    if (leafTint) leaf.material = leaf.material.clone();
    if (leafTint) leaf.material.color.copy(leafTint);
    g.add(leaf);
  }

  // 树冠接地阴影：树冠很大，缺了它整棵树会「浮」在广场上。
  if (lod === 0) g.add(createBlobShadow(spread * 1.5, 0.42, 0.72));
  g.userData.height = h;
  return g;
}

/**
 * 喷泉 —— 广场的视觉焦点
 *
 * ===================================================================
 * 【让喷泉在俯视构图里真正可见的三个必要条件】
 * ===================================================================
 * 斜俯视角下，一个「圆盘+ 立柱」的喷泉有个致命的结构问题：
 * 俯视时看到的主要是**顶部的圆盘**，立柱几乎完全被自己的顶盘挡住。
 * 于是喷泉读作「地上放了个盘子」，高度感、雕塑感全部丢失。
 *
 * 之前的做法是把立柱加高到 2.6，但那只是在几何上堆高度，
 * 俯视角度下依然看不见 —— 因为遮挡关系没变。
 *
 * 正确的做法（三条同时满足才成立）：
 *   1. **顶盘的直径必须远小于立柱高度**，这样俯视时能看穿过去，
 *      看到立柱的侧面 → 立刻读出「这有根柱子，很高」。
 *      之前 dish1 直径 2.84 vs 柱高 2.6，几乎相等 → 完全挡住。
 *      现在 dish1 收到 1.15、dish2 收到 0.72。
 *   2. **顶盘不能同心叠放**。同心叠盘子会让俯视轮廓变成一个
 *      规则圆形（读作「井盖」）。把上层盘偏移出去，
 *      轮廓变成不规则，读作雕塑。
 *   3. **柱身要分段收分**（下粗上细的锥度）。等径圆柱读作「管子」，
 *      分段收分读作「古典柱式」，且每段的转折处都会吃一道侧光，
 *      在俯视下形成明暗节拍。
 *
 * 色相上，广场是灰蓝调、石材是暖白偏黄，两者色差让喷泉一眼可辨。
 */
export function createFountain() {
  const g = new Group();
  // 色相是这里的重点：
  // hue 38 sat 0.15 baseL 0.88 + tint 0xfff8e8 —— 结果是**暖白偏黄**。
  // 广场地面是 hue 33 sat 0.21的灰蓝调，两者色相差约 5°，
  // 在暖色阳光下被放大到一眼可辨。
  //
  // 但明度必须真的高（baseL 0.88）。之前试过 0.80，
  // 喷泉在强日照下被压成「土黄褐色」，读作「一个泥坑」。
  // 喷泉石材是全场**最亮**的材质，这是它作为视觉焦点的物理基础。
  const stoneMat = mat('stoneBlocks', { seed: 1000, hue: 38, sat: 0.15, baseL: 0.88 }, 2, 0xfff8e8);
  // 池沿比主体暗一档，用于分出「沿 / 壁 / 水」三段
  const rimMat = mat('stoneBlocks', { seed: 1001, hue: 37, sat: 0.14, baseL: 0.79 }, 3, 0xfdf0d8);

  // ---------- 台座 ----------
  // 两级台阶：从广场地面「托」起来，投下自身阴影，产生接触感。
  // 台阶是必须的 —— 只有一圈平齐的基座时，俯视角度下喷泉与地面
  // 之间没有明暗分界，读作「地上摆了个东西」；有了两级台阶，
  // 每级都吃一道侧光，俯视下形成两条清晰的明暗带。
  const plinth = new Mesh(new CylinderGeometry(4.15, 4.4, 0.34, 12), rimMat);
  plinth.position.y = 0.17;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  g.add(plinth);

  const plinth2 = new Mesh(new CylinderGeometry(3.82, 4.02, 0.30, 12), stoneMat);
  plinth2.position.y = 0.49;
  plinth2.castShadow = true;
  plinth2.receiveShadow = true;
  g.add(plinth2);

  // ---------- 外池 ----------
  // 【池壁必须够高，池面才会「读作水」】
  // 外池高 1.0、水面直径 5.96 —— 俯视角度下看到的是一片很大的水面，
  // 而水面在 MeshStandardMaterial 下受光照影响大：
  // 2.75 强度的直射光打上去，加上 roughness 0.13 的高光，
  // 结果是一大片被照亮的青灰，读作「一坨灰绿色的塑料」。
  //
  // 解决：**把池沿加高到 1.45**，让俯视时池沿的墙面占掉大部分，
  // 只露出中间一小块水面。水面变成「池子里的水」而不是「一个水池形色块」。
  // 这是所有真实喷泉都有的比例关系 —— 池壁总是远高于池口宽度的一部分。
  const basin = new Mesh(new CylinderGeometry(3.5, 3.62, 1.45, 12), stoneMat);
  basin.position.y = 1.39;
  basin.castShadow = true;
  basin.receiveShadow = true;
  g.add(basin);

  const rim = new Mesh(new CylinderGeometry(3.28, 3.28, 0.20, 12), rimMat);
  rim.position.y = 2.20;
  rim.castShadow = true;
  g.add(rim);

  // 池水：俯视时这是喷泉最显眼的部分 —— 一汪发亮的青蓝。
  //
  // 亮度靠**自发光**而不是靠 color：水面本身的漫反射在强日照下
  // 会被太阳压成灰白，自发光才能保证它始终比周围的石材亮一档，
  // 从而「托住」画面的视觉重心。
  const poolMat = new MeshStandardMaterial({
    color: 0x3aa8c4, roughness: 0.24, metalness: 0.05,
    emissive: 0x1a6f88, emissiveIntensity: 1.05
  });
  const pool = new Mesh(new CylinderGeometry(2.92, 2.92, 0.07, 12), poolMat);
  pool.position.y = 2.10;
  g.add(pool);

  // ---------- 中央柱 ----------
  // 【分段收分，而不是一根等径圆柱】
  // 等径圆柱在俯视下读作「一根管子」；分三段、逐段收细的柱式
  // 读作「古典柱」，而且每段的转折都会吃一道侧光，
  // 在俯视角度下形成明暗节拍 —— 这是水景雕塑感的主要来源。
  const colSegs = [
    // [底半径, 顶半径, 高度, 中心y]
    [0.86, 0.68, 1.10, 2.85],
    [0.66, 0.50, 1.10, 3.95],
    [0.48, 0.34, 1.00, 5.00]
  ];
  for (const [rb, rt, h, y] of colSegs) {
    const seg = new Mesh(new CylinderGeometry(rt, rb, h, 10), stoneMat);
    seg.position.y = y;
    seg.castShadow = true;
    seg.receiveShadow = true;
    g.add(seg);
  }
  // 柱身分段处的箍环：暗一档，形成横向节拍
  for (const y of [2.85, 3.95]) {
    const band = new Mesh(new CylinderGeometry(0.90, 0.90, 0.14, 10), rimMat);
    band.position.y = y;
    band.castShadow = true;
    g.add(band);
  }

  // ---------- 顶盘 ----------
  // 直径必须**远小于柱高**，否则俯视时顶盘把柱子完全盖住。
  const dish1 = new Mesh(new CylinderGeometry(1.15, 0.62, 0.34, 10), stoneMat);
  dish1.position.y = 5.68;
  dish1.castShadow = true;
  g.add(dish1);
  const dishRim = new Mesh(new TorusGeometry(1.15, 0.08, 4, 10), rimMat);
  dishRim.rotation.x = Math.PI / 2;
  dishRim.position.y = 5.82;
  g.add(dishRim);

  // 上层盘**偏移**而不是同心叠放：同心叠放时俯视轮廓是规则圆形，
  // 读作「井盖」；偏移之后轮廓不规则，读作雕塑。
  const dish2 = new Mesh(new CylinderGeometry(0.70, 0.90, 0.28, 8), stoneMat);
  dish2.position.set(0.22, 6.00, -0.14);
  dish2.rotation.y = 0.4;
  dish2.castShadow = true;
  g.add(dish2);

  // 顶饰：全场最亮的小点，视线自然被吸住
  const finialMat = new MeshStandardMaterial({
    color: 0xfff2d0, roughness: 0.26, metalness: 0.3,
    emissive: 0xffc85e, emissiveIntensity: 0.85
  });
  const finial = new Mesh(new SphereGeometry(0.30, 10, 8), finialMat);
  finial.position.set(0.22, 6.32, -0.14);
  finial.castShadow = true;
  g.add(finial);

  // ---------- 水柱与落水 ----------
  // 从顶盘落到池面的四道水柱。它们在俯视下是四条**竖直的亮线**，
  // 是喷泉最重要的高度线索 —— 没有它，池面与顶盘之间是空的。
  const streamMat = new MeshBasicMaterial({
    color: 0xdaf4f8, transparent: true, opacity: 0.72, fog: false
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    // 落水轨迹：从顶盘边缘抛物线落到池面，用 5 段小球近似
    for (let k = 0; k < 5; k++) {
      const t = k / 5;
      const drop = new Mesh(new SphereGeometry(0.075 - t * 0.02, 5, 4), streamMat);
      // 抛物线：水平方向匀速外抛，垂直方向加速下落
      const outR = 0.95 + t * 1.9;
      drop.position.set(
        Math.cos(a) * outR + 0.22 * (1 - t),
        5.51 - t * t * 3.4,
        Math.sin(a) * outR - 0.14 * (1 - t)
      );
      g.add(drop);
    }
  }
  // 池面溅起的泡沫：几个低矮的亮环，暗示「这里有水在动」
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const foam = new Mesh(new TorusGeometry(0.34, 0.06, 4, 8), streamMat);
    foam.rotation.x = Math.PI / 2;
    foam.position.set(Math.cos(a) * 2.4, 2.16, Math.sin(a) * 2.4);
    g.add(foam);
  }

  g.add(createBlobShadow(4.8, 0.34, 0.9));
  g.userData.glow = poolMat;
  return g;
}
/* ================================================================== */
/*  延展海岸线 —— 地图放大 10 倍后需要把「海」这件事有头有尾地表达出来      */
/* ================================================================== */

/**
 * 防波堤（一段斜坡石垒）。
 *
 * 【它解决什么问题】
 * 地图从 28×26 扩到 280×260 后，海面变成4200 单位宽。
 * 如果海岸线不做任何处理，玩家往西走到 x=-140 时看到的画面是：
 * 石板地 → 沙滩 → 一望无际的海 → 雾。
 * 没有任何东西告诉玩家「海到这里结束了」，
 * 于是这张图读作「内陆的湖」，而不是「港口」——
 * 港口城市的空间逻辑（陆 → 海的边界感）就丢了。
 *
 * 防波堤是那个「边界」。它必须**斜向伸入海中**（不是平行于海岸），
 * 因为斜向的堤在俯视视角下能形成一条明确的斜线，
 * 这是画面里少有的、能立刻读作「人造结构 + 有方向」的元素。
 */
export function createWaveBreak() {
  const g = new Group();
  const stoneMat = mat('stoneBlocks', { seed: 720, hue: 34, sat: 0.08, baseL: 0.66 }, 3);
  const stoneDark = mat('stoneBlocks', { seed: 721, hue: 33, sat: 0.09, baseL: 0.5 }, 3);

  // 堤身：3 段递进，每段更矮更宽 —— 模拟向海中延伸的坡度
  const segs = [
    { w: 9,  h: 2.6, z: 0 },
    { w: 7.5, h: 2.1, z: -3.4 },
    { w: 6,   h: 1.6, z: -6.4 }
  ];
  for (const s of segs) {
    const m = box(s.w, s.h, 3.2, stoneMat, 0, s.h / 2 - 0.4, s.z);
    g.add(m);
    // 堤顶压一道暗色压顶石：HD-2D 里水平方向的亮带能把斜线「钉住」
    g.add(box(s.w * 0.96, 0.34, 3.3, stoneDark, 0, s.h - 0.4, s.z));
  }
  // 消波石（乱石堆）：打破规整感，同时暗示「这里有浪」
  const rockMat = mat('stoneBlocks', { seed: 730, hue: 36, sat: 0.06, baseL: 0.58 }, 1);
  for (let i = 0; i < 6; i++) {
    const r = new Mesh(new IcosahedronGeometry(0.5 + (i % 3) * 0.18, 0), rockMat);
    r.position.set(-3.2 + i * 1.3, -0.2, 1.2 + (i % 2) * 0.7);
    r.rotation.set(i * 0.7, i * 1.1, i * 0.3);
    r.castShadow = true;
    g.add(r);
  }
  g.add(createBlobShadow(5.5, 0.3, 0.8));
  return g;
}

/**
 * 灯塔（海岸线尽端的视觉锚点）。
 *
 * 【为什么必须有灯塔】
 * 海岸线在雾里延伸时，玩家会失去「海在哪边」的方向感。
 * 灯塔是地图上唯一的高耸垂直物，它同时提供两件事：
 *   1. 位置锚点 —— 看到灯塔就知道自己在港口的哪一端
 *   2. 高度对比 —— 城区全是低矮房屋（4~7.5 单位），
 *      一座 16 单位的灯塔会让「这是一个镇」这件事被读出来
 */
export function createLighthouse() {
  const g = new Group();

  // 塔身：三段收分的圆柱，每段颜色不同 —— 这是灯塔的经典识别特征
  const bands = [
    { h: 6.0, r0: 1.5, r1: 1.3, c: 0xf6f0e4 },
    { h: 3.0, r0: 1.3, r1: 1.15, c: 0xd8483c },   // 红色带
    { h: 4.2, r0: 1.15, r1: 0.95, c: 0xf6f0e4 }
  ];
  let y = 0;
  for (const b of bands) {
    const m = new MeshStandardMaterial({ color: b.c, roughness: 0.9, metalness: 0.0 });
    m.color.setHex(b.c);
    const seg = new Mesh(new CylinderGeometry(b.r1, b.r0, b.h, 14), m);
    seg.position.y = y + b.h / 2;
    seg.castShadow = true;
    seg.receiveShadow = true;
    g.add(seg);
    y += b.h;
  }

  // 灯室：发光体 —— Bloom 会把它拉出一圈光晕，
  // 夜里（暗部）它就是海面上唯一的暖色点
  const lampMat = new MeshBasicMaterial({ color: 0xffe8a0 });
  lampMat.color.setHex(0xffe8a0);
  const lamp = new Mesh(new CylinderGeometry(0.78, 0.78, 1.3, 12), lampMat);
  lamp.position.y = y + 0.65;
  g.add(lamp);
  g.userData.glow = lampMat;

  // 灯室栏杆
  const railMat = new MeshStandardMaterial({ color: 0x4a5058, roughness: 0.85 });
  railMat.color.setHex(0x4a5058);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.add(box(0.1, 0.85, 0.1, railMat, Math.cos(a) * 0.85, y + 0.42, Math.sin(a) * 0.85));
  }
  // 灯室顶棚
  const deck = new Mesh(new CylinderGeometry(0.9, 0.9, 0.14, 12), railMat);
  deck.position.y = y + 0.9;
  g.add(deck);

  // 锥顶
  const capMat = new MeshStandardMaterial({ color: 0x3a4048, roughness: 0.8 });
  capMat.color.setHex(0x3a4048);
  const cap = new Mesh(new ConeGeometry(1.0, 1.1, 12), capMat);
  cap.position.y = y + 2.1;
  cap.castShadow = true;
  g.add(cap);

  // 基座
  const baseMat = mat('stoneBlocks', { seed: 740, hue: 34, sat: 0.07, baseL: 0.62 }, 2);
  g.add(box(4.2, 1.1, 4.2, baseMat, 0, 0.55, 0));
  g.add(createBlobShadow(2.6, 0.4, 0.85));
  return g;
}
