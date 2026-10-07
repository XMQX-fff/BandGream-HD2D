/**
 * 建筑淡出 —— 角色被房子挡住时，让挡路的那几栋变透明
 *
 * ======================================================================
 *  【为什么不能简单地「改材质 opacity」】
 * ======================================================================
 *
 * 最直觉的做法是：遍历挡路的建筑，把它的材质 transparent 打开、
 * opacity 调低。实测这条路走不通，两个独立的死因：
 *
 *   ① 材质是**全局共享**的。
 *      props.js 用 MATS 缓存复用材质，全城上千栋房子的墙共用同一个
 *      MeshStandardMaterial 实例。把 opacity 调低 = 全城的墙一起变透明。
 *      （optimize.js 的 mergeStatics 也按材质分桶，同一材质只产出
 *      一个合并 mesh，连「按 mesh 改」都做不到。）
 *
 *   ② 即使材质能改，透明物体**不写深度**。
 *      本项目管线末端是 RenderPixelatedPass，它有一张 depthTexture，
 *      并用深度突变做描边（depthEdgeStrength 0.5）。半透明物体不写深度，
 *      描边会失去被淡出建筑的轮廓 —— 画面上会出现「房子凭空消失」，
 *      而不是「房子变透明」。
 *
 * ======================================================================
 *  【踩过的弯路：按 (材质, 栋) 二元组分桶】
 * ======================================================================
 *
 * 第一反应是改 optimize.js，让它按 (材质, fadeGroup) 分桶，
 * 这样「一栋楼 = 一组可独立控制的 mesh」。**这个方案是错的**，
 * 而且错得很贵：
 *
 *   全城上千栋，每栋平均 4~6 种材质（墙/屋顶/门窗/装饰/影子）。
 *   二元组分桶后桶数 ≈ 栋数 × 材质数 ≈ 4000~6000 个 mesh，
 *   而优化前只有几十个 —— **draw call 涨了两位数**。
 *
 *   这个项目的性能瓶颈完全在 CPU 端的 draw call 提交
 *   （见 optimize.js 顶部的实测：分辨率降到 1/16 帧率几乎不变，
 *   证实瓶颈不在 GPU 填充率）。为了一个视觉增强把帧率打掉两个数量级，
 *   是不可接受的。
 *
 * ======================================================================
 *  【最终方案：逐顶点 fadeId + 抖动剔除（dither discard）】
 * ======================================================================
 *
 * 核心思路：**不碰材质、不碰 draw call、不碰透明排序**，
 * 只改「哪些片元被丢弃」。
 *
 *   1. 合并时给每个顶点附带一个 `aFadeId` 顶点属性 —— 该顶点属于哪栋楼。
 *      合并逻辑**完全不变**（仍然只按材质分桶），
 *      因为 aFadeId 是逐顶点数据，同一个合并 mesh 里可以同时装着
 *      几百栋楼的顶点，各自带不同的 fadeId。
 *      draw call 数量与优化前**完全一致**。
 *
 *   2. 材质用 onBeforeCompile 注入一小段 shader：
 *      按 aFadeId 去查一张「淡出强度查找表」（1×N 的 DataTexture），
 *      得到该栋当前的保留率，再用一个 4×4 Bayer 抖动矩阵
 *      与保留率比较，决定这个片元 discard 还是保留。
 *
 *   3. 每帧只更新查找表里的几个字节，无需重建任何几何、无需重编译 shader。
 *
 * ----------------------------------------------------------------------
 *  【为什么是抖动剔除而不是真 alpha 混合】
 * ----------------------------------------------------------------------
 *   · 真 alpha 混合要开 transparent + depthWrite=false，
 *     于是半透明物体之间**失去深度排序** ——
 *     画面会出现「近处的透明墙被远处的透明墙盖住」这类错误。
 *   · discard 保留完整的深度写入，深度缓冲始终正确 ——
 *     像素化 pass 的描边照常工作，房子淡出后**轮廓还在**，
 *     读作「这栋楼变透明了」，而不是「这栋楼没了」。
 *   · 抖动网格与 RenderPixelatedPass 的像素块对齐
 *     （PIXEL_SIZE=3，beauty RT 是 1/3 分辨率），
 *     所以半透明区域呈现为规整的点阵色块 ——
 *     这恰好是 HD-2D / 像素风的原生语言，不是将就。
 *
 * 【残留代价】半透明区域丢掉了该像素的深度遮挡关系，
 *   站在房子后面的别的东西会透出来。
 *   但角色精灵位于近处、深度上更靠近相机，一定可见 ——
 *   正是我们要的效果。
 */

