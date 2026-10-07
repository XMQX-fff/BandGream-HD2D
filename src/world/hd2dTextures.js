/**
 * HD-2D 程序化像素贴图库
 *
 * 【为什么必须自己画，而不能继续用 Kenney 素材包】
 *
 * 之前地面/墙面/屋顶都用 Kenney Retro Textures（CC0，64×64）。问题在于
 * 这些贴图的内容是**随机噪点**：`floor_stone_sand_random` 整张图是随机的
 * 浅褐色沙粒，在 PIXEL_SIZE=6 的像素化下，一个 texel 被放大成 6×6 的屏幕
 * 像素块 —— 于是满屏都是大小相近、互不相干的杂色块。
 *
 * 读起来就是「脏、粗糙、没有细节」。这不是分辨率问题，是**贴图内容本身
 * 缺少结构**：HD-2D 的地面是「一块块可辨认的石板」，噪点里没有石板。
 *
 * OT2 地面贴图的核心特征（也是这里逐条对着实现的）：
 *   1. 有**大尺度结构** —— 石板边界是明确的直线/弧线，占据画面主要视觉权重
 *   2. 每块石板内部**只有 2~3 级明度**，绝不做逐像素随机
 *   3. 明度分布**低对比** —— 靠"块与块之间的差异"而非"像素之间的差异"产生质感
 *   4. 缝隙是**一条统一的暗线**，把整张图读成"铺装"而非"噪声"
 *
 * 全部用 Canvas 程序化生成，尺寸统一 64×64，配NearestFilter。
 * 好处是完全可控：色相、明度、结构都能按场景需要调，且体积只有几KB。
 */

/** 固定随机种子 —— 保证每次刷新画面完全一致，便于截图对比 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * 创建一个 64×64 像素贴图。
 * @param {(x:number,y:number)=>[number,number,number]} shader 逐像素回调
 */
