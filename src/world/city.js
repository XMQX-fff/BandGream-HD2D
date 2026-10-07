/**
 * 程序化城区生成器 —— 地图从 28×26扩到 280×260 的内容来源
 * ============================================================================
 *
 * 【为什么必须有这个文件，而不能只放大地面】
 * 第一版扩图只把地面 PlaneGeometry 乘 10，结果玩家走出去看到的是
 * 一大片空荡荡的石板地 —— 地图「变大」了，但内容没变，
 * 视觉上读作「未完成的空场景」。
 *
 * 硬编码坐标乘 10 也不行：现有 118 个道具坐标（建筑、路灯、长椅、树…）
 * 全部落在 |X| <= 45 的范围内，等比铺开会让它们稀疏地散在
 * 1400×1200 的空地上，密度降到原来的 1/100，比空地更糟。
 *
 * 正确做法是**保留现有港区作为核心区，向外程序化生成街区**。
 *
 * ============================================================================
 *  设计原则
 * ============================================================================
 *
 * 1. **确定性（固定 seed）**
 *    伪随机数用固定种子，不用 Math.random()。
 *    否则每次刷新页面城镇布局都不同，玩家会失去空间记忆 ——
 *    这是导航体验的根基，不是可有可无的细节。
 *
 * 2. **街道网格 + 街区地块**
 *    按 BLOCK × BLOCK 的网格切分地图，每块内部生成若干房屋，
 *    块与块之间留出街道。街道宽度必须大于建筑间距，
 *    否则整片城区读作「一堆挤在一起的盒子」。
 *
 * 3. **三层细节分级（对应拾取问题的 LOD 建议）**
 *    近区（玩家周围）：完整房屋 + 门窗 + 屋顶 + 院子杂物
 *    中区：房屋 + 简化屋顶
 *    远区：只有体块 + 屋顶剪影，颜色偏向雾色
 *    分级按**到中心的距离**静态决定（不做动态切换）——
 *    动态 LOD 在像素化画面里会因为物体突然出现/消失而「闪」，
 *    比性能损失更难看。
 *
 * 4. **配色沿用现有约定**
 *    墙体：暖白/ 米黄系（与现有港区一致）
 *    屋顶：赭红系
 *    远景：高明度、低饱和的暖白（靠雾拉开层次，不靠压深）
 *    最后一条是现有代码里踩过的坑，远景建筑本体压深会被雾混成脏灰。
 *
 * 5. **留出中央大道**
 *    从码头（Z 小）到内陆（Z 大）有一条贯通的主街，
 *    玩家沿主街能一路向北，符合「港口城市」的空间逻辑，
 *    也让玩家在超大地图里不会迷路。
 */

import { Group, Mesh, BoxGeometry, PlaneGeometry, MeshStandardMaterial } from 'three';
import { initHD2D } from './textures.js';
import * as HD2D_GEN from './hd2dTextures.js';
import { createTree, createLampPost, createBarrel, createCrate, createPlanter } from './props.js';

const HD2D = initHD2D(HD2D_GEN);

// --------------------------------------------------------------------------
//  确定性伪随机（mulberry32）—— 固定 seed，保证每次布局一致
// --------------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20240517);
const rand = (a, b) => a + rng() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

// --------------------------------------------------------------------------
//  配色
// --------------------------------------------------------------------------
// 墙：暖白到米黄。全部高明度低饱和 —— OT2 的建筑本体是浅色的，
// 立体感靠「亮面 / 暗面」而不是「本体压深」。
const WALL_TINTS = [
  0xfaf4e8, 0xf2e8d4, 0xfdf8ec, 0xf6ecda, 0xf8f0e0,
  0xfcf4e4, 0xf4ecdc, 0xfdf6e8, 0xf6f0e2, 0xf2eee2
];
// 屋顶：赭红系，和地面暖米色、树叶绿形成色相分离
const ROOF_TINTS = [
  0xfff4ec, 0xf6e2d2, 0xfffaf4, 0xf8e6da, 0xffeede,
  0xf6e6d8, 0xfff8f0, 0xf2ddd0, 0xffe8dc, 0xf8f0e4
];
// 远景：偏雾色（高明度低饱和），靠雾拉开层次
const FAR_TINTS = [0xe6d8c2, 0xe8dcc6, 0xe4d6be, 0xe6d8c2, 0xe2d4ba];