import { DataTexture, RGBAFormat, UnsignedByteType, NearestFilter } from 'three';

/**
 * 查找表宽度（像素）。
 *
 * 取 2048 的理由：城区实测上千栋建筑，而 DataTexture 只有 1 行，
 * 2048×1×4 字节 = **8 KB**（不到一张普通贴图的零头）。
 * 一次性按最大栋数开满，省掉「容量不足时重建纹理」这条分支 ——
 * 那条分支会让所有材质的 uniform 引用同时失效，是个隐藏的 bug 温床。
 */
const LUT_SIZE = 2048;

/**
 * 未归属顶点的 fadeId。
 *
 * 用 **-1** 而不是 0：0 是合法的栋号（第一栋），
 * 而被丢弃的片元在 GPU 上会读到未初始化属性值（通常是 0），
 * 于是「无归属」的片元会误查成第 0 栋 —— 跟着别人的透明度一起淡。
 * -1 在 shader 里显式判负走「永远实体」分支，语义明确。
 */
const NO_FADE = -1;

/** 挡路建筑的目标保留率（0 = 全透，1 = 全实体）。 */
const FADE_TARGET = 0.28;

/**
 * 视线终点的高度 —— 角色胸口。
 * 必须与 camera.js 的 SIGHT_END_Y 一致：
 * 两套判据对「挡没挡」的看法若不一致，
 * 就会出现「相机认为通畅、淡出认为遮挡」的空档，
 * 画面表现是「楼没淡但角色还是被挡」。
 */
const HERO_SIGHT_Y = 1.2;

/** 角色精灵的半宽（世界单位）。用于判据 B 的贴墙距离。 */
const HERO_HALF_W = 0.45;

/**
 * 判据 B 的最小盒高。
 *
 * 实测贴墙点里 top≈1 的矮花坛占多数（广场围栏、花坛），
 * 它们淡出来毫无意义 —— 高度都不到角色胸口，
 * 本来就挡不住角色，却会造成大面积无谓的画面抖动。
 */
const MIN_FADE_TOP = 2.2;

/**
 * 抖动阈值分布的偏置。
 *
 * 保留率 p 的片元以概率 p 保留。用 Bayer 阈值 t 与 p 比较：
 *   t < p  → 保留
 * 阈值在 [0,1) 上均匀分布即可，不需要额外偏置。
 * 保留 0.28 意味着 72% 的片元被丢弃 → 视觉不透明度约 0.28，
 * 在 1/3 分辨率下呈现为稀疏但可辨的点阵，能看清角色又不完全消失。
 */
const FADE_BIAS = 1.0;

/**
 * 淡出的响应速率（1/秒）。
 *
 * 淡出要**快**（遮挡一出现就该让开，慢了玩家会以为卡了），
 * 恢复要**慢**（挡住就淡、一放开就实体，读起来很跳）。
 * 两者不对称是有意的：这与 camera.js 里 lift/pull 的
 * 「升快降慢」是同一条经验。
 */
const FADE_IN = 10.0;
const FADE_OUT = 3.0;

/**
 * Bayer 4×4 阈值矩阵（0~15，除以 16 得 0~1）。
 *
 *    0  8  2 10
 *   12  4 14  6
 *    3 11  1  9
 *   15  7 13  5
 *
 * 【为什么用 if 链而不是数组/纹理】
 * GLSL ES 1.0 不保证动态索引常量数组可用，
 * 而 16 个分支全是常量比较，编译器会优化成位运算。
 * 更重要的是结果**逐像素确定**，不依赖任何精度假设 ——
 * 这让截图对比测试可复现。
 */
