/**
 * 程序化生成角色像素精灵图
 *
 * 为什么必须程序化生成：
 *   itch.io 在本环境不可访问（页面 goto 超时），无法下载现成精灵图。
 *   好处是完全可控 —— 能精确匹配低分辨率像素网格与 HD-2D 色板。
 *
 * 实现方式：用 fillRect 精确摆放每个身体部件（比字符点阵更易维护/调整），
 * 最后统一描一圈深色轮廓 —— HD-2D 的角色必须有硬边描边才 readable。
 *
 * 精灵图布局：8 方向 × 每方向 6 帧。
 *   行 = 方向 (0..7)，列 = 帧 (0..5)
 *   dir:   0=下 1=下右 2=右 3=上右 4=上 5=上左 6=左 7=下左
 *   frame: 0-1 = idle，2-5 = walk cycle
 *   单元格 16x16，角色占约 12x14，脚底在第 14 行
 */

/** 单格像素尺寸 */
export const CELL = 16;

/** 8 方向 */
export const DIRS = 8;

/** 每方向帧数 */
export const FRAMES_PER_DIR = 6;

/** 走路动画起始帧 */
export const WALK_START = 2;

/** 走路动画速度（帧/秒） */
export const WALK_FPS = 9;

/** 深色轮廓色 —— HD-2D 角色的硬边描边 */
const OUTLINE = '#2a2230';

/** HD-2D 风格配色：高明度、宝石色调 */
export const PALETTES = {
  hero: {
    name: '旅人',
    hair: '#4a3428', skin: '#f5cfa8', skinShade: '#e0ab80',
    coat: '#2f6fb5', coatLit: '#4f95da', coatShade: '#204c7e',
    pants: '#3b4054', pantsShade: '#282c3a',
    boot: '#4a3428', accent: '#f5c451', eye: '#2b2436'
  },
  npcFisher: {
    name: '渔夫',
    hair: '#8a6a3a', skin: '#eabd95', skinShade: '#cf9b74',
    coat: '#4a9c7a', coatLit: '#69bc96', coatShade: '#32705a',
    pants: '#5c5241', pantsShade: '#3f382a',
    boot: '#3a2c1e', accent: '#e8dcc0', eye: '#2b2436'
  },
  npcGuard: {
    name: '卫兵',
    hair: '#33333d', skin: '#daaa7a', skinShade: '#b98a5c',
    coat: '#8d4040', coatLit: '#ab5858', coatShade: '#642c2c',
    pants: '#3f4552', pantsShade: '#2c313b',
    boot: '#2f2921', accent: '#ccd2da', eye: '#2b2436'
  },
  npcChild: {
    name: '孩童',
    hair: '#c87f42', skin: '#f6d6b3', skinShade: '#ddb48d',
    coat: '#e07f9d', coatLit: '#f29fb6', coatShade: '#a85a74',
    pants: '#6d7cb2', pantsShade: '#4f5b93',
    boot: '#5c4632', accent: '#ffeaa8', eye: '#2b2436'
  }
};

const px = (ctx, x, y, w, h, color) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};

/** 朝向特征 */
function flags(dir) {
  return {
    isBack: dir >= 3 && dir <= 5,
    isSide: dir === 2 || dir === 6,
    isDiag: dir === 1 || dir === 5 || dir === 7,
    side: dir === 6 ? -1 : 1// 左向翻转用
  };
}

/**
 * 绘制单帧到16x16 单元格（原点 ox, oy）。
 * @param legPhase -1/0/1 走路腿部相位；0 为并腿
 * @param bob 垂直位移（像素）
 */
function drawFrame(ctx, ox, oy, dir, pal, legPhase, bob) {
  const f = flags(dir);
  const y = oy + bob;

  // 腿（先画，之后被外套下摆遮住上端）
  drawLegs(ctx, ox, y, pal, legPhase, f);

  // 躯干 + 手臂
  drawTorso(ctx, ox, y, pal, f);

  // 头
  drawHead(ctx, ox, y, pal, f);
}