// --------------------------------------------------------------------------
//  材质共享池
// --------------------------------------------------------------------------
// 【这一节是性能的关键，不是风格选择】
// 第一版每栋房子都 `new MeshStandardMaterial(...)`。
// 而 optimize.js 的 mergeStatics 是**按材质对象分桶合并**的 ——
// 材质对象不共享，就永远落在 `group.length === 1` 分支里各自成 mesh，
// 一栋房子一个 draw call。城区 2000 栋 = 2000 次绘制调用，
// 帧率直接崩掉。
//
// 正确做法：所有墙共用 10 个材质对象（对应 10 种墙色），
// 所有屋顶共用 10 个。这样mergeStatics 能把它们各自合并成 20 个大mesh，
// 2000 栋房子只产生 20 次绘制调用。
//
// 材质数量是**故意限制**在 20 个的：这是「draw call 数量」与
// 「色彩变化幅度」的取舍点。OT2 远景的房屋色差本身很微妙，
// 10 色已经足够读出「这是一片有变化的城区」。
const WALL_MATS = WALL_TINTS.map(c => {
  const m = new MeshStandardMaterial({ color: c, roughness: 0.92, metalness: 0.0 });
  m.color.setHex(c);
  return m;
});
const ROOF_MATS = ROOF_TINTS.map(c => {
  const m = new MeshStandardMaterial({ color: c, roughness: 0.88, metalness: 0.0 });
  m.color.setHex(c);
  return m;
});
const FAR_MATS = FAR_TINTS.map(c => {
  const m = new MeshStandardMaterial({ color: c, roughness: 0.95, metalness: 0.0 });
  m.color.setHex(c);
  return m;
});
const TRIM_MAT = (() => {
  const m = new MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.8, metalness: 0.0 });
  m.color.setHex(0x6b4a32);
  return m;
})();

// --------------------------------------------------------------------------
//  细节分级
// --------------------------------------------------------------------------
export const LOD_NEAR = 0;   // 完整：墙 + 屋顶 + 门窗 + 院子杂物
export const LOD_MID  = 1;   // 中景：墙 + 屋顶，无门窗
export const LOD_FAR  = 2;   // 远景：单一体块，偏雾色

/**
 * 单栋房屋
 * @param {number} x @param {number} z 中心坐标
 * @param {number} w宽（X） @param {number} d 深（Z） @param {number} h 墙高
 * @param {number} roofH 屋顶高
 * @param {number} lod 细节级
 * @param {boolean} faceSouth 正面是否朝+Z（面向玩家的默认朝向）
 */