const BAYER4_GLSL = /* glsl */`
  float hd2dBayer4( vec2 p ) {
    int i = int( mod( p.y, 4.0 ) ) * 4 + int( mod( p.x, 4.0 ) );
    float t = 0.0;
    if      ( i ==  0 ) t =  0.0;
    else if ( i ==  1 ) t =  8.0;
    else if ( i ==  2 ) t =  2.0;
    else if ( i ==  3 ) t = 10.0;
    else if ( i ==  4 ) t = 12.0;
    else if ( i ==  5 ) t =  4.0;
    else if ( i ==  6 ) t = 14.0;
    else if ( i ==  7 ) t =  6.0;
    else if ( i ==  8 ) t =  3.0;
    else if ( i ==  9 ) t = 11.0;
    else if ( i == 10 ) t =  1.0;
    else if ( i == 11 ) t =  9.0;
    else if ( i == 12 ) t = 15.0;
    else if ( i == 13 ) t =  7.0;
    else if ( i == 14 ) t = 13.0;
    else                t =  5.0;
    return t * 0.0625;
  }
`;

/**
 * 每栋楼的淡出状态。
 * fade = 当前保留率，target = 目标保留率。
 * 两者分开是为了能做「升快降慢」的非对称平滑。
 */
function makeSlots(n) {
  const arr = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = { fade: 1, target: 1 };
  return arr;
}

/** 建一张全 255（完全不透明）的查找表。 */
function makeLut(count) {
  const data = new Uint8Array(LUT_SIZE * 4);
  // RGBA 四通道全填 255：
  // 只用 R 通道采样，但部分驱动（含软件渲染的 SwiftShader）
  // 对未初始化通道敏感 —— 全填可避免任何未定义读。
  for (let i = 0; i < LUT_SIZE; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, LUT_SIZE, 1, RGBAFormat, UnsignedByteType);
  // Nearest 是必须的：查找表的每个纹素对应一栋楼，
  // 插值会把相邻两栋的保留率混起来 —— 那正是要避免的串扰。
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  void count;
  return tex;
}

/**
 * 判定「这一帧哪些盒子该淡出」。
 *
 * ======================================================================
 *  【为什么是两类判据，而不是只有「视线被挡」一类】
 * ======================================================================
 *
 * 第一版只判「相机→角色的视线是否被挡」，结果实测**几乎从不触发**：
 * 全城上千个采样点里只有 12 个仍有视线遮挡，
 * 而且那12 个全是 maxTop=2.6 的**树干**，不是房子。
 *
 * 原因在 camera.js：上一轮加的「第 0 阶段」把杠杆优先级倒成
 * 横移/缩距优先于抬升，绝大多数遮挡在**不动俯角**的前提下
 * 就被解开了。避障做得越好，淡出越无事可做——
 * 这不是 bug，而是说明「视线判据」覆盖不了玩家的真实抱怨。
 *
 * 玩家说的「角色被建筑挡住看不见」，有两种成因：
 *
 *   A. 视线被挡：角色正好在房子的正后方。
 *      这类避障大多能解，解不了的就是淡出该管的。
 *
 *   B. **角色贴在建筑侧面/背面**（实测占绝大多数）：
 *      角色离墙 0~1.5 单位，此时房子在**画面里与角色重叠**，
 *      但严格意义上视线没被挡（视线从房子旁边擦过去）。
 *      可玩家的体感就是「角色钻进墙里了，看不见」。
 *
 * 所以这里用「视线上」+「贴墙」两条判据取并集。
 *
 * ---------------------------------------------------------------------
 *  【判据 B 为什么用投影重叠，而不是「min(dx,dz) 很小」】
 * ---------------------------------------------------------------------
 * 旧写法 `min(dx,dz) > halfW` 表示「任一轴贴上就算」。
 * 实测在广场基准机位误淡了一栋 id=1514 的建筑：
 *   dx=1.6, dz=0, top=6.3, solid=true
 * 那是喷泉旁的房子，角色出生点本就在它 1.6 单位处——
 * 而那个位置**根本不在视线里**（它在角色西侧，
 * 相机在角色正南偏东），淡它纯属无理由的画面抖动。
 *
 * 正确判据是**投影重叠**：把盒子与角色一起投到「垂直于视线」的平面上，
 * 问「角色的投影有没有落进盒子的投影里」。
 * 落在里面 = 房子确实在角色与相机之间、确实会盖住角色。
 *
 * 这样处理之后：
 *   · 广场那栋（侧向、背对相机）→ 投影不重叠 → 不淡
 *   · 角色贴着正前方房子         → 投影重叠   → 淡
 *
 * ---------------------------------------------------------------------
 *  【纯函数 —— 抽出来是为了能被诊断脚本复用】
 * ---------------------------------------------------------------------
 * update() 改状态，而诊断需要「在任意假设机位下算出该淡出谁」
 * 且**不污染运行中的淡出状态**（否则扫一遍全城，
 * 游戏里所有楼都会被永久改成半透明）。
 * 两条判据的逻辑本身要同时服务于两者，所以抽成纯函数：
 * 缓冲区由调用方传入，函数本身不分配、不改状态。
 *
 * @param {number[]} out 结果缓冲区（会被清空后填充）
 * @param {Array} blockers 遮挡物列表
 * @param {Function} query 空间网格查询 (minX,maxX,minZ,maxZ,out) => out
 * @returns {number[]} out（同一个引用，省一次分配）
 */
