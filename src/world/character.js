/**
 * 角色：Sprite + 图集精灵 + 控制器
 *
 * HD-2D 里最容易翻车的地方 —— 像素一致性。关键设置：
 *
 *  1. sizeAttenuation = true（世界空间缩放）
 *     精灵与 3D 几何体共用同一张低分辨率 beauty RT 与同一套采样参数，
 *     像素网格天然对齐，无需额外对齐。
 *     注意：不要设 sizeAttenuation=false —— 那种模式下 scale 是 NDC 单位，
 *     会让精灵涨到屏幕高度的数十倍（实测精灵会盖住整个画面）。
 *
 *  2. sharp-bilinear：map 的 magFilter 用 LinearFilter（不是 Nearest）
 *     Nearest 在放大时采样点跳变会造成「跳动的边缘」，转视角时尤其明显。
 *     线性插值天然提供 1 像素抗锯齿，消除闪烁。硬像素感由后处理的
 *     RenderPixelatedPass 统一提供 —— 纹理不必也不该自己承担这件事。
 *
 *  3. alphaTest = 0.5
 *     透明混合的半透明边缘在放大后成为明显脏边。
 *
 *  4. depthWrite = false + renderOrder 高于水面
 *     SpriteMaterial 强制 transparent，three 会对透明物体关闭深度写入并按
 *     距离排序，导致角色与水面排序翻转（角色「插进水里」）。
 *
 * 美术：Kenney Roguelike Characters（CC0），由 tools/build_cast.py 烘焙成
 * 4 方向 x 4 帧图集。行走帧为程序化位移 + 底部折叠，非逐帧手绘。
 */
import {
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  TextureLoader,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  LinearSRGBColorSpace,
  Vector2
} from 'three';
import { createBlobShadow } from './props.js';

/**
 * 角色在世界空间的高度。
 *
 * 基准是房屋门框 2.0 —— 人应略低于门（门是给「人」通过的高度）。
 *
 * 【1.95 → 2.55，配合 PIXEL_SIZE 4→3】
 * 这一版的依据是 sprite-check.html 的实测（把精灵按游戏内实际尺寸
 * 渲染出来逐帧看），结论很明确：
 *   角色高 1.95 + 像素粒度 4时，精灵在屏幕上约 77px 高，
 *   经RenderPixelatedPass 量化后**五官完全消失** ——
 *   画面上只剩「橙衣 + 红裙 + 棕发」三个色块，
 *   换成香澄之后玩家根本看不出换了角色。
 *
 * 粒度降到 3 让像素块变小（细节保留更多），
 * 身高提到 2.55 让精灵在屏幕上约 100px 高。
 * 两者相乘，精灵从 77px/19格 变成约 100px/33格 ——
 * 有效像素格数提升 74%，五官这才读得出来。
 *
 * 代价：角色比门高 0.55（约半个头）。这是**故意的** ——
 * HD-2D 的角色历来不严格守比例，OT2 里主角同样比门框略高。
 * 真实比例在这个像素尺度下会让主角「消失」，而主角必须看得见。
 *
 * 【2.55 → 2.95：换成 codex-pet 素材后的再次调整】
 * 新素材是「1:1.9 头身比」的Q 版角色（大眼、宽头），
 * 辨识度主要靠**紫瞳和彩色星星发饰**这两个小面积高对比元素。
 * 2.55 时精灵在屏幕上约 100px 高，实机截图里紫瞳只剩 1 个像素块，
 * 星星发饰完全读不出来 —— 也就是说这张素材最值钱的部分被量化掉了。
 * 提到 2.95（约 116px / 39 格）后，紫瞳能占2 个像素块、星饰可辨。
 * 这是「素材换了，比例参数也要跟着换」的又一例：不能沿用上一版的数值。
 */
const SPRITE_WORLD_HEIGHT = 2.95;

/**
 * 精灵的垂直锚点比例。
 * Sprite 的 position 是几何中心，0.5 意味着角色有一半沉到地面以下，
 * 画面上只剩「浮空的半身」。抬到半高即可让脚底正好落地。
 */
const ANCHOR_Y = 0.5;

/** 精灵中心的离地高度 = 身高 x 锚点比例，让脚底贴地 */
const BASE_Y = SPRITE_WORLD_HEIGHT * ANCHOR_Y;

/** 图集规格，必须与 tools/import_kasumi_pet.py 的输出严格一致 */
const DIRS = 4;
const FRAMES = 4;
const COLS_PER_CAST = FRAMES;