function pixelTexture(shader, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const rgb = shader(x, y);
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 把 HSL 转成 RGB（0~255） */
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

/* ================================================================== */
/*  石板铺装 —— 场景里占比最大的表面，对画质影响最直接                 */
/* ================================================================== */

/**
 * 4×4 石板铺装。
 *
 * 每块石板 16×16 texel，缝隙 1texel。tile 边长对应约 5 世界单位，
 * 因此单块石板约 1.25 单位 ≈ 1.15 米 —— 与角色身高 1.95 单位成合理比例。
 *
 * 关键：石板内部的明度变化只有 3 级，且**按低频正弦分布**（不是随机），
 * 这样即使被像素化放大，也读作"整块石板的一个面"而不是"一堆噪点"。
 */
export function stonePaving({ seed = 7, hue = 34, sat = 0.16, baseL = 0.62 } = {}) {
  const S = 64;
  const N = 4;              // 每边石板数
  const CELL = S / N;       // 16
  const rng = makeRng(seed);

  // 每块石板一个明度偏移 —— 「块与块之间的差异」才是质感来源
  const level = [];
  for (let i = 0; i < N * N; i++) level.push((rng() - 0.5) * 0.075);

  return pixelTexture((x, y) => {
    const gx = Math.floor(x / CELL);
    const gy = Math.floor(y / CELL);
    const idx = gy * N + gx;
    const lx = x % CELL;
    const ly = y % CELL;

    // 缝隙：统一暗线。宽度 1texel刚好在像素化后保持为一条细线。
    if (lx === 0 || ly === 0) {
      const l = baseL - 0.155;
      return hsl(hue + 2, sat * 0.9, l);
    }

    // 石板内部：低频明暗（两个方向的缓变叠加，看起来像自然的磨损）
    const u = lx / CELL;
    const v = ly / CELL;
    const grain =
      Math.sin(u * 2.1 + idx * 1.7) * 0.016 +
      Math.sin(v * 2.6 + idx * 2.3) * 0.013;

    // 边缘微暗：让每块石板有一点点倒角，读作"有厚度的石块"
    const edge = (lx === 1 || ly === 1) ? -0.012 : 0;

    const l = baseL + level[idx] + grain + edge;
    return hsl(hue + (idx % 3) * 1.5, sat, Math.max(0.05, Math.min(0.92, l)));
  });
}

/**
 * 大块铺装 —— 用于广场主面板。
 *
 * 与 stonePaving 的区别：格子更大（2×2）、明度差更大、缝隙更浅。
 * 目的是让广场与码头底层地面在**明度上明确分层**，喷泉的暖白石才有底。
 */
export function largeFlagstone({ seed = 21, hue = 30, sat = 0.13, baseL = 0.52 } = {}) {
  const S = 64;
  const N = 2;
  const CELL = S / N;
  const rng = makeRng(seed);
  const level = [];
  for (let i = 0; i < N * N; i++) level.push((rng() - 0.5) * 0.085);

  return pixelTexture((x, y) => {
    const gx = Math.floor(x / CELL);
    const gy = Math.floor(y / CELL);
    const idx = gy * N + gx;
    const lx = x % CELL;
    const ly = y % CELL;

    if (lx === 0 || ly === 0) return hsl(hue, sat * 0.85, baseL - 0.12);

    const u = lx / CELL, v = ly / CELL;
    const grain = Math.sin(u * 1.9 + idx * 2.2) * 0.02 + Math.sin(v * 2.2 + idx) * 0.016;
    // 每块中心提亮一点，制造"中间被磨光"的直觉
    const dome = (0.5 - Math.abs(u - 0.5)) * (0.5 - Math.abs(v - 0.5)) * 0.05;
    const l = baseL + level[idx] + grain + dome;
    return hsl(hue, sat, Math.max(0.05, Math.min(0.92, l)));
  });
}

/* ================================================================== */
/*  沙地                                                                */
/* ================================================================== */

/**
 * 沙滩 —— 必须是**极低频**的。
 * 之前用 sand_random，repeat 13，在像素化下整片岸线读作"脏沙"。
 * 这里改成：底色 + 三四个大尺度柔和斑块 + 极少量的亮点。
 */
export function sandFlat({ seed = 33, hue = 40, sat = 0.30, baseL = 0.76 } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  // 5 个低频斑点中心
  const blobs = [];
  for (let i = 0; i < 5; i++) {
    blobs.push({
      x: rng() * S, y: rng() * S,
      r: 14 + rng() * 20,
      d: (rng() - 0.5) * 0.07
    });
  }
  // 极少量亮点（贝壳/反光），控制在 3% 面积以内
  const sparkles = [];
  for (let i = 0; i < 8; i++) sparkles.push({ x: rng() * S, y: rng() * S });

  return pixelTexture((x, y) => {
    let l = baseL;
    for (const b of blobs) {
      const dx = x - b.x, dy = y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < b.r) {
        // smoothstep 衰减，避免出现圆形边界
        const t = 1 - dist / b.r;
        l += b.d * t * t * (3 - 2 * t);
      }
    }
    // 沿岸线方向的一道更亮的带（浪花退去后的湿沙高光）
    l += Math.cos((y / S) * Math.PI * 2) * 0.012;

    let rgb = hsl(hue, sat, Math.max(0.05, Math.min(0.95, l)));
    for (const s of sparkles) {
      if (Math.abs(x - s.x) < 1 && Math.abs(y - s.y) < 1) {
        rgb = hsl(hue - 6, sat * 0.6, Math.min(0.95, l + 0.14));
      }
    }
    return rgb;
  });
}

/* ================================================================== */
/*  屋顶                                                                */
/* ================================================================== */

/**
 * 陶瓦屋顶 —— 竖向瓦垄。
 *
 * 之前用 roof_clay_red_center 配 repeat=round(w/4)，但那张贴图是随机红噪点，
 * 读不出"瓦"。这里画真正的瓦：每 8 texel 一垄，每垄左侧一道暗缝、
 * 右侧一道高光，形成明确的圆柱感。像素化后每垄约2 个像素块宽，
 * 正好读作"一排瓦"。
 */