function makeHouse(x, z, w, d, h, roofH, lod, faceSouth = true) {
  const g = new Group();

  // 材质取自共享池（见上方说明）——绝不能在这里 new
  const wallMat = lod === LOD_FAR ? pick(FAR_MATS) : pick(WALL_MATS);
  const roofMat = lod === LOD_FAR ? pick(FAR_MATS) : pick(ROOF_MATS);

  // 墙
  const walls = new Mesh(new BoxGeometry(w, h, d), wallMat);
  walls.position.set(0, h / 2, 0);
  walls.castShadow = lod !== LOD_FAR;
  walls.receiveShadow = true;
  g.add(walls);

  // 屋顶：略大于墙体的斜盒
  const roof = new Mesh(new BoxGeometry(w * 1.12, roofH, d * 1.12), roofMat);
  roof.position.set(0, h + roofH / 2, 0);
  roof.castShadow = lod !== LOD_FAR;
  g.add(roof);

  // 门窗只在中近景做
  //
  // ===================================================================
  // 【朝向：这一处改了三轮才对，过程值得记下来】
  // ===================================================================
  // 第 1 轮：门贴 +Z 面（朝南），靠 faceSouth 翻转。
  //   问题：主街两侧的房子 x 在 40±15，门朝 ±X 才朝街；
  //         朝 +Z 的话两侧的房子门都朝着街道的延长线，读作「背街」。
  //
  // 第 2 轮：门贴 ±X 面（朝街）。
  //   问题：**相机根本看不到**。相机固定在玩家 +Z 侧俯视，
  //         画面里能看到的是屋顶和 +Z 那一面，
  //         ±X 侧面只在画面最边缘露出一点斜角，
  //         门窗贴在上面等于白做 —— 实测门窗生成 69 处，画面里一个都看不到。
  //
  // 第 3 轮（本轮）：门贴 +Z 面，且**不依赖街的朝向**。
  //   理由：这是斜俯视构图，玩家看到的永远是「朝自己的一面」。
  //   房屋朝向街是「逻辑正确」，但在固定俯角下玩家看不到那一面；
  //   OT2 的做法是把门和窗做在**朝向相机的那一面**，
  //   靠房屋的旋转 + 立体屋顶制造「这是临街面」的感觉。
  //
  //   所以 faceSouth 的语义改为：房屋整体是否背朝相机（用于轻微转身），
  //   门窗则统一贴在 +Z（朝向相机）。
  // ===================================================================
  if (lod === LOD_NEAR) {
    // 【尺寸要够大才看得见】
    // 斜俯视角下，门窗是「贴在墙上的小块凸起」，
    // 原来的门 w*0.22 ≈ 1.5 单位在 30 单位外只有几个像素，读不出来。
    // 放大到 w*0.34 / h*0.55，门在画面里才有可辨识的深色块。
    const door = new Mesh(new BoxGeometry(w * 0.34, h * 0.55, 0.16), TRIM_MAT);
    door.position.set(0, h * 0.275, d / 2 + 0.04);
    g.add(door);

    // 窗：门两侧各一扇，分开布局，避免读作「一个带洞的方块」
    for (const sx of [-w * 0.3, w * 0.3]) {
      const win = new Mesh(new BoxGeometry(w * 0.22, h * 0.3, 0.14), TRIM_MAT);
      win.position.set(sx, h * 0.6, d / 2 + 0.04);
      g.add(win);
    }

    // 檐口线：一条横向深色带，把墙和屋顶分开。
    // 【为什么必须有这一条】
    // 墙是暖白、顶是赭红，斜俯视下屋顶占面积最大，
    // 两者之间如果没有过渡，整栋房子读作「一个色块+ 一个色块」；
    // 加一道深色檐线后立刻能读出「墙 / 屋檐 / 屋顶」三层结构，
    // 这是 OT2 建筑读得清的关键细节，成本只有 12 个三角面。
    const eave = new Mesh(new BoxGeometry(w * 1.08, h * 0.055, d * 1.08), TRIM_MAT);
    eave.position.set(0, h - h * 0.02, 0);
    g.add(eave);
  }

  g.position.set(x, 0, z);
  // 轻微朝向偏转：整片房子绝对平行会读作「复制粘贴」
  g.rotation.y = rand(-0.08, 0.08);
  return g;
}

/**
 * 生成整座外围城区
 * @param {object} WORLD WORLD 常量
 * @param {number} coreHalf 核心区半宽（现有港区占|X| <= coreHalf）
 */