function drawLegs(ctx, ox, y, pal, legPhase, f) {
  const hipY = y + 11;  // 腿起始行（躯干 7..10，下摆 11）
  const legH = 3;

  if (f.isSide) {
    // 侧向：双腿前后错开
    const front = legPhase >= 0 ? 1 : 0;
    px(ctx, ox + 5, hipY, 3, legH, pal.boot);
    px(ctx, ox + 5, hipY, 3, 1, pal.pants);
    const bx = legPhase > 0 ? 3 : 6;
    px(ctx, ox + bx, hipY, 3, legH, pal.pantsShade);
    px(ctx, ox + bx, hipY + legH - 1, 3, 1, pal.boot);
    return;
  }

  if (legPhase > 0) {
    // 左腿前：左腿亮、右腿暗且下移
    px(ctx, ox + 4, hipY, 3, legH, pal.pants);
    px(ctx, ox + 4, hipY + legH - 1, 3, 1, pal.boot);
    px(ctx, ox + 8, hipY + 1, 3, legH - 1, pal.pantsShade);
  } else if (legPhase < 0) {
    px(ctx, ox + 4, hipY + 1, 3, legH - 1, pal.pantsShade);
    px(ctx, ox + 8, hipY, 3, legH, pal.pants);
    px(ctx, ox + 8, hipY + legH - 1, 3, 1, pal.boot);
  } else {
    px(ctx, ox + 4, hipY, 3, legH, pal.pants);
    px(ctx, ox + 8, hipY, 3, legH, pal.pants);
    px(ctx, ox + 4, hipY + legH - 1, 3, 1, pal.boot);
    px(ctx, ox + 8, hipY + legH - 1, 3, 1, pal.boot);
  }
}

function drawTorso(ctx, ox, y, pal, f) {
  const top = y + 7;    // 肩部行
  const h = 4;

  if (f.isSide) {
    px(ctx, ox + 4, top, 6, h, pal.coat);
    px(ctx, ox + 5, top, 4, 1, pal.coatLit);
    px(ctx, ox + 4, top + h - 1, 6, 1, pal.coatShade);
    // 外套下摆
    px(ctx, ox + 3, top + h - 1, 8, 1, pal.coatShade);
    // 手臂（侧向：一前一后）
    px(ctx, ox + 3, top + 1, 2, 2, pal.coatShade);
    px(ctx, ox + 9, top + 1, 2, 2, pal.coat);
    return;
  }

  // 正面/背面/斜向
  px(ctx, ox + 3, top, 10, h, pal.coat);
  px(ctx, ox + 4, top, 8, 1, pal.coatLit);          // 肩部受光
  px(ctx, ox + 3, top + h - 1, 10, 1, pal.coatShade);
  // 下摆略微外扩
  px(ctx, ox + 2, top + h - 1, 12, 1, pal.coatShade);

  // 手臂（两侧下垂，略深）
  px(ctx, ox + 2, top + 1, 2, 3, pal.coatShade);
  px(ctx, ox + 12, top + 1, 2, 3, pal.coatShade);
  px(ctx, ox + 2, top + 3, 2, 1, pal.skin);        // 手
  px(ctx, ox + 12, top + 3, 2, 1, pal.skin);

  // 正面：胸口扣子/领口点缀
  if (!f.isBack) {
    px(ctx, ox + 7, top + 1, 2, 2, pal.accent);
  }
}