export function clayTiles({ seed = 51, hue = 14, sat = 0.42, baseL = 0.46 } = {}) {
  const S = 64;
  const P = 8;                // 每垄宽度
  const rng = makeRng(seed);
  const rowShift = [];
  for (let i = 0; i < S / P; i++) rowShift.push(Math.floor(rng() * 3));

  return pixelTexture((x, y) => {
    const col = Math.floor(x / P);
    const lx = x % P;
    const row = Math.floor(y / P);
    // 横向瓦缝：每隔 P 个 texel 一道，把竖垄切成上下叠置的瓦片
    const ly = y % P;

    const wobble = ((rowShift[(col + row) % rowShift.length] + row) % 3) - 1;

    let l = baseL;
    if (lx === 0) l -= 0.13;                      // 垄间暗缝
    else l += Math.sin((lx / P) * Math.PI) * 0.085; // 圆弧高光
    if (ly === 0) l -= 0.055;                     // 瓦片横向接缝

    l += wobble * 0.022;                          // 每垄/每排的轻微色差
    return hsl(hue + (col % 3) * 1.8, sat, Math.max(0.04, Math.min(0.9, l)));
  });
}

/* ================================================================== */
/*  墙面                                                                */
/* ================================================================== */

/**
 * 灰泥墙 —— 需要**大尺度不均匀**，但不能是噪点。
 *
 * 做法：3~4 个大圆斑（低频）+ 底部的渐暗（雨痕）+ 极轻的颗粒。
 * 关键是没有逐像素随机 —— 整个墙面读作"一面墙"，而不是"一堆点"。
 */
export function plasterWall({ seed = 77, hue = 36, sat = 0.10, baseL = 0.86 } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  const patches = [];
  for (let i = 0; i < 4; i++) {
    patches.push({
      x: rng() * S, y: rng() * S,
      r: 16 + rng() * 22,
      d: (rng() - 0.5) * 0.06
    });
  }

  return pixelTexture((x, y) => {
    let l = baseL;
    for (const p of patches) {
      const dx = x - p.x, dy = y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < p.r) {
        const t = 1 - dist / p.r;
        l += p.d * t * t * (3 - 2 * t);
      }
    }
    // 底部渐暗：让墙面自带"接地感"，不再需要额外的 AO 也读得出重量
    l -= (y / S) * 0.055;
    // 顶部轻微提亮（受天光）
    l += Math.max(0, 1 - y / (S * 0.4)) * 0.02;
    return hsl(hue + 2, sat, Math.max(0.05, Math.min(0.96, l)));
  });
}

/**
 * 石砌墙 —— 用于花坛边沿、喷泉、礁石。
 * 与石板铺装的区别：块更小更不规则，且块内几乎无渐变（砌石的读法）。
 */
export function stoneBlocks({ seed = 91, hue = 32, sat = 0.11, baseL = 0.66 } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  // 8 行错缝砌法
  const rowH = 8;
  const rows = S / rowH;
  const levels = [];
  for (let i = 0; i < 40; i++) levels.push((rng() - 0.5) * 0.085);

  return pixelTexture((x, y) => {
    const row = Math.floor(y / rowH);
    const offset = (row % 2) * 6;      // 错缝：每行水平偏移 6 texel
    const bx = Math.floor(((x + offset) % S) / 12);
    const by = row;
    const idx = (by * 8 + bx) % 40;

    const px = (x + offset) % 12;
    const py = y % rowH;

    // 砂浆缝
    if (px === 0 || py === 0) return hsl(hue, sat * 0.8, baseL - 0.145);

    // 顶部受光、底部落影 —— 砌石块体感的关键
    let l = baseL + levels[idx];
    l += (1 - py / rowH) * 0.035 - 0.018;
    return hsl(hue + (idx % 4) * 1.2, sat, Math.max(0.05, Math.min(0.94, l)));
  });
}

/* ================================================================== */
/*  木                                                                  */
/* ================================================================== */