/**
 * 各角色调用的图集列（0..7）。
 *
 * 顺序必须与构建脚本的 cast 列表严格一致
 * （tools/import_kasumi_pet.py 的 NPC_CAST，规格记录在
 * assets-source/cast.meta.json —— 注意该文件**运行时不会被加载**，
 * 它只是给人看的构建元数据）。
 * 改顺序时必须同步改图集，否则 NPC 会集体串色。
 */
const CAST_INDEX = {
  hero: 0,
  npcFisher: 1,
  npcGuard: 2,
  npcChild: 3,
  npcElder: 4,
  npcGuard2: 5,
  npcFisher2: 6,
  npcChild2: 7
};

/* ------------------------------------------------------------------ */
/*  图集                                                                */
/* ------------------------------------------------------------------ */

let sharedTex = null;

/** 图集只加载一次：8 个角色共用一张 512x64，多角色不额外增加显存 */
function getAtlas() {
  if (!sharedTex) {
    const tex = new TextureLoader().load('assets/chars/cast.png');
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = SRGBColorSpace;
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
    sharedTex = tex;
  }
  return sharedTex;
}

/* ------------------------------------------------------------------ */
/*  法线贴图 —— 让角色吃场景光照                                        */
/* ------------------------------------------------------------------ */

/**
 * 问题：SpriteMaterial 默认**不受光照影响**，角色永远是「一块平的贴纸」，
 * 无论场景光从哪来。这正是「角色读作贴纸、场景读作 3D」的根源。
 *
 * 解法（思路来自 hd2d-diorama 的 normalFromHeight，调研抄来）：
 * 从精灵的颜色图推导切线空间法线图，挂到 normalMap 上。billboard 的
 * 切线空间就是屏幕空间（T=右，B=上），所以可以直接从亮度梯度生成：
 * 亮的一侧视作凸起朝向观众，用 Sobel 算子取梯度，
 * Z 分量固定为一个较大的常数表示「假厚度」。
 *
 * 强度克制：Z 必须足够大（这里 0.80），否则整个精灵会被侧光打成平面
 * 剪影 —— 反而比不做更糟。
 *
 * 注意必须先解码图片才能读像素，所以这里走 fetch → createImageBitmap，
 * 不能用 TextureLoader（它不暴露解码后的像素数据）。
 */
let atlasNormalPromise = null;
function getAtlasNormal() {
  if (!atlasNormalPromise) {
    atlasNormalPromise = (async () => {
      const res = await fetch('assets/chars/cast.png');
      const bitmap = await createImageBitmap(await res.blob());

      const src = document.createElement('canvas');
      src.width = bitmap.width;
      src.height = bitmap.height;
      const sctx = src.getContext('2d');
      sctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      const S = src.width;
      const px = sctx.getImageData(0, 0, S, S).data;

      const out = document.createElement('canvas');
      out.width = out.height = S;
      const ctx = out.getContext('2d');
      const img = ctx.createImageData(S, S);
      const d = img.data;

      const lum = (x, y) => {
        const i = (y * S + x) * 4;
        return (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
      };

      const STRENGTH = 3.2;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const l = lum(Math.max(0, x - 1), y);
          const r = lum(Math.min(S - 1, x + 1), y);
          const u = lum(x, Math.max(0, y - 1));
          const dn = lum(x, Math.min(S - 1, y + 1));

          // 上下方向翻转：canvas 的 y 向下，而切线空间 B 轴向上
          const nx = (l - r) * STRENGTH;
          const ny = (dn - u) * STRENGTH;
          const nz = 0.80;
          const len = Math.hypot(nx, ny, nz);

          d[i] = ((nx / len) * 0.5 + 0.5) * 255;
          d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
          d[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      const tex = new CanvasTexture(out);
      // 法线是数据贴图：线性空间。缩小靠 mipmap 抗锯齿。
      tex.colorSpace = LinearSRGBColorSpace;
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      return tex;
    })();
  }
  return atlasNormalPromise;
}

/**
 * 在图集内寻址。列 = castIdx * FRAMES + frame，行 = dir。
 * 运行时只改 texture.offset/repeat，因此所有角色可共享同一张 GPU 纹理，
 * 但每帧要改 offset 的实例必须各自持有一份 texture 引用（three 的
 * texture 变换是对象级状态）—— 所以这里做浅克隆共享同一张 image。
 */
function makeSheetMaterial(castIdx) {
  const tex = getAtlas().clone();
  tex.needsUpdate = true;

  const mat = new SpriteMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.5,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true
  });
  mat.userData.totalCols = FRAMES * 8;

  // 法线图是异步生成的（要先解码图片）。
  // 生成完再挂上去：中间几帧角色只是不吃光照，
  // 视觉上读作「逐渐立体」而非「突然变形」，可以接受。
  getAtlasNormal().then((nrm) => {
    const n = nrm.clone();
    n.needsUpdate = true;
    n.repeat.copy(tex.repeat);
    n.offset.copy(tex.offset);
    mat.normalMap = n;
    mat.normalScale = new Vector2(0.9, 0.9);
    mat.needsUpdate = true;
  });

  return { mat, tex, castIdx };
}