function drawHead(ctx, ox, y, pal, f) {
  const top = y;       // 头顶行

  if (f.isBack) {
    // 背面：整颗头都是头发
    px(ctx, ox + 4, top, 8, 3, pal.hair);
    px(ctx, ox + 3, top + 2, 10, 4, pal.hair);
    px(ctx, ox + 4, top + 5, 8, 2, pal.hair);
    return;
  }

  if (f.isSide) {
    // 侧向：脸偏向朝向方向，露出一侧眼
    const s = f.side;   // +1 右, -1 左
    px(ctx, ox + 4, top, 8, 3, pal.hair);           // 头发顶部
    px(ctx, ox + 4, top + 2, 8, 4, pal.skin);       // 脸
    px(ctx, ox + 4, top + 2, 8, 1, pal.hair);       // 刘海
    // 后脑头发
    px(ctx, ox + (s > 0 ? 4 : 9), top + 2, 3, 4, pal.hair);
    // 眼
    px(ctx, ox + (s > 0 ? 8 : 6), top + 4, 1, 1, pal.eye);
    px(ctx, ox + 4, top + 5, 8, 2, pal.skin);
    return;
  }

  // 正面/斜向
  px(ctx, ox + 4, top, 8, 3, pal.hair);             // 顶部头发
  px(ctx, ox + 3, top + 2, 10, 4, pal.skin);        // 脸
  px(ctx, ox + 3, top + 2, 10, 1, pal.hair);        // 刘海
  // 两侧鬓发
  px(ctx, ox + 3, top + 3, 1, 3, pal.hair);
  px(ctx, ox + 12, top + 3, 1, 3, pal.hair);
  px(ctx, ox + 4, top + 5, 8, 2, pal.skin);         // 下巴
  // 眼
  px(ctx, ox + 6, top + 3, 1, 2, pal.eye);
  px(ctx, ox + 9, top + 3, 1, 2, pal.eye);
}

/**
 * 给已画好的单元格加深色描边：对所有与不透明像素相邻的透明像素填描边色。
 * 这样无论各部件怎么画，都有一致的硬边轮廓。
 */
function addOutline(ctx, cell) {
  const img = ctx.getImageData(0, 0, cell, cell);
  const d = img.data;
  const opaque = (x, y) => {
    if (x < 0 || y < 0 || x >= cell || y >= cell) return true; // 格外视为实心，避免贴边丢失描边
    return d[(y * cell + x) * 4 + 3] > 10;
  };

  const snapshot = new Uint8Array(cell * cell);
  for (let i = 0; i < cell * cell; i++) snapshot[i] = d[i * 4 + 3] > 10 ? 1 : 0;

  const [r, g, b] = [
    parseInt(OUTLINE.slice(1, 3), 16),
    parseInt(OUTLINE.slice(3, 5), 16),
    parseInt(OUTLINE.slice(5, 7), 16)
  ];

  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const i = y * cell + x;
      if (snapshot[i]) continue;
      const near =
        (x > 0 && snapshot[i - 1]) ||
        (x < cell - 1 && snapshot[i + 1]) ||
        (y > 0 && snapshot[i - cell]) ||
        (y < cell - 1 && snapshot[i + cell]);
      if (near) {
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 生成精灵图 canvas。
 * @param {object} pal PALETTES 中的一套配色
 * @param {number} cell 单格像素尺寸
 */
export function generateSpriteSheet(pal, cell = CELL) {
  const canvas = document.createElement('canvas');
  canvas.width = cell * FRAMES_PER_DIR;
  canvas.height = cell * DIRS;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  for (let d = 0; d < DIRS; d++) {
    for (let f = 0; f < FRAMES_PER_DIR; f++) {
      let legPhase = 0;
      let bob = 0;
      if (f >= WALK_START) {
        const w = (f - WALK_START) % 4;
        legPhase = [0, 1, 0, -1][w];
        bob = [0, -1, 0, -1][w];
      } else {
        // idle：2 帧轻微呼吸
        bob = f === 1 ? -1 : 0;
      }

      // 逐格绘制到临时画布再描边（避免描边溢出污染相邻格）
      const tmp = document.createElement('canvas');
      tmp.width = tmp.height = cell;
      const tctx = tmp.getContext('2d');
      tctx.imageSmoothingEnabled = false;
      drawFrame(tctx, 1, 0, d, pal, legPhase, bob);
      addOutline(tctx, cell);

      ctx.drawImage(tmp, f * cell, d * cell);
    }
  }
  return canvas;
}

/** 根据移动向量算出 0..7 的方向索引（0=南/朝向相机，逆时针） */
export function dirFromVector(dx, dz) {
  const ang = Math.atan2(dx, dz);
  let idx = Math.round(ang / (Math.PI / 4));
  if (idx < 0) idx += 8;
  return idx % 8;
}