export function createOutskirts(WORLD, coreHalf = 50) {
  const group = new Group();
  group.name = 'outskirts';

  const B = WORLD.bounds;
  // ==========================================================================
  //  街区尺寸 —— 密度参数，也是「玩家能不能看见房子」的决定因素
  // ==========================================================================
  // 【第一版 BLOCK=46 是严重错误，实测只生成 41 栋房子】
  // 280×260 的地图按 46 切格只能得到 6×5 = 30 个格子，
  // 再被「靠海侧 / 核心区 / 主街」三个过滤条件砍掉大半，
  // 最终整张 7.3 万单位的地图上只有 41 栋房。
  //
  // 【第二版 BLOCK=22 仍然错：房子生成了，但一栋都看不见】
  // 相机 fov=30°、distance=27，在玩家所在深度只能看到
  //   半宽 = 27 × tan(15°) × aspect(1.6) ≈ 11.6 单位
  // 而第二版要求 |hx - 40| > STREET+2 = 11 才放房子 ——
  // 房子恰好全部落在 ±11.6 的可视边界之外，
  // 视锥数学判定：主街南段/北段/城区西北三个机位，视野内房屋数全为 0。
  //
  // 根因：**把「街区密度」和「相机可视范围」当成了两个独立参数**。
  // 它们必须挂钩 —— 建筑必须紧贴街道边缘，玩家才看得到它。
  //
  // 现在的做法：
  //   街宽 STREET=9（半宽 9，全宽 18）→ 建筑贴在 |hx-40| > 11 处，
  //   即紧贴路缘外 2 单位，正好落在可视区内。
  //   街区 BLOCK=20，格内 1~2 栋，抖动 ±5.6 —— 保证连续沿街面。
  const STREET = 9;
  const BLOCK = 20;

  // ============ 网格化街区布局 ============
  //
  // 【第一版用的是「沿矩形周长参数化取点」，那个算法有两个致命 bug】
  //   bug 1：周长算成 `2*(halfW+halfD)*2`，多乘了一个 2。
  //          边长各半 w 的矩形周长是 4*halfW + 4*halfD，不是 8*(halfW+halfD)。
  //          点数因此多了一倍，且全挤在最后一条边上。
  //   bug 2：更根本的问题是「环形」本身就不适合这个地图。
  //          地图是 280×260 的**矩形**，套正方形环意味着
  //          四角外的区域（X 远大于 Z 的地方）永远生成不到内容。
  //          实测：主角站在主街北段 (40,200)，左右两侧空空如也 ——
  //          那里根本不在任何一环上。
  //
  // 改法：直接按**矩形网格**布点。这与「矩形地图」是同构的，
  // 不存在角落漏生成的问题，密度也可直接控制。
  // ==========================================================================
  //  主街两侧的沿街建筑
  // ==========================================================================
  // 【这是本次返工最关键的一处改动：散点网格 → 沿街排布】
  //
  // 前两版都用「矩形网格里随机撒点」，失败的原因不是密度，是**拓扑**：
  // 随机撒点产生的是「郊区别墅」，玩家沿街走时两侧是随机空隙，
  // 读不出「这是一条街」。真正的城镇长这样：
  //
  //   · 建筑**贴着路缘**连续排列，中间不留随机大空隙
  //   · 街道是**网格状**的（不只是南北一条主街，还有东西向的横街）
  //
  // 所以这里改成：主街两侧各排一列房子，间距 13~17 单位；
  // 再按 BLOCK=48 的节奏插入东西向横街，把主街之外的区域也切成街区。
  // 这样无论玩家站在主街还是横街上，两侧都有贴街建筑。
  //
  // 【间距为什么是 13~17】
  // 房子宽 6~8，间距 13~17 意味着房子之间留 5~9 单位 —
  // 读作「各家之间有小院/小巷」，正是港口小镇的密度。
  const streetRow = (xSide, zFrom, zTo) => {
    // 【faceSouth 的语义】true = 街在 -X 侧，即这排房子位于主街东边。
    // 主街在 x=40：东侧房子（x>40）朝西开门，西侧房子朝东开门。
    const faceSouth = xSide < MAIN_STREET_X;
    let z = zFrom + rand(0, 8);
    while (z < zTo) {
      const hw = rand(6.0, 8.0);
      const hd = rand(5.5, 7.5);
      const hh = rand(4.5, 7.5);
      // 【关键：房子中心必须落在相机的横向视野内】
      // 实测 fov 42 / distance 34 / pitch 26 时，
      // 身前 30 单位处的可视横向半宽约 25.5，角色附近约 14.5。
      //
      // 取 13.5~16 的依据：路缘在 9，房子半宽 3~4。
      //   9 + 3 = 12   ← 房子紧贴路缘会「压在路面上」，读作墙直接接路
      //   9 + 7 = 16   ← 留 3~7 单位院子，读作「有前院的小屋」
      // 13.5~16 落在两者之间，既不压路，又稳在角色深度的可视半宽内。
      // （第一版放在 ±11.5，房子紧贴路面；第二版 ±15 越过了可视边界，
      //   只在远景露出屋顶角。）
      const hx = xSide + (13.5 + rand(0, 2.5)) * Math.sign(xSide - MAIN_STREET_X);
      if (hx > B.maxX - 8 || hx < B.minX + 8 || hzGuard(hx, z)) { z += 14; continue; }
      group.add(makeHouse(hx, z, hw, hd, hh, hh * 0.4, lodAt(hx, z), faceSouth));
      // 间距随机，避免出现等距的机械节奏
      z += 13 + rand(0, 4);
    }
  };
  // 建筑位置的合法性检查统一走这里，避免三处重复条件写漏
  const hzGuard = (hx, z) =>
    z < 3 || z > B.maxZ - 8 ||
    (Math.abs(hx) < coreHalf && z < 40);

  /**
   * 按到「城市重心」的距离决定细节等级。
   *
   * 【半径 110 → 170：实测逼出来的】
   * 原来近景档只覆盖以 (0,60) 为心、半径 110 的区域。
   * 但主街全长 240 单位、城区从 z=3 铺到 z=230 ——
   * 半径 110 意味着**玩家在主街北段看到的房子几乎全是 MID**，
   * 门窗全没有，画面读作「一排素色方块」。
   *
   * 玩家真正会去的地方是主街沿线（x≈40，z 从 20 到 230），
   * 所以判定中心应该落在主街中段，而不是港区原点。
   */
  const LOD_CENTER_Z = 120;
  const lodAt = (hx, hz) => {
    const d = Math.hypot(hx - MAIN_STREET_X * 0.5, hz - LOD_CENTER_Z);
    return d < 170 ? LOD_NEAR : d < 260 ? LOD_MID : LOD_FAR;
  };

  streetRow(MAIN_STREET_X - 13, B.minZ + 14, B.maxZ - 10);
  streetRow(MAIN_STREET_X + 13, B.minZ + 14, B.maxZ - 10);

  // ---- 东西向横街 + 街区内部建筑 -------------------------------------
  // 【横街是必需的，不是装饰】
  // 只有一条南北主街时，玩家走到东西两侧就是「主街背后」，
  // 那里如果只有随机散点，读作城市背面。
  // 插入横街后，整个 280×260 被切成若干街区，
  // 玩家在任何位置都处在「两条街的交叉点」附近，方向感才成立。
  const CROSS_X = [MAIN_STREET_X - 58, MAIN_STREET_X + 58];
  const CROSS_Z = [70, 140, 210];
  for (const cx of CROSS_X) {
    for (const cz of CROSS_Z) {
      // 横街上的房子：沿横街南北两侧各排一列。
      //
      // 【原实现的 bug】参数叫 xSide，传入 cx±13，却写
      //   hx = cx + (...) * Math.sign(xSide - cx)
      // 而 xSide 传进来的就是 cx±13，于是 Math.sign 的结果恒为 ±1，
      // 但「房屋所在的那条街」到底是哪一条没有被真正区分 ——
      // 两排房屋实际上共用同一套偏移逻辑，位置不可控。
      // 正确做法：把偏移量当参数传入，同时用它推出开门朝向。
      const col = (offsetX) => {
        // 街中心在 cx，房子在 cx+offsetX，所以门朝 -sign(offsetX) 侧（即朝街）
        const faceSouth = offsetX > 0;
        let z = cz + 12;
        while (z < Math.min(cz + 78, B.maxZ - 10)) {
          const hw = rand(6, 8), hd = rand(5.5, 7.5), hh = rand(4.5, 7.5);
          const hx = cx + offsetX;
          if (hx > B.maxX - 8 || hx < B.minX + 8 || hzGuard(hx, z)) { z += 14; continue; }
          group.add(makeHouse(hx, z, hw, hd, hh, hh * 0.4, lodAt(hx, z), faceSouth));
          z += 13 + rand(0, 4);
        }
      };
      col(-(13.5 + rand(0, 2.5)));
      col(13.5 + rand(0, 2.5));
    }
  }

  // ---- 街区内填充建筑：保证远处不是空地 --------------------------------
  // 【为什么要保留这一层】
  // 沿街排布只覆盖街道两侧的窄带，街区内部和城市边缘（x 远离主街时）
  // 会露出大片空地 —— 玩家从横街往外走几步又是荒地。
  // 这一层用低密度散点把空地填上，但**只填远处**，
  // 近处保留空隙（院子/菜地），否则近景会挤成一团。
  for (let gz = B.minZ + BLOCK; gz < B.maxZ; gz += BLOCK) {
    for (let gx = B.minX + BLOCK; gx < B.maxX; gx += BLOCK) {
      if (gz < 2) continue;
      if (Math.abs(gx) < coreHalf && gz < 40) continue;

      // 已经有沿街建筑覆盖的区域不再撒点，避免重叠
      const nearMain = Math.abs(gx - MAIN_STREET_X) < 26;
      let nearCross = false;
      for (const cx of CROSS_X) {
        for (const cz of CROSS_Z) {
          if (Math.abs(gx - cx) < 26 && gz > cz - 4 && gz < cz + 90) nearCross = true;
        }
      }
      if (nearMain || nearCross) continue;

      const dist = Math.hypot(gx, gz - 60);
      const nHouses = lodAt(gx, gz) === LOD_FAR ? 1 : randInt(1, 2);
      for (let k = 0; k < nHouses; k++) {
        const hw = rand(6.0, 8.0);
        const hd = rand(5.5, 7.5);
        const hh = rand(4.5, 7.5);
        const hx = gx + rand(-BLOCK * 0.28, BLOCK * 0.28);
        const hz = gz + rand(-BLOCK * 0.28, BLOCK * 0.28);
        if (hx < B.minX + 8 || hx > B.maxX - 8) continue;
        if (hz < 3 || hz > B.maxZ - 8) continue;
        if (Math.abs(hx - MAIN_STREET_X) < STREET + 2) continue;
        // 填充层没有明确街道，朝向随机即可 —— 反正不在近景主街上
        group.add(makeHouse(hx, hz, hw, hd, hh, hh * 0.4, lodAt(hx, hz), rng() < 0.5));
      }
    }
  }

  // ============ 主街 ============
  // 从码头一路向北到内陆，宽度足够跑马。
  // 主街是超大地图里的「方向锚点」—— 玩家只要沿着它走就知道自己在往哪去。
  const roadMat = new MeshStandardMaterial({
    map: HD2D.tex('stonePaving', { seed: 55, hue: 33, sat: 0.16, baseL: 0.72 },
                  Math.round(26 * WORLD.SCALE * 0.5)),
    roughness: 0.94, metalness: 0.0
  });
  roadMat.color.setHex(0xffffff);
  const roadLen = B.maxZ - B.minZ;
  const road = new Mesh(new PlaneGeometry(STREET * 2, roadLen), roadMat);
  road.rotation.x = -Math.PI / 2;
  road.position.set(MAIN_STREET_X, 0.015, (B.minZ + B.maxZ) / 2);
  road.receiveShadow = true;
  road.name = 'main_street';
  group.add(road);

  // ---- 东西向横街的路面 ---------------------------------------------
  // 【必须画路面，否则建筑会「凭空站在草地上」】
  // 上面的沿街建筑是按横街两侧排布的，但没有路面对应的话，
  // 玩家看到的���两排房子中间隔着一条草地」—— 读作两堵墙，
  // 而不是一条街。路面是把「建筑排列」变成「街道」的唯一线索。
  for (const cx of CROSS_X) {
    for (const cz of CROSS_Z) {
      const cr = new Mesh(new PlaneGeometry(88, STREET * 2), roadMat);
      cr.rotation.x = -Math.PI / 2;
      cr.position.set(cx, 0.014, cz + 34);
      cr.receiveShadow = true;
      group.add(cr);
    }
  }

  // ============ 主��两侧的绿化与道具 ============
  // 只在近区放 —— 路灯和树要castShadow，远处放几千个会拖垮帧率，
  // 而且远处根本看不清，纯浪费。
  // 间隔 26 → 18：主街全长 242 单位，26 的间隔只有 9 处街具，
  // 在 10 倍长的大街上读作「路灯断断续续」；18 才有连续的城市感。
  //
  // 【街具位置要避开沿街建筑】
  // 房子贴在 |hx-40| ∈ [11,15]，街具原本在 10.6 —— 正好卡在房子身上。
  // 改成 9.4（贴着路缘），落在房子与路之间那 2 单位空隙里。
  for (let z = B.minZ + 20; z < B.maxZ - 20; z += 18) {
    for (const side of [-1, 1]) {
      const x = MAIN_STREET_X + side * (STREET + 0.4);
      const r = rng();
      if (r < 0.34) {
        // 树
        const t = createTree({ h: rand(5, 7.5), spread: rand(2.2, 3.4), lod: z < 90 ? 0 : z < 190 ? 1 : 2 });
        t.position.set(x, 0, z);
        group.add(t);
      } else if (r < 0.62) {
        // 路灯
        const l = createLampPost();
        l.position.set(x, 0, z);
        group.add(l);
      } else if (r < 0.8) {
        // 花坛
        const p = createPlanter(rand(1.3, 1.8));
        p.position.set(x, 0, z);
        group.add(p);
      } else {
        // 木箱 / 酒桶
        const c = rng() < 0.5 ? createCrate() : createBarrel();
        c.position.set(x, 0, z);
        group.add(c);
      }
    }
  }

  // ============ 街区内绿化 ============
  // 树木散布在建筑之间，制造疏密变化。
  //
  // 【数量：从 900 砍到 320 —— 这是实测逼出来的】
  // 900 棵满配树 = 13500 个树冠 mesh、33 万三角面，占全场景 99.9%，
  // 实测帧率个位数。树是「数量最多 × 单体最不重要」的东西，
  // 站远了只看到绿团块，15 颗球和 3 颗球在屏幕上没区别。
  // 所以正确做法不是砍数量，而是**先给树做 LOD**（见 props.js createTree），
  // 再把数量定在「近中景密、远景稀」——
  // 320 棵按距离分级后，近处仍有树，远处靠雾和房屋兜底。
  for (let i = 0; i < 320; i++) {
    const x = rand(B.minX + 15, B.maxX - 15);
    const z = rand(6, B.maxZ - 15);
    // 避开主街和核心区
    if (Math.abs(x - MAIN_STREET_X) < STREET + 3) continue;
    if (Math.abs(x) < coreHalf && z < 40) continue;
    const tdist = Math.hypot(x, z - 60);
    const tlod = tdist < 90 ? 0 : tdist < 190 ? 1 : 2;
    const t = createTree({ h: rand(4.5, 7), spread: rand(2, 3.2), lod: tlod });
    t.position.set(x, 0, z);
    group.add(t);
  }

  return group;
}

/**
 * 主街的 X 坐标。
 * 刻意**不放在 x=0**，而是偏到 40：
 *  x=0 是港口广场的中轴，喷泉、栈桥都围绕它组织。
 *  主街如果也从 x=0 起，会和广场的轴线重合，
 *  玩家沿街向北走时看不出「已经离开广场」——空间感会断裂。
 *  偏到 40 之后，从广场往东北方向走才有一条明确的路，
 *  「离开中心区」这件事本身变得可读。
 */
const MAIN_STREET_X = 40;