function computeHits(out, blockers, query, camX, camY, camZ, targetX, targetZ) {
  out.length = 0;
  const ez = camZ - targetZ;

  // ---- 判据 A：视线被挡 ----
  //
  // 查询范围 = 视线在 XZ 上扫过的矩形。
  // 视线从相机到角色，X 跨度最多 maxShift(≤17)+建筑宽度，
  // Z 跨度就是 34 左右 —— 用这个矩形去查网格，
  // 命中的桶通常只有 2~4 个。
  if (Math.abs(ez) > 1e-3) {
    const cand = query(
      Math.min(camX, targetX) - 2, Math.max(camX, targetX) + 2,
      Math.min(camZ, targetZ) - 2, Math.max(camZ, targetZ) + 2, []);
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      const b = blockers[i];
      // 树（solid=false）不淡：树干本来就细，本来就挡不住角色，
      // 淡出来只会变成一株「点画树」，比不淡更难看。
      if (!b.solid) continue;
      if (b.maxZ < targetZ || b.minZ > camZ) continue;
      const t0 = (camZ - b.maxZ) / ez;
      const t1 = (camZ - b.minZ) / ez;
      const tEnter = Math.max(0, Math.min(1, Math.min(t0, t1)));
      const tExit = Math.max(0, Math.min(1, Math.max(t0, t1)));
      if (tEnter > tExit) continue;

      // X 也要落在盒内（视线在 X 上是斜的，见 camera.js 同款推导）
      const xIn = camX + (targetX - camX) * tEnter;
      const xOut = camX + (targetX - camX) * tExit;
      if (Math.max(xIn, xOut) < b.minX || Math.min(xIn, xOut) > b.maxX) continue;

      // --------------------------------------------------------------
      //  【高度判据：这一处决定了淡出会不会误伤】
      // --------------------------------------------------------------
      // 视线是斜的：近相机端很高（camY，可达 30+），
      // 贴近角色端只有 1.2 米。
      // 一个 Z 落在视线区间内的盒子，如果在**近相机端**，
      // 视线经过时还在十几米高空 —— 房子根本不在画面里挡路。
      //
      // 判据：视线在 tExit 处低于盒顶，才叫「挡住角色」。
      //   rayY(t) = camY + (HERO_SIGHT_Y - camY)·t，沿 t 单调下降，
      //   所以区间内最低点在**退出端**。
      //   （用 tEnter 会得到「刚进盒子时的高度」，算出负缺口、
      //     把明确遮挡的盒子判成不挡 —— camera.js 里踩过这个坑。）
      const rayY = camY + (HERO_SIGHT_Y - camY) * tExit;
      if (rayY > b.top) continue;

      out.push(i);
    }
  }

  // ---- 判据 B：角色贴在建筑旁 ----
  {
    const halfW = 0.5 + HERO_HALF_W;
    const zLo = Math.min(targetZ, camZ);
    const zHi = Math.max(targetZ, camZ);
    // 视线的 XZ 方向（归一化）。视线近乎平行 Z 时退化为 Z 轴，
    // 此时横向投影退化为 0 —— 判据自然只对「正前方」生效，
    // 侧向的房子不会因为贴得近就被淡掉。
    let vx = targetX - camX;
    let vz = targetZ - camZ;
    const vlen = Math.hypot(vx, vz);
    if (vlen < 1e-4) { vx = 0; vz = 1; } else { vx /= vlen; vz /= vlen; }
    // 视线在 XZ 上的右法线
    const rx = -vz;
    const rz = vx;

    // -----------------------------------------------------------------
    //  【必须有距离上限 —— 这是判据 B 最初的漏项】
    // -----------------------------------------------------------------
    // 旧版判据 B 只有「投影重叠」+「在朝相机一侧」，**没有任何距离约束**。
    // 实测（fade_scan.py）在主街边一个可达点算出同时淡出 13 栋：
    //   id=45 距角色 17.2、id=47距角色 32.0，都是 5~7 米的矮楼。
    //
    // 为什么它们不该淡：相机俯角约 34.7°，30 单位外高22。
    // 角色胸口在 1.2 米，射线朝相机方向每远 1 单位就升高 0.693。
    // 于是 17 米外那道射线的位置已经高到 1.2 + 0.693×17 ≈ 13 米，
    // 一栋 7 米的房子**在它下面十几米**，屏幕上出现在角色脚边远处，
    // 根本盖不住角色。把这样一栋淡掉只会让画面无故出现筛孔。
    //
    // 换句话说：**「投影重叠」只说明左右方向对齐，
    // 还需要「上下方向也对齐」** —— 后者由高度条件给出。
    //
    // 这也正是判据 A 的rayY 测试在做的事，两条判据本来就该一致：
    //   rayY(t) = camY + (HERO_SIGHT_Y - camY)·t
    // 沿视线朝相机走 a 单位，射线高度 = HERO_SIGHT_Y + slope·a。
    // 遮挡要求T > 该高度，整理得 a < (T - HERO_SIGHT_Y) / slope。
    //
    // 【slope 用实测的水平距离算，不用固定 30】
    // 相机有横移（camera.js 的 shiftX，最多 ±17），
    // 斜距是 hypot 而不是常量 —— 用 30 会算错坡度，
    // 于是横移时机位附近的淡出范围偏大。
    const camDist = vlen;
    // 相机不低于角色胸口时坡度才有意义（正常游戏里恒成立，
    // 但守住下界避免除出0/负数导致判据整体失效）。
    const slope = camY > HERO_SIGHT_Y
      ? (camY - HERO_SIGHT_Y) / Math.max(1e-3, camDist) : 0;

    const cand = query(targetX - halfW - 4, targetX + halfW + 4,
      zLo - 4, zHi + 4, []);
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      const b = blockers[i];
      // 只关心「够高」的：矮花坛（top≈1）淡了没意义，
      // 而且它们数量多，会造成大面积误淡。
      if (b.top < MIN_FADE_TOP) continue;
      // 必须实心：树（solid=false）淡了会变成一株「点画树」，
      // 比不淡更难看 —— 树干本来就细，本来就挡不住角色。
      if (!b.solid) continue;
      if (b.maxZ < zLo || b.minZ > zHi) continue;

      // ---- 投影重叠 ----
      // 盒子中心与角色中心在「垂直于视线」方向上的距离
      const bx = (b.minX + b.maxX) / 2;
      const bz = (b.minZ + b.maxZ) / 2;
      const lateral = (bx - targetX) * rx + (bz - targetZ) * rz;
      // 盒子在横向上的半宽（用 XZ 尺寸投影到法线后的保守估计）
      const halfSpan = Math.max(
        Math.abs((b.maxX - b.minX) / 2 * rx) + Math.abs((b.maxZ - b.minZ) / 2 * rz),
        0.6);
      // 角色半宽 + 一点余量：完全贴齐才淡，
      // 否则「只是靠近」也会触发，退化成全城半透明。
      if (Math.abs(lateral) > halfSpan + HERO_HALF_W * 0.5) continue;

      // ---- 纵向必须在相机与角色之间 ----
      // 投影重叠还不够：若盒子在角色**身后**（沿视线方向的投影 > 角色），
      // 它在画面里位于角色下方/后方，不会盖住角色。
      const along = (bx - targetX) * vx + (bz - targetZ) * vz;
      // along < 0 表示盒子在「朝相机」那一侧 —— 正是会遮挡的方向
      if (along > 0.8) continue;

      // ---- 高度：射线经过此处时是否低于盒顶 ----
      // 与判据 A 的 rayY 测试同源，只是换个参数化
      // （A 按 t∈[0,1] 写，B 按「距角色多少单位」写）。
      // 缺了这一条，判据 B 会把视线根本够不着的远处房子也淡掉。
      if (slope > 0) {
        // a = 盒子沿朝相机方向距角色的距离
        const a = -along;
        if (a > (b.top - HERO_SIGHT_Y) / slope) continue;
      } else if (b.top <= HERO_SIGHT_Y) {
        // 相机与角色同高甚至更低：只有比角色胸口高的盒子才可能挡
        continue;
      }

      if (out.indexOf(i) < 0) out.push(i);
    }
  }

  return out;
}

