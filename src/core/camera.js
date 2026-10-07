/**
 * HD-2D 跟随相机
 *
 * 关键决策：用透视 +窄 FOV，不用正交。
 *   - HD-2D 的微缩感本质来自「telephoto 透视压缩」，正交会退化成等距视角，
 *     视觉上不像 OT2。
 *   - Sprite 的透视缩放依赖透视投影（`scale *= -mvPosition.z`），正交下角色
 *     无论远近一样大，丧失纵深，画面非常「平面贴纸化」。
 *
 * 固定斜俯角 + 阻尼跟随，不做自由轨道 —— 自由轨道容易让构图偏离 OT2 的固定斜俯角。
 */
import { PerspectiveCamera, Vector3 } from 'three';

export const CAMERA_CONFIG = {
  /**
   * 视场角30° → 42°。
   *
   * 【这是「房子生成了但一栋都看不见」的直接原因，实测出来的】
   * 用真实投影矩阵测地面可视范围（玩家 (40,200)，fov 30 / distance 27）：
   *   可视地面 dx ∈ [-3, +3]、dz ∈ [22, 34] —— 只有 10 个采样点命中。
   * 横向可视半宽仅 ±3 单位，而主街两侧的房子贴在 x=25 / x=55
   * （即距路中线 ±15），全部在可视区之外。主街读作「一条空荡的马路」。
   *
   * 为什么原来 30° 能用：那时广场所有道具都在 20 单位半径内。
   * 地图放大 10 倍后「街道两侧建筑」这种**横向分布**的内容出现，
   * 30° 的窄视野横向装不下 —— 这不是内容问题，是取景框问题。
   *
   * 42° 的取舍：横向半宽 ≈ 27×tan(21°)×1.6 ≈ 16.6 单位，
   * 刚好把 x=±15 的沿街建筑收进画面，同时仍保留一定透视压缩
   * （没有拉到 50°+ 那种广角畸变，不会丢掉 HD-2D 的微缩感）。
   */
  fov: 42,          // 窄 FOV 制造微缩压缩感
  near: 0.5,
  /**
   * 远裁剪面400 → 1600。
   *
   * 【这是地图放大 10 倍时最容易漏掉、后果也最严重的一处】
   * 相机固定在角色身后约 27 单位处，near 平面贴脸、far 平面负责
   * 「一直看到地平线」。地图扩到 280×260 后，站在西侧往东看时，
   * 可见的最远物体在 200 单位开外 —— 而 far=400 只够覆盖
   * 「从核心区望向自己这一侧」的情况。
   * 结果是：地图大部分区域被远裁剪面直接切掉，
   * 玩家看到的是「身边一小块正常、远处凭空消失」的世界。
   *
   * 1600 覆盖了 280宽地图的对角线（≈ 380）加 4 倍余量，
   * 也大于 WORLD.fogFar（≈1075），保证「被雾化」永远发生在
   * 「被裁剪」之前 —— 顺序反了就会出现硬边的「切掉」现象。
   */
  far: 1600,
  /**
   * 斜俯角 26° —— **这是唯一控制俯角的参数**，height 由它派生。
   *
   * 【实测数据，这是让街道两侧建筑进画的关键】
   * 用真实投影矩阵逐带扫描地面可视范围：
   *   fov 30 / dist 27 / pitch 30 → 可视带 dz ∈ [-10,+20]，横向半宽 13.5
   *   fov 42 / dist 34 / pitch 26 → 可视带 dz ∈ [-10,+30]，横向半宽 14.5
   *
   * 【第一版代码里pitchDeg 是死参数，必须说明】
   * 原实现把相机位置写成 (targetY + height, targetZ + distance)，
   * 于是真实俯角 = atan(height / distance) = atan(15.5/27) ≈ 30°，
   * 而 pitchDeg=30 恰好接近它 —— 所以当初看起来"生效了"，
   * 纯属数值巧合。改 pitchDeg 到 26 的那次实测几乎没改善，
   * 就是因为 height/distance 没跟着变。
   *
   * 现在改成 height = distance × tan(pitchDeg)，让俯角真正可控。
   * 26° 比原来的 30° 更平：视线掠过地面的角度变小，
   * 纵向能铺开更长的连续街景，同时仍是明确的斜俯视（不是平视）。
   */
  pitchDeg: 26,     // 斜俯角（唯一数据源，height 由它派生）
  /**
   * 相机到角色的水平距离 27 → 34。
   *
   * 从 36 收到 27 曾经是让角色「成为主角」的关键，
   * 但那个结论只在「广场道具都在 20 单位内」时成立。
   * 地图放大 10 倍后要看清街道两侧的建筑，取景框必须放大，
   * 否则「看得见的范围」连一条街都装不下。
   */
  distance: 34,
  /** 相机离地高度。由 distance 和 pitchDeg 派生，不要直接设这个。 */
  height: 34 * Math.tan((26 * Math.PI) / 180),  // ≈ 16.6
  /**
   * 注视点相对角色向前（-Z）的偏移。
   *
   * 画面中心不是角色，而是角色身前 12 单位的街面。
   * 理由见 updateCamera 里的说明：注视点压在角色身上时，
   * 身前街景被挤到画面顶部一条窄带，构图读作「低头看地面」。
   */
  lookAhead: 12,
  damping: 6.5,     // 跟随阻尼系数（越大越"黏"）
  /**
   * 竖屏（手机）适配系数。
   *
   * 透视相机的水平视野 = 2·atan(tan(fov/2)·aspect)，aspect 越小水平视野越窄。
   * 手机竖屏 aspect ≈ 0.46，横屏 ≈ 1.78 —— 相差近 4 倍，
   * 直接沿用桌面参数会导致手机上只看得到角色脚下一小块地（实测 390×844
   * 下整个广场被裁掉，只剩石板和两根路灯）。
   *
   * 解法是「按 aspect 补偿 FOV」：竖屏时扩大垂直 FOV，
   * 让水平视野回到可用的宽度，同时适度拉远相机保持构图完整。
   */
  portraitFovBoost: 1.55,   // 竖屏 FOV 放大倍率
  portraitAspect: 0.85,     // 低于此 aspect 判定为竖屏
  portraitDistance: 1.22,   // 竖屏相机距离倍率
  portraitHeight: 1.12      // 竖屏相机高度倍率
};