/** 设置精灵的帧（dir, frame）—— map 与 normalMap 必须同步偏移 */
function setCell(mat, castIdx, dir, frame) {
  const totalCols = mat.userData.totalCols;
  const col = castIdx * COLS_PER_CAST + frame;
  for (const t of [mat.map, mat.normalMap]) {
    if (!t) continue;
    t.repeat.set(1 / totalCols, 1 / DIRS);
    t.offset.set(col / totalCols, 1 - (dir + 1) / DIRS);
  }
  const key = `${castIdx}:${dir}:${frame}`;
  if (mat.userData.cellKey !== key) {
    mat.userData.cellKey = key;
    mat.needsUpdate = true;
  }
}

/** 把输入向量转成图集行号（0=down 1=up 2=left 3=right） */
function dirFromVector(dx, dz) {
  if (Math.abs(dx) > Math.abs(dz)) return dx < 0 ? 2 : 3;
  return dz < 0 ? 1 : 0;
}

export function createCharacter(paletteKey = 'hero') {
  const castIdx = CAST_INDEX[paletteKey] ?? 0;
  const { mat } = makeSheetMaterial(castIdx);

  const sprite = new Sprite(mat);
  const px = SPRITE_WORLD_HEIGHT;
  sprite.scale.set(px, px, 1);
  sprite.renderOrder = 10; // 高于水面(1)
  sprite.name = `character_${paletteKey}`;
  sprite.frustumCulled = false;
  // 逐帧改贴图 offset，不能被静态合并
  sprite.userData.dynamic = true;

  // 脚下接触阴影。与所有道具共用 props 的 blob 实现——
  // 全场用同一套阴影语言（同样的形状、同样的偏移方向）才读作同一个世界。
  const shadow = createBlobShadow(0.62, 0.55, 0.9);
  shadow.userData.dynamic = true;

  const state = {
    x: 0, z: 0,
    dir: 0,
    moving: false,
    animTime: 0,
    frame: 0,
    speed: 7.5
  };

  /**
   * 建筑碰撞体。由 main.js 注入（见 scene.js 的 blockers 列表）。
   *
   * 【为什么必须有碰撞 —— 这是「角色彻底看不见」的根本原因】
   * 在加碰撞之前，hero.update 只用 WORLD.bounds 夹住坐标，
   * 玩家可以**走进房子内部**。一旦走进房子：
   *   · 相机的视线起点（角色 +Z 侧 34 单位）必然落在某栋房子里，
   *   · 或者相机与角色之间隔着两堵墙，
   *   · 无论怎么调避障参数都救不回来 ——
   *     因为「玩家在墙里」这个状态本身就不该存在。
   *
   * 实测射线诊断（tools/diagnose_camera.py）在 (-30,120) 命中 7 个遮挡物，
   * 其中包含玩家所在位置的建筑 —— 玩家正站在房子里。
   *
   * 【为什么只挡「solid」物体】
   * 树也登记在 blockers 里（它们确实会挡视线），
   * 但玩家应该能从树下走过，只是别让树把镜头挡住。
   * 所以碰撞只取 solid = true 的项（房子、喷泉、灯塔）。
   */
  let solids = [];
  const RADIUS = 1.1;   // 角色碰撞半径，约半身宽

  /**
   * 把角色推出所有实心建筑。
   *
   * 做法是「最小位移推出」：对每个与角色圆相交的盒子，
   * 算出四面墙里最近的一面，把角色推到墙外。
   *
   * 【为什么不逐轴分离（先解 X 再解 Z）】
   * 逐轴分离在贴墙滑动时会有「卡在墙角」的现象：
   * 沿 X 推出后正好又被 Z 方向的另一面墙挡住，
   * 玩家在墙角里反复抖动。这里每帧只推一次最小位移，
   * 一次就能脱离，代价是偶尔会有一点点「贴墙感」，可以接受。
   */
  function resolveCollisions() {
    for (let i = 0; i < solids.length; i++) {
      const b = solids[i];
      // 圆 vs AABB 的快速排除：角色中心到盒子的最近点
      const nx = state.x < b.minX ? b.minX : (state.x > b.maxX ? b.maxX : state.x);
      const nz = state.z < b.minZ ? b.minZ : (state.z > b.maxZ ? b.maxZ : state.z);
      const dx = state.x - nx;
      const dz = state.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= RADIUS * RADIUS) continue;   // 没碰到

      if (d2 > 1e-8) {
        // 圆心在盒外：沿最近点方向推出
        const d = Math.sqrt(d2);
        const push = RADIUS - d;
        state.x += (dx / d) * push;
        state.z += (dz / d) * push;
      } else {
        // 圆心在盒内（已经穿墙）：推到最近的一条边外
        const outL = state.x - b.minX;   // 往 -X 推的距离
        const outR = b.maxX - state.x;   // 往 +X
        const outB = state.z - b.minZ;   // 往 -Z
        const outT = b.maxZ - state.z;   // 往 +Z
        const m = Math.min(outL, outR, outB, outT);
        if (m === outL) state.x = b.minX - RADIUS;
        else if (m === outR) state.x = b.maxX + RADIUS;
        else if (m === outB) state.z = b.minZ - RADIUS;
        else state.z = b.maxZ + RADIUS;
      }
    }
  }

  /**
   * 摆阴影。
   *
   * createBlobShadow 把「偏离物体中心」烘在了 mesh.position 上（要按半径
   * 比例缩放偏移量）。因此这里不能直接把 mesh.position 设成角色坐标 ——
   * 那会把偏移抹掉，影子正落在脚下正中，读作「贴纸」而不是「影子」。
   * 正确做法是记住偏移量，每帧相加。
   */
  const shadowOffX = shadow.position.x;
  const shadowOffZ = shadow.position.z;
  function placeShadow() {
    shadow.position.set(state.x + shadowOffX, 0.028, state.z + shadowOffZ);
  }

  setCell(mat, castIdx, 0, 0);
  placeShadow();

  return {
    sprite,
    shadow,
    state,

    /** 每帧更新；返回是否在移动 */
    update(dt, dx, dz, bounds) {
      const len = Math.hypot(dx, dz);
      state.moving = len > 0.001;

      if (state.moving) {
        state.x += dx * state.speed * dt;
        state.z += dz * state.speed * dt;

        if (bounds) {
          state.x = Math.min(bounds.maxX, Math.max(bounds.minX, state.x));
          state.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, state.z));
        }

        // 推出建筑 —— 必须在世界边界夹取之后，否则会被推出地图外
        if (solids.length) resolveCollisions();

        state.dir = dirFromVector(dx, dz);
        // 行走帧循环：图集只有 4 帧，用相位偏移得到非零起点的步伐
        state.animTime += dt * 7.0;
        state.frame = Math.floor(state.animTime) % FRAMES;
      } else {
        state.animTime += dt * 1.6;
        // 待机：偶数帧（站立姿势）不播，避免「原地踏步」
        state.frame = Math.floor(state.animTime) % 2 === 0 ? 0 : 2;
      }

      setCell(mat, castIdx, state.dir, state.frame);
      sprite.position.set(state.x, BASE_Y, state.z);
      placeShadow();
      return state.moving;
    },

    /**
     * 注入建筑碰撞体。
     * @param {Array} list scene.js 的 blockers 列表
     */
    setColliders(list) {
      solids = (list || []).filter((b) => b.solid);
    },

    /** 是否卡在某个实心体内（调试用：截图脚本可读取判断是否穿模） */
    isStuck: () => {
      for (let i = 0; i < solids.length; i++) {
        const b = solids[i];
        if (state.x > b.minX && state.x < b.maxX && state.z > b.minZ && state.z < b.maxZ) return true;
      }
      return false;
    },

    /**
     * 瞬移（出生点 / 诊断脚本用）。
     *
     * 【也必须做碰撞推出】
     * 诊断脚本（tools/diagnose_camera.py）用它把角色送到各个测试机位。
     * 这里如果不推出，角色会直接落在房子内部 ——
     * 而「玩家在墙里」正是本轮要修的核心问题。
     * 调试入口若能绕过修复，测出来的结论必然是错的。
     */
    setPosition(x, z) {
      state.x = x;
      state.z = z;
      if (solids.length) resolveCollisions();
      sprite.position.set(state.x, BASE_Y, state.z);
      placeShadow();
    },

    setDir(dir) {
      state.dir = dir;
      setCell(mat, castIdx, state.dir, state.frame);
    }
  };
}