/**
 * 淡出系统。
 *
 * @param {Array} blockers 城区的遮挡物列表（与合并几何的 aFadeId 同序）
 */
export function createFade(blockers) {
  const lut = makeLut(blockers.length);
  const data = lut.image.data;

  /** fadeId -> { fade, target }。用数组而非 Map：下标即 id，无需哈希。 */
  const slots = makeSlots(blockers.length);

  // ---------------------------------------------------------------------
  //  空间网格 —— 两条判据都要做全量遍历，不建索引就是每帧 3000 次盒判定
  // ---------------------------------------------------------------------
  //
  // 【为什么必须建，而不是靠「先按 Z 预筛」蒙混】
  // 判据 A 的 Z 预筛很有效（视线只跨一条 34 单位的带），
  // 但判据 B 要判「角色紧邻的所有盒子」——
  // 角色周围半径 1 内的盒子不多，可遍历仍然是全量的
  // （预筛条件 `b.maxZ < zLo` 对判据 B 不成立，因为 zHi 就是 camZ，
  //  落在带外的盒子同样可能紧邻角色）。
  // 两条判据加起来每帧 3000+ 次，在 0.6fps 的软渲染下
  // 每一毫秒都要花在这种纯计算上。
  //
  // 按 XZ 网格分桶后，两条判据都只扫角色/相机附近的少数桶。
  const CELL = 16;
  const grid = new Map();
  for (let i = 0; i < blockers.length; i++) {
    const b = blockers[i];
    const cx0 = Math.floor(b.minX / CELL);
    const cx1 = Math.floor(b.maxX / CELL);
    const cz0 = Math.floor(b.minZ / CELL);
    const cz1 = Math.floor(b.maxZ / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cx * 73856093 ^ cz * 19349663;
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(i);
      }
    }
  }

  /** 收集覆盖给定 XZ 矩形的盒下标（去重）。 */
  function query(minX, maxX, minZ, maxZ, out) {
    const cx0 = Math.floor(minX / CELL);
    const cx1 = Math.floor(maxX / CELL);
    const cz0 = Math.floor(minZ / CELL);
    const cz1 = Math.floor(maxZ / CELL);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const arr = grid.get(cx * 73856093 ^ cz * 19349663);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const id = arr[k];
          if (out.indexOf(id) < 0) out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * 上一帧的命中集。
   * 存在的唯一理由是「target 需要被重置回 1」——
   * 只重置上一帧淡出过的槽位，就不必每帧全量写上千次。
   * 必须在每帧末尾整体替换，不能就地改（hits 每帧重建）。
   */
  let lastHits = [];

  /** 每帧复用的候选缓冲，避免每帧 new 数组。 */
  let candBuf = [];

  /**
   * 逐帧更新淡出强度并刷新查找表。
   *
   * @param camX,camY,camZ 相机位置
   * @param targetX,targetZ 视线终点（角色脚下）
   * @param dt 帧间隔（秒）
   * @returns {{count:number, ids:number[]}} 诊断用
   */
  function update(camX, camY, camZ, targetX, targetZ, dt) {
    const hits = computeHits(candBuf, blockers, query,
      camX, camY, camZ, targetX, targetZ);

    // ------------------------------------------------------------------
    //  2. 更新目标：需要淡出的降到 FADE_TARGET，其余恢复为 1
    // ------------------------------------------------------------------
    //
    // 【必须先重置再写入，否则淡出过的楼会永久透明】
    // 旧写法只做 `for (k of hits) slots[hits[k]].target = FADE_TARGET`，
    // 而恢复依赖「每帧把所有槽位重置为 1」。
    // 一旦有任何一个槽位没在每帧被显式写回 1，
    // 它的 target 就永久停在 0.28 —— 房子再也回不来。
    //
    // 症状极隐蔽：画面上「某些楼一直是半透明的」，
    // 而所有日志、所有判定结果都正常。
    //
    // 修法有两种：全量重置上千个槽位（每帧一次写，代价可接受），
    // 或只重置「上一帧淡出过」的少数几个。
    // 这里用后者 —— 配合 fade 字段的「已恢复即冻结」，
    // 每帧实际写入的只有个位数个槽位。
    for (let k = 0; k < lastHits.length; k++) {
      const i = lastHits[k];
      // 本帧又被判中的跳过，避免写成 1 又立刻写回 0.28
      if (hits.indexOf(i) < 0) slots[i].target = 1;
    }
    for (let k = 0; k < hits.length; k++) slots[hits[k]].target = FADE_TARGET;

    // ------------------------------------------------------------------
    //  3. 非对称一阶低通 + 写入查找表
    // ------------------------------------------------------------------
    //
    // 升（变透明）用 FADE_IN、降（恢复实体）用 FADE_OUT。
    // dt 钳制由 main.js 负责（那边已有 0~0.05 的钳制）。
    let fading = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const t = s.target;
      const rate = t < s.fade ? FADE_IN : FADE_OUT;
      s.fade += (t - s.fade) * (1 - Math.exp(-rate * Math.max(0, dt)));
      if (s.fade < 0.999 && s.fade > 0.001) fading++;
      // 量化到 0~255：既省纹理带宽，也让「已完全恢复」的槽位
      // 停止改动纹理（避免每帧无谓地上传同一张 8KB 表）。
      const q = Math.round(s.fade * 255);
      const o = i * 4;
      if (data[o] !== q) {
        data[o] = q;
        lut.needsUpdate = true;
      }
      // 恢复后归位，省掉下一次的比较
      if (t === 1 && s.fade > 0.999) s.fade = 1;
    }

    // 记住本帧的命中集，供下一帧重置 target 用
    lastHits = hits.slice();

    return { count: fading, ids: hits.slice(0, 8) };
  }

  /**
   * 诊断用：把所有淡出状态立刻复位成「全实体」，并清空命中记忆。
   *
   * 【为什么需要 —— 低帧率下「等它恢复」不可行】
   * 淡出恢复速率FADE_OUT = 3.0/s，而 main.js 把 dt 钳在0.05，
   * 所以每帧最多走 1 - e^(-0.15) ≈ 14%。
   * 软渲染只有 1.2 fps，从 0.28 恢复到 0.999 需要 10 帧以上 ≈ 9 秒；
   * 而测试脚本每个机位只等 2.5 秒（3 帧）。
   *
   * 于是「基准机位不该淡出任何东西」这条断言测到的不是基准机位的状态，
   * 而是**上一个机位留下的还没恢复完的残留** ——
   * 一个纯粹的时序污染，看起来像误淡。
   *
   * 等待不是好办法：它让断言结果依赖机器快慢。
   * 提供显式复位，断言才是确定性的。
   */
  function reset() {
    for (let i = 0; i < slots.length; i++) {
      slots[i].fade = 1;
      slots[i].target = 1;
      data[i * 4] = 255;
    }
    lastHits.length = 0;
    lut.needsUpdate = true;
  }

  /**
   * 诊断用：在任意机位下算出「应该淡出哪些盒」，不改动任何状态。
   * 布局改版后手挑机位会失效（周围可能已无建筑），
   * 靠这个函数全城扫描才能自动选出真正会触发的坐标。
   */
  function probe(camX, camY, camZ, targetX, targetZ) {
    return computeHits([], blockers, query, camX, camY, camZ, targetX, targetZ);
  }

  return {
    update,
    probe,
    reset,
    texture: lut,
    /** 供诊断脚本读取的当前淡出状态 */
    stats: () => ({
      total: slots.length,
      fading: slots
        .map((s, i) => ({ id: i, fade: +s.fade.toFixed(3) }))
        .filter((s) => s.fade < 0.999)
    })
  };
}