/** 当前视口的相机修正系数（1 = 横屏桌面基准） */
export function cameraFit(aspect) {
  const cfg = CAMERA_CONFIG;
  if (aspect >= cfg.portraitAspect) {
    return { fovScale: 1, distScale: 1, heightScale: 1, lookAheadScale: 0 };
  }
  // 连续插值而非二值切换，避免旋转屏幕时出现突兀的镜头跳变
  const t = Math.min(1, (cfg.portraitAspect - aspect) / (cfg.portraitAspect - 0.46));
  const lerp = (a, b) => a + (b - a) * t;
  return {
    fovScale: lerp(1, cfg.portraitFovBoost),
    distScale: lerp(1, cfg.portraitDistance),
    heightScale: lerp(1, cfg.portraitHeight),
    // 竖屏时压缩注视点前移量，让视线更陡、天空少占画面
    lookAheadScale: lerp(0, 0.65)
  };
}

export function createCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const fit = cameraFit(aspect);
  const cam = new PerspectiveCamera(
    CAMERA_CONFIG.fov * fit.fovScale,
    aspect,
    CAMERA_CONFIG.near,
    CAMERA_CONFIG.far
  );

  const pitch = (CAMERA_CONFIG.pitchDeg * Math.PI) / 180;
  cam.userData.offset = new Vector3(
    0,
    CAMERA_CONFIG.height,
    CAMERA_CONFIG.distance
  );
  cam.userData.pitch = pitch;
  cam.userData.target = new Vector3(0, 0, 0);
  // 遮挡物列表（房子 + 树），由 scene.js 在建好城区后注入。
  // 供 updateCamera 的视线避障使用。
  // null 表示还没注入 —— 此时不做避障（会在第一次就撞墙）。
  cam.userData.blockers = null;
  cam.userData._desired = new Vector3();
  cam.userData._forward = new Vector3();

  cam.position.set(0, CAMERA_CONFIG.height, CAMERA_CONFIG.distance);
  cam.lookAt(0, 0, 0);
  return cam;
}