/** 木板 —— 竖向板缝 + 低频木纹条。用于栈桥、木箱、门。 */
export function woodPlanks({ seed = 63, hue = 28, sat = 0.30, baseL = 0.56, vertical = true } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  const P = 8;
  const levels = [];
  const grains = [];
  for (let i = 0; i < 32; i++) {
    levels.push((rng() - 0.5) * 0.08);
    grains.push(rng());
  }

  return pixelTexture((x, y) => {
    const a = vertical ? x : y;   // 板缝方向
    const b = vertical ? y : x;
    const idx = Math.floor(a / P);
    const la = a % P;
    const lb = b % S;

    let l = baseL + levels[idx % 32];
    if (la === 0) l -= 0.16;                       // 板缝
    // 木纹：沿板长方向的 2~3 条缓变暗纹
    const g = grains[idx % 32];
    const w = Math.sin((lb / S) * Math.PI * (2 + g * 2) + g * 6.0) * 0.022;
    l += w;

    return hsl(hue + (idx % 3) * 2, sat, Math.max(0.04, Math.min(0.9, l)));
  });
}

/* ================================================================== */
/*  草地 / 树冠                                                         */
/* ================================================================== */

/**
 * 草地色板 —— 用于远处草坡/花坛泥土的低频底。
 * 不做逐叶噪声，只做柔和的明暗簇，让大面积绿色有呼吸感。
 */
export function grassPatch({ seed = 111, hue = 96, sat = 0.30, baseL = 0.44 } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  const blobs = [];
  for (let i = 0; i < 7; i++) {
    blobs.push({ x: rng() * S, y: rng() * S, r: 10 + rng() * 16, d: (rng() - 0.5) * 0.10 });
  }
  return pixelTexture((x, y) => {
    let l = baseL;
    for (const b of blobs) {
      const dx = x - b.x, dy = y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < b.r) {
        const t = 1 - dist / b.r;
        l += b.d * t * t * (3 - 2 * t);
      }
    }
    return hsl(hue, sat, Math.max(0.04, Math.min(0.92, l)));
  });
}

/**
 * 树冠贴图 —— 低频叶簇。
 * 用 4~5 个大叶簇（每簇一个色偏），而不是逐像素的叶点噪声。
 * 树冠在画面里是纯色剪影，贴图只负责让绿色内部有层次。
 */
export function leafCanopy({ seed = 133, hue = 104, sat = 0.34, baseL = 0.40 } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  const clusters = [];
  for (let i = 0; i < 9; i++) {
    clusters.push({
      x: rng() * S, y: rng() * S, r: 9 + rng() * 13,
      dh: (rng() - 0.5) * 10,
      dl: (rng() - 0.5) * 0.11
    });
  }
  return pixelTexture((x, y) => {
    let h = hue, l = baseL;
    for (const c of clusters) {
      const dx = x - c.x, dy = y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < c.r) {
        const t = 1 - dist / c.r;
        const s = t * t * (3 - 2 * t);
        h += c.dh * s;
        l += c.dl * s;
      }
    }
    return hsl(h, sat, Math.max(0.03, Math.min(0.9, l)));
  });
}

/* ================================================================== */
/*  水面                                                                */
/* ================================================================== */

/**
 * 水面法线高度图 —— 低频起伏。
 * 用于给水面做折射扰动。之前水面是纯色，读作"一块蓝塑料"。
 */
export function waterHeight({ seed = 151 } = {}) {
  const S = 64;
  const rng = makeRng(seed);
  const waves = [];
  for (let i = 0; i < 6; i++) {
    waves.push({
      fx: 1 + rng() * 3,
      fy: 1 + rng() * 3,
      px: rng() * Math.PI * 2,
      py: rng() * Math.PI * 2,
      a: 0.2 + rng() * 0.3
    });
  }
  return pixelTexture((x, y) => {
    let v = 0;
    for (const w of waves) {
      v += Math.sin((x / S) * Math.PI * 2 * w.fx + w.px) *
            Math.sin((y / S) * Math.PI * 2 * w.fy + w.py) * w.a;
    }
    const l = 128 + v * 90;
    return [Math.max(0, Math.min(255, Math.round(l))), 0, 0];
  });
}