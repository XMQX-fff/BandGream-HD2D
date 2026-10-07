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
import {
  BUILDING_TYPES, TYPE_FOOTPRINT, pickBuildingType, bindSightRegistry,
  tagBuilding, exportBuildingTags
} from './buildingTypes.js';

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
//
// 【不导出】这三个常量只在 city.js 内部使用（makeHouse 的材质分支、
// lodAt 的距离判定、填充层的数量决策），src/ 下没有任何其他文件 import 它们。
// 导出只会让人误以为存在外部调用方，实际是死 API。
// --------------------------------------------------------------------------
const LOD_NEAR = 0;   // 完整：墙 + 屋顶 + 门窗 + 院子杂物
const LOD_MID  = 1;   // 中景：墙 + 屋顶，无门窗
const LOD_FAR  = 2;   // 远景：单一体块，偏雾色

// --------------------------------------------------------------------------
//  遮挡物登记
// --------------------------------------------------------------------------
/**
 * 场景中所有会遮挡「相机 → 角色」视线的物体的地面包围盒。
 *
 * 用途有两个（相机避障 + 玩家碰撞），所以登记的不只是房子。
 *
 * 【为什么必须包含树 —— 这是「角色明明在画面中央却看不见」的真凶】
 * 最初这里只登记 makeHouse，理由是「房子才是高的东西」。
 * 实测射线诊断（tools/diagnose_camera.py）的结论推翻了这个假设：
 *
 *   横街东口 (98,140)：相机高度 16.6 = 基准值，**避障完全没触发**，
 *                      但射线仍被挡 2 次 —— 命中物是 Icosahedron，
 *                      也就是 createTree 的树冠球。
 *   城区西北 (-30,120)：命中物里同样有 Icosahedron。
 *
 * 树高 4.5~7.5，和房子（顶 6~11）处在同一量级，
 * 而「相机在角色 +Z 侧 34 单位」这条视线上，
 * 沿街种的一排树几乎必然横在其中。漏掉树，
 * 避障逻辑就会算出一��「视线通畅」的结论，然后被现实打脸。
 *
 * 结论：凡是竖直方向能挡住视线的东西都要登记，缺一类就会出现一类 bug。
 */
const BLOCKERS = [];

/**
 * 登记一个遮挡物。
 * @param {number} x @param {number} z 中心
 * @param {number} w @param {number} d 地面尺寸
 * @param {number} top 顶部高度
 * @param {boolean} solid 是否阻挡玩家行走（树冠挡视线但不挡路，
 *   房子两者都挡）。分开标记是因为「镜头要绕开」和「人能走过去」
 *   是两个不同诉求：挡住视线的树该被相机躲开，但玩家可以从树下走过。
 */
function registerBlocker(x, z, w, d, top, solid) {
  BLOCKERS.push({
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
    top,
    solid
  });
}

/**
 * 取走并清空遮挡物列表（每个场景只需调用一次）。
 * @returns {Array<{minX:number,maxX:number,minZ:number,maxZ:number,top:number,solid:boolean}>}
 */
export function exportBlockers() {
  return BLOCKERS.splice(0, BLOCKERS.length);
}

/**
 * 取走并清空建筑标签表（诊断用）。
 *
 * 【为什么不把标签挂在 blockers 上】
 * blockers 是相机与碰撞的热路径数据结构，每帧遍历上千次。
 * 给它加字段会让缓存行占用变差，而且诊断标签的更新频率
 * 与游戏逻辑无关，不该污染运行时数据。
 * 与 blockers 同款「取走即清空」：每个场景只统计一次。
 */
export function exportTags() {
  return exportBuildingTags();
}

/**
 * 把建筑类型库的遮挡登记接到本模块的 BLOCKERS 上。
 *
 * 【为什么要用「注入」而不是直接 import】
 * 建筑类型库（buildingTypes.js）要用本模块的 registerBlocker，
 * 而本模块也要用它的 BUILDING_TYPES —— 双向 import 会构成循环依赖。
 * 依赖注入打破这个环：两边互不认识，只在模块加载时由 city.js 单向交出能力。
 *
 * 效果是两份代码写进**同一个 BLOCKERS 数组**，
 * 相机与角色拿到的仍是单一数据源（见本文件顶部的说明）。
 */