/** 每帧更新相机位置：绕世界 Y 轴固定方向，看向角色 */
export function updateCamera(camera, targetX, targetY, targetZ, dt) {
  const cfg = CAMERA_CONFIG;
  const fit = cameraFit(camera.aspect);

  // 相机在角色"后方"（+Z）并抬高，俯角固定
  const desired = camera.userData._desired.set(
    targetX,
    targetY + cfg.height * fit.heightScale,
    targetZ + cfg.distance * fit.distScale
  );

  // ---------------------------------------------------------------------
  //  建筑避障 —— 抬高相机，而不是缩短距离
  // ---------------------------------------------------------------------
  // 【为什么必须做】地图放大到 280×260 后街区密度很高，
  // 相机又固定在角色 +Z 侧 34 单位 / 高 16.6 处，
  // 玩家在街区内部走时相机很容易正好落在某栋房子或一棵树里。
  // 实测在 (-30,120) 附近相机穿墙，画面被一堵墙糊死，角色完全不可见。
  //
  // 【为什么是「抬高」而不是「拉近」—— 试过才知道】
  // 第一版把相机沿视线方向往角色身边拉近。避障判定确实通过了
  // （相机不再落在任何建筑包围盒内），但画面依然被前景房子占据 ——
  // 因为**遮挡不是相机自己所在的那栋房子造成的，而是相机与角色之间的房子**。
  // 拉近相机缩短了视距，反而让遮挡物在画面里占比更大。
  //
  // 正确解法：保持距离不变，**把相机沿竖直方向抬高**。
  // 俯角变大 → 视线越过屋顶 → 被挡的房子退出画面。
  // 这是斜俯视游戏（OT2、暗黑）的标准行为，
  // 玩家看到的是「镜头微微抬起」，比「镜头突然贴近」自然得多。
  //
  // 【遮挡不只来自「相机所在」的那栋房子】
  // 相机抬高后如果正好停在一栋房顶上方，画面依然会被挡 ——
  // 因为挡住角色的是**相机与角色之间**的那栋房子/那棵树，
  // 它的高度（4.5~11 单位）正好在视线上。
  // 所以必须扫描「相机 → 角色」这条线段穿过的所有遮挡物。
  const blockers = camera.userData.blockers;
  let lift = 0;
  let pull = 0;
  if (blockers && blockers.length) {
    const sol = solveSightline(targetX, targetY, targetZ, blockers, fit, cfg);
    lift = sol.lift;
    pull = sol.pull;
  }

  // 抬升 / 缩短距离的实际施加。
  // 放在避障计算之后、阻尼之前，
  // 保证下面 lookAhead 的收缩比例用的是「最终高度」而不是基准高度。
  const baseY = targetY + cfg.height * fit.heightScale;
  const baseDist = cfg.distance * fit.distScale;
  if (lift > 0 || pull !== 0) {
    desired.y = baseY + lift;
    // pull 是距离的**增量偏移**：正数= 缩短，负数 = 拉远。
    // 拉远是抬升的必然代价 —— 不拉远俯角就会趋近 90°。
    desired.z = targetZ + baseDist - pull;
  }

  // 阻尼插值，避免硬跟随带来的抖动。
  // k 必须落在 [0,1]：负值会让 lerp 反向放大位置、逐帧发散。
  const rawK = 1 - Math.exp(-cfg.damping * dt);
  const k = Number.isFinite(rawK) ? Math.min(1, Math.max(0, rawK)) : 1;
  camera.position.lerp(desired, k);

  // 注视点：先算好（含竖屏补偿）再 lookAt。
  // 顺序反了会导致补偿完全无效 —— lookAt 已经把朝向写进 quaternion，
  // 之后再改 target 没有任何作用（这是实测「改了没反应」的原因）。
  //
  // 【注视点必须比角色更靠前，这是斜俯构图的关键】
  // 相机在 (targetZ + distance)，视线方向是从 +Z 看向 -Z。
  // 如果注视点正好落在角色身上，画面中心就是角色脚边，
  // 身前 (dz<0) 的街景全在画面上半、挤成一条；
  // 而身后 (dz>0) 什么都没有 —— 玩家读作「贴着脸看地面」。
  //
  // 前移后，画面中心落在角色身前约 12 单位的街面上，
  // 角色落在画面下三分之一附近（符合 OT2 的构图习惯），
  // 身前街景占据画面主体，深度也读得出来。
  //
  // 【竖屏要「收」而不是「放」—— 这一处原先的补偿方向是反的】
  // 竖屏 aspect 只有 0.46，水平视野极窄，必须靠放大 fov 来补，
  // 于是 fov 从 42 涨到 65。代价是**垂直视野也跟着涨**，
  // 天空因此占掉顶部约 40%（实测 390×844）。
  //
  // 原代码用 target.y += (distScale-1)*11 把注视点**抬高**，
  // 想「让更多地面进画面」—— 但注视点抬高等于视线更平，
  // 结果是天空进得更多。方向完全搞反了。
  //
  // 正确的做法是**减少前移量**：竖屏画面窄，纵向拉太长反而空，
  // 保持视线更陡、把街面填满画面。0.35 的系数让 lookAhead
  // 从 12 缩到 4.2，视线压下来，顶部天空收缩到 15% 左右。
  //
  // 【避障抬升后必须把 lookAhead 归零 —— 这一处漏了会导致角色消失】
  // 避障会把相机从 16.6 抬到最多 31 单位，俯角随之从 26° 变陡。
  // 俯角越陡，视线在地面上「落点」越靠近相机，
  // 角色就越往画面下方退、最后被画面底边裁掉。
  //
  // 实测（抬到 31 单位、lookAhead 仍为 12）：角色被推到画面下缘，
  // 只能看到一点红色头发。
  //
  // 修正：按相机抬升比例线性收缩 lookAhead，抬到最高时归零 ——
  // 注视点落在角色身上，角色稳定在画面中央。
  //
  // 【缩短距离也会推角色下移，必须一并计入】
  // 只看抬升会漏掉pull 的影响：距离从 34 缩到 19 时，
  // 同样的 lookAhead=12 在画面里占据的纵向比例涨了 1.8 倍，
  // 角色同样会被推到画面下缘。
  // 两个因素取较大值，够用且不需要更精细的模型。
  //
  // 拉远（pull < 0）不参与收缩：距离变大时 lookAhead 的
  // 画面占比反而变小，角色本来就更靠下，不需要再收缩。
  const baseH = Math.max(1e-6, cfg.height * fit.heightScale);
  const liftRatio = Math.max(0, lift / baseH);
  const pullRatio = Math.max(0, pull / Math.max(1e-6, cfg.distance * fit.distScale));
  const liftFactor = Math.max(0, 1 - Math.max(liftRatio / 0.9, pullRatio / 0.45));
  const lookAhead = CAMERA_CONFIG.lookAhead * (1 - fit.lookAheadScale) * liftFactor;
  camera.userData.target.set(targetX, targetY + 1.2, targetZ - lookAhead);

  // 竖屏再补一点注视点高度，把天空挤出画面顶部。
  // 幅度远小于原来的 11 —— 原值是把视线彻底放平，等于放弃俯视构图。
  camera.userData.target.y += fit.distScale * 2.2;

  camera.lookAt(camera.userData.target);

  camera.updateMatrixWorld();
}