/**
 * 给材质注入抖动剔除。
 *
 * @param {Iterable} materials 目标材质（遍历 scene 收集）
 * @param {DataTexture} texture 查找表。所有材质**共用同一个对象引用**，
 *   因此每帧只需更新纹理数据，不必触碰任何材质。
 */
export function injectFade(materials, texture) {
  // 共用同一个 uniform 包装对象：three 每次渲染都从
  // materialProperties.uniforms 读 value，而它们指向同一个对象。
  const uLut = { value: texture };
  const uSize = { value: LUT_SIZE };
  const uTarget = { value: FADE_TARGET };
  const uBias = { value: FADE_BIAS };

  for (const mat of materials) {
    if (!mat || mat.userData.hd2dFade) continue;
    mat.userData.hd2dFade = true;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFadeLut = uLut;
      shader.uniforms.uFadeLutSize = uSize;
      shader.uniforms.uFadeTarget = uTarget;
      shader.uniforms.uFadeBias = uBias;

      shader.vertexShader =
        'attribute float aFadeId;\nvarying float vFadeId;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvFadeId = aFadeId;'
        );

      shader.fragmentShader =
        'uniform sampler2D uFadeLut;\n' +
        'uniform float uFadeLutSize;\n' +
        'uniform float uFadeTarget;\n' +
        'uniform float uFadeBias;\n' +
        'varying float vFadeId;\n' +
        BAYER4_GLSL +
        shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
  // ---- 建筑遮挡淡出（dither discard）----
  // aFadeId 是该顶点所属的栋号；负值 = 不参与淡出（树、道具、地面）。
  // 查表得到当前保留率，与 Bayer 阈值比较决定丢片元。
  float hdFade = 1.0;
  if ( vFadeId >= 0.0 ) {
    hdFade = texture2D( uFadeLut, vec2( ( vFadeId + 0.5 ) / uFadeLutSize, 0.5 ) ).r;
  }
  if ( hdFade < 0.999 ) {
    // 阈值经 bias 调整后与保留率比较：bias<1 让淡出更稀疏（更透）。
    float th = hd2dBayer4( gl_FragCoord.xy ) * uFadeBias + ( 1.0 - uFadeBias ) * hdFade;
    if ( hdFade < th ) discard;
  }`
        );
    };

    // -----------------------------------------------------------------
    //  【为什么必须设置 customProgramCacheKey】
    // -----------------------------------------------------------------
    // three 会把材质参数（贴图、开关、雾……）哈希成程序缓存键。
    // 注入 onBeforeCompile **不参与**这个哈希 ——
    // 于是一个「注入了淡出」和一个「没注入」的材质若参数恰好相同，
    // 会共用同一个编译好的 shader program，注入直接失效。
    //
    // 症状极隐蔽：淡出时好时坏，取决于材质被谁先编译。
    //
    // 写死常量即可 —— 注入逻辑本身是固定的，
    // 不随材质变化。附带好处：所有注入材质共用一个 program，
    // 少编译几个 shader（本项目材质约 14 种）。
    mat.customProgramCacheKey = () => 'hd2d-fade-v1';
  }
}

export { LUT_SIZE, FADE_TARGET, NO_FADE };