bindSightRegistry((x, z, w, d, top, solid) => registerBlocker(x, z, w, d, top, solid));

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

  // ==========================================================================
  //  地标锚点
  // ==========================================================================
  //
  // 【为什么必须有 —— 这是「协调建筑分布」的核心诉求】
  // 没有地标的城镇是一张**均质纹理**：走到哪都长得一样，玩家记不住位置，
  // 于是每次都是「陌生的街区」。而 OT2 的每个小镇都有 2~3 个极明显的地标
  //（钟楼、教堂、市集），玩家靠它们导航 ——「往钟楼那边走」。
  //
  // 它还顺带解决了纯随机布局的一个隐藏缺陷：
  // 随机抽样下教堂与民居的出现概率相同，于是教堂淹没在民房里、
  // 毫无存在感。**只有固定间隔插入才能让它成为视觉焦点。**
  //
  // 为什么只在主街放：地标的价值是「在玩家常走的路上能被看见」。
  // 放在深巷里的地标等于不存在 —— 看不见的锚点不产生记忆。
  //
  // 地标间隔：每 4 栋插一个。
  //
  //  【选型标准：高度突出 或 剪影独特，两条至少占一条】
  // 旧表里有 marketStall(3.3m) 和 townhouse(7.1m) —— 这两个当地标是失效的：
  //  3.3 米的市集棚比旁边民居还矮，玩家走过去根本不会意识到「这里是地标」；
  //  而 townhouse 是主街的常规配置，出现 5 次就不叫「标记」了。
  //
  //  【GAP 由 5 降到 4 是实测校准的结果】
  //  GAP=5 时全城 9 单位以上只有 13 栋，而 4~6 高度档有 669 栋 ——
  // 比例 1:51，天际线读作「一堵平顶的墙」，起伏几乎为零。
  //  GAP=4 把主街 76 栋变成约 19 个地标位，高低起伏才真正能被看见。
  //
  //  现表覆盖三种「一眼能认」的形态：
  //    chapel  尖拱 + 钟楼 + 四棱尖顶，13.4m，最高且最复杂
  //    tower    八棱锥 + 顶尖，16.7m，全城最高，远处可见
  //    workshop 大烟囱，7.0m 但烟囱高出屋顶近 3 米，剪影独特
  //    marketStall 条纹布幔棚，3.1m 矮，但形态与所有坡屋顶建筑都不同
  const LANDMARK_GAP = 4;
  const LANDMARKS = ['chapel', 'tower', 'marketStall', 'chapel', 'workshop'];


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
  // ==========================================================================
  //  沿街建筑：联排面 + 高度梯度 + 地标锚点
  // ==========================================================================  //
  // 【为什么是「联排」而不是「每隔一段放一栋」】
  // 旧实现每13~17 单位放一栋独立房子，房子之间留 5~9 单位空隙。
  // 结果沿街看过去是「一栋房子 + 一段空地 + 一栋房子」——
  // 读作**郊区别墅**，不是城镇。
  //
  // 真实的欧洲中世纪城镇长这样：山墙**紧挨着山墙**连续排列，
  // 构成一整片连续的沿街立面（street wall），
  // 房屋之间的分隔靠「山墙贴山墙 + 立面高低错落」，
  // 而不是靠空地。
  //
  // 这个差别在 HD-2D 里尤其致命：斜俯视下玩家看到的是屋顶的连续天际线。
  // 房子之间留空隙 → 天际线是一串孤立的三角；
  // 联排→ 天际线是连续的、只有高度变化没有断裂。
  // 后者才是 OT2 里那些小镇的观感。
  //
  // 所以下面改成：沿街按模数**连续排布**，不留随机大空隙，
  // 空隙只留给「需要通光的巷口」（每 3~4 栋留一个 4 单位的巷口）。
  // ==========================================================================

  /**
   * 沿一条街排一列建筑。
   *
   * @param {'z'|'x'} axis 街道走向：'z' = 南北向（沿 Z 排）/ 'x' = 东西向
   * @param {number} line   街道坐标（axis='z' 时是 x，axis='x' 时是 z）
   * @param {number} side   哪一侧：+1 / -1
   * @param {number} from   起始坐标
   * @param {number} to     结束坐标
   * @param {string} tier   传给 pickBuildingType 的档位
   */
  const streetRow = (axis, line, side, from, to, tier) => {
    let cursor = from;
    let n = 0;
    // 高度节奏：每隔 3~5 栋插一栋更高的，形成韵律。
    // 连续的天际线也需要变化 —— 全是同高的民居会读作「一堵平顶的墙」。
    let beat = 0;
    let beatTarget = 3 + Math.floor(rng() * 3);
    // 距上一个地标过了几栋
    let sinceLandmark = 0;
    // 距上一个巷口过了几栋
    //
    // 【为什么必须独立计数，不能复用 n —— 这里曾死循环】
    // 旧写法是 `if (n % (3 + rng()*2) === 0) { cursor += 4; continue; }`。
    // n 在巷口分支里不变，于是每轮都拿同一个 n 再掷一次 p。
    // 当 n 同时是 3 和 4 的公倍数（n=12、24…）时，n%3==0 且 n%4==0，
    // p 无论掷出 3 还是 4 都命中 → 永远命中 → n 永远不推进 → 死循环。
    // 症状很隐蔽：主街只排出 12 栋就停，z 停在 78 而范围明明到 230，
    // 而 while(cursor < to) 仍在跑，只是光标每次只挪 4 个单位，
    // 一直挪到 to 才退出 —— 表现为「后面 150 米一条街全是空地」。
    // 独立的 alleySince 每放一栋就 +1，巷口分支里也 +1，
    // 保证无论掷出什么都会推进计数，不可能卡死。
    let alleySince = 3 + Math.floor(rng() * 3);
    let alleyTarget = alleySince;

    while (cursor < to) {
      // ---- 巷口：每 3~5 栋留一个开口 ----
      // 巷口让密集立面出现节奏断点，玩家能读出「这里通向街区内部」。
      // 全填满的话沿街面会读作一堵 200 米长的连续墙，压迫感过强。
      if (n > 0 && alleySince >= alleyTarget) {
        cursor += 4.0;      // 巷口宽 4 单位
        alleySince = 0;
        alleyTarget = 3 + Math.floor(rng() * 3);
        continue;
      }

      // ---- 地标锚点（只在主街） ----
      if (tier === 'main' && sinceLandmark >= LANDMARK_GAP) {
        const key = LANDMARKS[n % LANDMARKS.length];
        // 放大必须**传进 makeBuilding**，由它统一调整偏移与推进长度。
        // 旧实现是在外面 scale.setScalar(1.12)，位置不变、体积变大 ——
        // 于是放大的那一栋正好骑在路面上。
        const b = makeBuilding(key, cursor, line, side, axis, n, tier, 1.12);
        group.add(b.group);
        // 【必须按实际进深推进，不能写死】
        // 旧的一版这里写的是 `cursor += 7.0`（按教堂进深），
        // 于是放 townhouse（进深 4）时旁边就多出 3 单位空隙 —— 联排被切断了。
        cursor += b.depth + 0.6;
        n++; sinceLandmark = 0;
        alleySince++;          // 地标也占一个沿街位，巷口计数照常推进
        beat = 0;
        continue;
      }

      // ---- 普通建筑 ----
      let key = pickBuildingType(rng, tier);
      // 节奏点：主街上把一栋换成更高的（联排民居 / 工坊）
      if (tier === 'main' && beat >= beatTarget && rng() < 0.35) {
        key = rng() < 0.5 ? 'townhouse' : 'workshop';
        beat = 0;
        beatTarget = 3 + Math.floor(rng() * 3);
      }
      beat++;
      if (beat >= beatTarget) beatTarget = 3 + Math.floor(rng() * 3);

      const b = makeBuilding(key, cursor, line, side, axis, n, tier);
      group.add(b.group);
      // 【间距由建筑实际进深决定 —— 这是联排成立的关键】
      // 旧的固定 13~17 是为了适配「宽 6~8 的独立房子」。
      // 现在进深是 2~7 的变量，固定间距必然忽宽忽窄 ——
      // 按 b.depth + 0.6（墙缝）推进，得到的才是真正连续的沿街立面。
      cursor += b.depth + 0.6;
      n++;
      sinceLandmark++;
      alleySince++;
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

  /**
   * 按类型生成一栋建筑，并摆到街边。
   *
   * 【为什么需要这层包装，而不是直接 BUILDING_TYPES[key].make(...)】
   * 建筑类型库的 make() 假定「门朝 +Z、房子位于原点」。
   * 而沿街排布需要三件额外的事：
   *
   *  1. **朝向**：沿东西向街道的门必须朝 +X 或 -X，否则整排房子背对街道。
   *  2. **偏移**：建筑要站在**路缘之外**，且偏移量随进深变化。
   *  3. **LOD**：按到中心的距离决定细节等级。
   *
   * 它定义在 createOutskirts 内部（而不是模块级）是因为要用到
   * STREET 与 lodAt —— 那两个是「街道布局参数」，属于本函数的局部概念。
   * 放在模块级就只能再传一遍参数，纯属冗余。
   *
   * @param {string} key   BUILDING_TYPES 的键
   * @param {number} cursor 沿街方向的坐标
   * @param {number} line   街道坐标（垂直于沿街方向的那条轴）
   * @param {number} side   +1 / -1，街道的哪一侧
   * @param {'z'|'x'} axis  街道走向：'z' = 南北向（沿 Z 排）
   * @param {number} n      序号（用于确定性 seed）
   * @returns {{group: Group, depth: number}} depth = 沿街进深，
   *   调用方用它推进光标 —— 这是「联排贴住」的实现基础。
   */
  const makeBuilding = (key, cursor, line, side, axis, n, zone = 'unknown',
    scale = 1) => {
    const type = BUILDING_TYPES[key];
    const fp = TYPE_FOOTPRINT[key];
    const seed = n * 13 + Math.floor(rng() * 997) + Math.round(line) * 3;
    const lod = lodAt(...(axis === 'z' ? [line, cursor] : [cursor, line]));

    // 【偏移必须随进深变化】
    // 街缘到建筑中心的距离 = 半个街宽 + 半个进深 + 院子余量。
    // 旧实现固定 ±13.5~16，那只对「宽 6~8 的单一房子」成立。
    // 现在进深在 2~7 之间（杂物棚 2、教堂 7）：
    // 固定偏移会让仓库压到路面上、杂物棚飘在半空。
    //
    // 【但沿街与围合的偏移含义不同】
    // 沿街：建筑在街边线外 STREET 处，偏移要含半个街宽（9）。
    // 围合：建筑贴着**地块自己的边界线**，那里根本没有街，
    //       用9 会把它平白推出去 9 米 —— 围合的墙直接散进荒地。
    // 所以街宽作为参数传入，围合传 0。
    //
    // 【院子余量必须随进深放大，不能是固定 1.2 —— 这是实测撞出来的】
    // 固定 1.2 时，教堂（进深 7）的偏移 = 9 + 3.5 + 1.2 = 13.7，
    // 而它半进深 3.5 → 路缘到建筑只剩 13.7 - 3.5 = 10.2...
    // 但路面半宽是 9，看起来还有 1.2 余量 —— 问题是**山墙尖顶
    // 与钟楼还要往外探**（见 buildingTypes.js chapel 的钟楼偏置），
    // 实测教堂 @ (52.0, 160.3) 确实骑到了路面上。
    //
    // 修正：余量按进深比例给（深房子退让更多），
    // 这样「路缘到建筑边缘」在所有进深下都是同一个正值。
    // 【缩放必须计入偏移 —— 否则地标放大后会骑到路面上】
    // 教堂地标放大 1.12 后进深由 7变 7.84，而偏移仍是按 7 算的，
    // 于是路缘到建筑少了 0.42 米。实测教堂 @ (52.0, 158.8)
    // 距街心只有 12.0（应为 9 + 3.92 + yard），正好压在路面上。
    const setback = zone === 'perimeter' ? 0 : STREET;
    const yard = (zone === 'perimeter' ? 0 : 1.2 + fp.depth * 0.22) * scale;
    const offset = setback + fp.depth * scale / 2 + yard;

    const g = type.make(0, 0, { seed, lod });

    if (axis === 'z') {
      g.position.x = line + side * offset;
      g.position.z = cursor;
      // 门朝街：side<0 表示街在建筑西侧 → 门朝 +X
      g.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      g.position.x = cursor;
      g.position.z = line + side * offset;
      // side<0 表示街在建筑南侧 → 门朝 +Z
      g.rotation.y = side < 0 ? 0 : Math.PI;
    }
    // 标签的 depth 记**缩放后**的实际进深：
    // 诊断脚本靠它算沿街间隙与是否压路，用未缩放的值会算出假断口。
    tagBuilding(g, key, g.position.x, g.position.z,
      fp.depth * scale, fp.height * scale, zone);
    // 推进长度同样按缩放后计：地标放大 1.12 就多占 12% 的沿街长度。
    return { group: g, depth: fp.depth * scale };
  };

  // ---- 主街两侧 ----
  streetRow('z', MAIN_STREET_X, -1, B.minZ + 14, B.maxZ - 10, 'main');
  streetRow('z', MAIN_STREET_X, +1, B.minZ + 14, B.maxZ - 10, 'main');
  // ==========================================================================
  //  东西向横街
  // ==========================================================================
  // 【横街是必需的，不是装饰】
  // 只有一条南北主街时，玩家走到东西两侧就是「主街背后」，
  // 那里如果只有散点，读作城市背面。插入横街后整个 280×260 被切成街区，
  // 玩家在任何位置都处在「两条街的交叉点」附近，方向感才成立。
  //
  // 【本轮改动：复用 streetRow，不再写第二套排布逻辑】
  // 旧实现里横街的 col() 把「随机尺寸 + 固定间距」又写了一遍，
  // 与主街的 streetRow 高度重复，且偏移算法本身有 bug ——
  // col() 里那个 `Math.sign(xSide - cx)` 因为 xSide 传进来的就是 cx±13，
  // 符号恒为 ±1，两排房子实际共用同一套偏移逻辑，位置不可控。
  //
  // 现在 streetRow 参数化 axis（'z' = 南北向 / 'x' = 东西向），
  // 横街直接调用它 —— 联排、巷口、节奏、地标四项逻辑只有一份。
  const CROSS_X = [MAIN_STREET_X - 58, MAIN_STREET_X + 58];
  const CROSS_Z = [70, 140, 210];
  for (const cx of CROSS_X) {
    for (const cz of CROSS_Z) {
      // 【横街必须在主街路口留出空档 —— 这是路口不被建筑堵死的前提】
      // 横街原本从 cx-46 排到 cx+46。以 cx = 40+58 = 98 为例，
      // 起点是52，而主街路面范围是 31~49 —— 只差 3 米。
      // 建筑再往外退一点就直接骑在主街路面上，
      // 路口被两排房子夹住，读作「一条死巷」而不是十字路口。
      //
      // 正确做法：横街在主街两侧各留出「路面半宽 + 建筑退让」的空档，
      // 即从主街中心线两侧 MAIN_GAP 起排。
      // 这样十字路口的四个角是开敞的，玩家能一眼看穿过去。
      const gapFromMain = MAIN_STREET_X - (STREET + 4.5);
      streetRow('x', cz + 34, -1, Math.max(cx - 46, gapFromMain), cx + 46, 'cross');
      streetRow('x', cz + 34, +1, cx - 46, Math.min(cx + 46, MAIN_STREET_X + gapFromMain), 'cross');
    }
  }

  // ==========================================================================
  //  街区内填充：围合式布局（不是撒点）
  // ==========================================================================
  // 【旧实现是网格撒点，失败在两处】
  //  1. 撒点的朝向随机 → 会出现「门朝着院墙」的房子
  //  2. 密度不可控：某些格子 2 栋、某些 0 栋，近景出现空洞
  // 读出来是「郊区别墅群」而不是「街区」。
  //
  // 【改成围合：沿地块四边各排一列，中间留院子】
  // 这是真实街区的形态（block perimeter + courtyard）。
  // 它同时解决上面两点：朝向由「门朝地块外」唯一确定，
  // 密度由「边长 / (进深 + 墙缝)」决定，不会出现空格子。
  //
  // 为什么必须填：沿街排布只覆盖街道两侧的窄带，
  // 玩家从横街往外走几步又是荒地 —— 读作城市背面。
  for (let gz = B.minZ + BLOCK; gz < B.maxZ; gz += BLOCK) {
    for (let gx = B.minX + BLOCK; gx < B.maxX; gx += BLOCK) {
      if (gz < 2) continue;
      if (Math.abs(gx) < coreHalf && gz < 40) continue;

      // 已有沿街建筑的区域跳过，避免两套排布重叠
      const nearMain = Math.abs(gx - MAIN_STREET_X) < 30;
      let nearCross = false;
      for (const cx of CROSS_X) {
        for (const cz of CROSS_Z) {
          if (Math.abs(gx - cx) < 30 && gz > cz - 8 && gz < cz + 84) nearCross = true;
        }
      }
      if (nearMain || nearCross) continue;

      // 地块边界（内缩 3.4，让围合的墙之间留出小巷）
      const inset = 3.4;
      const x0 = gx - BLOCK / 2 + inset, x1 = gx + BLOCK / 2 - inset;
      const z0 = gz - BLOCK / 2 + inset, z1 = gz + BLOCK / 2 - inset;
      if (x1 - x0 < 4 || z1 - z0 < 4) continue;

      // 沿 Z 边的两排（门朝地块外）
      for (const [z, s] of [[z0, -1], [z1, 1]]) {
        let x = x0, k = 0;
        while (x < x1) {
          const b = makeBuilding(pickBuildingType(rng, 'fill'), x, z, s, 'z', k++, 'perimeter');
          group.add(b.group);
          x += b.depth + 0.8;
        }
      }
      // 沿 X 边的两排（门朝地块外）
      for (const [x, s] of [[x0, -1], [x1, 1]]) {
        let z = z0, k = 0;
        while (z < z1) {
          const b = makeBuilding(pickBuildingType(rng, 'fill'), z, x, s, 'x', k++, 'perimeter');
          group.add(b.group);
          z += b.depth + 0.8;
        }
      }
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
        const h = rand(5, 7.5), spread = rand(2.2, 3.4);
        const t = createTree({ h, spread, lod: z < 90 ? 0 : z < 190 ? 1 : 2 });
        t.position.set(x, 0, z);
        group.add(t);
        // 【树会挡视线，但不该按实心盒登记 —— 这一处曾把俯角逼到 48°】
        //
        // 旧写法：registerBlocker(x, z, spread*3.2, spread*3.2, h, false)
        // spread 最大3.4 → 登记盒 10.9 × 10.9、高 7.5。
        // 于是一棵树在视线里就是一堵 11 米宽的高墙，
        // 沿街一排树直接组成连续的遮挡墙，
        // 相机第 0 阶段（横移+缩距）无解 → 退到抬升兜底 → 俯角冲到 48°。
        //
        // 为什么不该按实心算：树冠是透空的球簇，
        // 视线穿过树冠缝隙在视觉上完全可接受，
        // 玩家看到的是「镜头从树梢之间穿过去」，不是「镜头撞到树」。
        // 所以登记盒必须比实际树冠小，且高度取树冠下缘 ——
        // 只有 trunk 高度以下的那段（贴近角色视高的）才算真遮挡。
        //
        // 保留登记的必要性：树干确实会挡，且相机若真的穿进树干观感更差。
        // 尺寸依据：trunk 半径约 0.22，取 0.7 见方足够包住；
        // 高度取 2.6 —— 略高于角色视高(1.2)，低于树冠起点。
        registerBlocker(x, z, 0.7, 0.7, 2.6, false);
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
    const h = rand(4.5, 7), spread = rand(2, 3.2);
    const t = createTree({ h, spread, lod: tlod });
    t.position.set(x, 0, z);
    group.add(t);
    // 与沿街树同理：树冠透空，只登记树干那一段。
    // solid = false —— 玩家可以从树下走过，只是别让树干挡住镜头。
    registerBlocker(x, z, 0.7, 0.7, 2.6, false);
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