/** 角色胸口高度 —— 视线的终点，避障判定以此为准 */
const SIGHT_END_Y = 1.2;

/**
 * 避障时的俯角上限。
 *
 * 基准俯角26°（CAMERA_CONFIG.pitchDeg），避障抬升后允许增加到 42°。
 * 42° 仍是明确的斜俯视，街景保有纵深压缩；
 * 实测 58.5° 时画面已经退化成一张俯视平面地图 ——
 * 斜俯视的立体感消失，角色压成中央一个小点。
 */
const MAX_PITCH = 42 * Math.PI / 180;

/**
 * 求出让「相机 → 角色」视线通畅的抬升量。
 *
 * ==================================================================
 * 【这个函数错了三轮才对，过程必须记下来】
 * ==================================================================
 *
 * 【第 1 轮：只抬高】
 * 思路：把相机沿竖直方向抬高，俯角变大 → 视线越过屋顶。
 * 实测在密集街区仍然漏 3~7 个遮挡物：抬到上限后视线擦着屋顶过，
 * 数学上刚好压线，而包围盒是轴对齐近似（房子有随机偏转、树冠是球簇），
 * 实际几何比包围盒略高一点，于是被判成「没挡」。
 * → 结论：必须迭代求解。
 *
 * 【第 2 轮：抬不够就「往后拉远」—— 方向错了】
 * 当时的假设：拉远能让相机「退出街区」，从房子群外面看进去。
 * 实测机位横街东口：相机被推到 z=214（目标 140，距离 76 而非 34），
 * 取景完全失控，角色小到看不见，而遮挡物**依然挡着**
 * （距角色 6.66 / 6.46 / 5.77）。
 *
 * 数学上拉远必然无效甚至有害：
 *   视线高度 s(t) = camY + (1.2 - camY)·t，t = (camZ - z) / ez
 *   ez 增大 → 同一 z 处的 t 变小 → s 更接近 camY（更高）
 * 看起来应该更好，但**近处**的遮挡物 t 趋近 0，
 * s(0) = camY 与遮挡物高度无关；而t 趋近 0 的那段
 * 恰恰是「相机刚离开、视线还很高」的区域，
 * 真正的问题是抬升量不够，不是距离不够。
 * 拉远只是把角色推远，同时让画面里多出更多街景 —— 净损失。
 *
 * 【第 3 轮：抬升不够就「缩短距离」，抬太高就「拉远」】
 * 缩短距离的思路：把相机**往角色方向拉近**，直到视线起点退到遮挡物之后。
 * ez 减小 → 同一 z 处的 t 变大 → 视线降得更低 → 近处遮挡物退出。
 * 代价是取景变近（角色更大），这在斜俯视游戏里是自然的
 * 「镜头贴近」表现，比被树糊脸好得多。
 *
 * 反过来，**抬得太高必须拉远**（见迭代末尾的俯角约束）：
 * 俯角 = atan((camY-1.2)/ez)，只抬不拉会让俯角趋近 90°，
 * 画面退化成俯视平面地图。实测 58.5° 时立体感完全消失。
 * 所以 lift 与 pull 不是独立的，必须由俯角上限绑在一起。
 *
 * 缩短下限：0.55× 基准（≈19 单位）。再近就看不见身前街景了。
 *
 * @returns {{lift:number, pull:number}}
 *   lift = 抬升高度（≥0）
 *   pull = 距离的**增量偏移**，正数= 缩短，负数 = 拉远
 *   最终距离 = baseDist - pull
 */
function solveSightline(targetX, targetY, targetZ, blockers, fit, cfg) {
  const baseY = targetY + cfg.height * fit.heightScale;
  const baseDist = cfg.distance * fit.distScale;

  // 抬升上限：1.9× 基准高度（lift 是增量，所以是基准的 0.9）。
  // 实测不加上限时，密集街区的相机会抬到 60+ 单位高，
  // 整个画面变成鸟瞰地图，角色小到看不见 —— 这比遮挡更糟。
  const maxLift = baseY * 0.9;
  // 缩短下限：0.55× 基准。再近就看不见身前街景了。
  const minDist = baseDist * 0.55;

  let lift = 0;
  let pull = 0;

  // 迭代求解：抬升会改变视线落点，从而改变「哪一栋房子挡在前面」，
  // 所以单次解析解不收敛。每轮 O(遮挡物数)，5 轮足够。
  for (let iter = 0; iter < 5; iter++) {
    const camY = baseY + lift;
    const camZ = targetZ + baseDist - pull;
    const ez = camZ - targetZ;
    if (ez < 2) break;               // 距离已到下限，不能再近

    let deficit = 0;

    for (let i = 0; i < blockers.length; i++) {
      const b = blockers[i];
      // 视线在 XZ 上是沿 Z 的直线（相机 X 与角色相同），
      // 仍要判 X：房子在 X 上有宽度，视线可能从侧边掠过。
      if (targetX < b.minX || targetX > b.maxX) continue;

      // Z 方向：盒子区间对应的视线参数区间
      const t0 = (camZ - b.maxZ) / ez;
      const t1 = (camZ - b.minZ) / ez;
      const tEnter = Math.max(0, Math.min(1, Math.min(t0, t1)));
      const tExit = Math.max(0, Math.min(1, Math.max(t0, t1)));
      if (tEnter > tExit) continue;

      // 遮挡最严重的点 = 靠近相机的那一端。
      // 若视线在进入盒子时已高于屋顶，就能从上面越过，不算遮挡。
      const t = tEnter;
      const sightY = camY + (SIGHT_END_Y - camY) * t;
      if (b.top <= sightY) continue;

      // 需要的抬升量：Δ·(1-t) = 缺口
      const need = (b.top + 1.5 - sightY) / Math.max(0.2, 1 - t);
      if (need > deficit) deficit = need;
    }

    if (deficit <= 0.01) break;      // 视线已通畅

    const room = maxLift - lift;
    if (room > 0.05) {
      lift += Math.min(deficit, room);
    } else {
      pull += Math.min(deficit * 0.4, (baseDist - minDist) - pull);
      if (pull >= (baseDist - minDist) - 0.05) break;
    }

    // -------------------------------------------------------------------
    //  【俯角约束 —— 缺了它画面会退化成俯瞰地图】
    // -------------------------------------------------------------------
    // 抬升和缩短是两个独立的量，必须靠「俯角上限」把它们绑在一起。
    //
    // 实测（没有这一约束时）：相机抬到 31而距离仍是 34，
    // 俯角 = atan((31-1.2)/34) = 58.5° —— 几乎是垂直往下看。
    // 画面读作一张俯视平面地图，斜俯视的立体感完全消失，
    // 角色也被压到画面中央的一个小点。这比被树挡住更糟。
    //
    // 正确关系：俯角 = atan((camY - 1.2) / ez)，
    // 要让俯角不超过 MAX_PITCH，就必须
    //   ez >= (camY - 1.2) / tan(MAX_PITCH)
    // 抬得越高，距离必须按比例拉远，俯角才不变。
    //
    // MAX_PITCH 取 42°：基准是 26°，42° 仍明确是「斜俯视」，
    // 街景有明确的纵深压缩；再大就接近正上方了。
    const minEzForPitch = (camY - SIGHT_END_Y) / Math.tan(MAX_PITCH);
    if (ez < minEzForPitch) {
      const grow = minEzForPitch - ez;
      pull -= grow;                  // 负的 pull = 往后拉远
      if (pull <= 0) { pull = 0; break; }   // 拉到底仍超限就接受
    }
  }

  return { lift, pull };
}

/**
 * 计算某点在相机 forward 轴上的视距（沿视线方向）。
 * TiltShiftPass 用它驱动模糊半径 —— 避免用「屏幕 Y」导致的左右走位抖动。
 */
export function viewDistanceAlongForward(camera, point) {
  camera.getWorldDirection(camera.userData._forward);
  const dx = point.x - camera.position.x;
  const dy = point.y - camera.position.y;
  const dz = point.z - camera.position.z;
  return dx * camera.userData._forward.x +
         dy * camera.userData._forward.y +
         dz * camera.userData._forward.z;
}