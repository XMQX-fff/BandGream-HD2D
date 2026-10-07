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
  /**
   * 横移量的**滤波后**取值。
   *
   * 【为什么需要它 —— 抖动是实测出来的，不是设想的】
   * shiftX 来自离散搜索（步长 4.08），玩家沿街走时街边树不断进出视野，
   * 于是目标横移在 0 与 16.3 之间反复跳。相机阻尼每帧只走 10%，
   * 约 0.4 秒才跟上 —— 玩家看到的就是「镜头每隔一两秒横向抽搐一下」。
   *
   * 静态机位测试**完全测不出这个问题**（每个点都等 15 秒才采样，
   * 抖动早就衰减完了）。只有连续行走才能暴露。
   */
  cam.userData._shiftX = 0;
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
  let shiftX = 0;
  if (blockers && blockers.length) {
    const sol = solveSightline(targetX, targetY, targetZ, blockers, fit, cfg);
    lift = sol.lift;
    pull = sol.pull;
    shiftX = sol.shiftX;
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
  // 横移必须与注视点同步（见 solveSightline 注释）：
  // 相机移了、注视点不移，角色就会在画面里横向漂出去。
  //
  // 【横移要先做一阶低通，不能直接用求解值】
  // 求解结果是离散跳变的（0 ↔ 4.08 ↔ … ↔ 16.3），玩家沿街走时
  // 街边树不断进出视野，目标值每1~2 秒跳一次。
  // 直接用会让相机横向抽搐，所以这里按「接近目标」的速率缓动。
  //
  // 速率取 2.5/s：比位移阻尼（6.5）慢，横移显得是「镜头缓缓让开」；
  // 但快到 0.4 秒内就能跟上，玩家不会觉得镜头跟不上自己。
  // 上限 20/s：目标突然反向（绕过一棵树后下一棵树在另一侧）时
  // 仍能在半秒内纠正，否则会「卡在错误的一侧」持续遮挡。
  const SHIFT_RATE = 2.5;
  const SHIFT_RATE_REVERSE = 20;
  const prevShift = camera.userData._shiftX;
  const shiftRate = Math.abs(shiftX) < Math.abs(prevShift) ? SHIFT_RATE : SHIFT_RATE_REVERSE;
  const step = (shiftX - prevShift) * (1 - Math.exp(-shiftRate * dt));
  const shiftFiltered = prevShift + step;
  camera.userData._shiftX = shiftFiltered;
  desired.x = targetX + shiftFiltered;

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
  // 横移量同步加到注视点上：相机移了、注视点不移，角色就会在画面里
  // 横向漂出去（看起来像镜头歪了，而不是镜头绕开了遮挡物）。
  // 两边同量偏移后，视线整体平移，角色恒在画面中央。
  camera.userData.target.set(
    targetX + shiftFiltered, targetY + 1.2, targetZ - lookAhead);

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
 * 基准俯角 26°（CAMERA_CONFIG.pitchDeg），避障抬升后允许增加到 48°。
 *
 * 【为什么是 48° —— 权衡的两头都要真实】
 * 42° 时实测仍有 3/5 机位被挡：房子高 6~11、间距仅 13~17，
 * 而相机在角色 +Z 侧 34 处，视线要跨过2~3 栋房子才能到角色。
 * 俯角太小 → 抬不够 → 被房子糊脸。
 * 俯角太大 → 画面退化成俯视平面地图，斜俯视立体感消失。
 * 实测 58.5° 时画面已经是「一张地图」，角色压成中央小点。
 *
 * 48° 是实测平衡点：仍明确是斜俯视（能读出街景的纵深与屋顶斜面），
 * 同时给足抬升余量让绝大多数机位视线通畅。
 */
const MAX_PITCH = 48 * Math.PI / 180;

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
 * 【第三根杠杆：水平绕行 shiftX】
 * 抬升与缩短都救不了「房子正好在角色正后方」的情况。
 * 实测 (12,144)：角色被碰撞挤到一栋 top=8.3 的房子旁仅 1.1 处，
 * 抬到 48° 上限、缩短到极限，视线掠过房顶时 rayY 最高只有 6.75——
 * 仍低于 8.3。抬升与缩短两条路都已用尽，几何上无解。
 *
 * 根因：相机固定在角色 +Z 侧，只要那个方向有房子，就永远差那么一点。
 * 真正的解法是**把相机沿 X 横移**，让视线从房子侧边绕过。
 * 代价是视线变斜 —— 所以必须**同时把注视点横移同样的量**，
 * 角色就仍然停在画面中央，横移只改变观察角度、不改变构图。
 *
 * @returns {{lift:number, pull:number, shiftX:number}}
 *   shiftX = 相机与注视点共同的水平偏移（左右各试，取通畅的一侧）
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
  // 注意这个下限**只约束「为躲遮挡而缩短」**，
  // 不约束俯角约束要求的「拉远」—— 拉远只会让取景更远，
  // 不会造成「看不见身前街景」的问题。
  const minDist = baseDist * 0.55;

  // 横移上限：街宽量级。再大相机会绕到对面建筑里，
  // 而且构图偏移观感明显 —— 玩家会觉得「镜头歪了」。
  const maxShift = baseDist * 0.5;

  let lift = 0;
  let pull = 0;
  let shiftX = 0;

  /**
   * 视线是否通畅（不含任何调整）。
   * 抽成函数是因为俯角约束要在「调整完成之后」再验一次 ——
   * 拉远相机会改变 t，进而可能引入新的遮挡。
   */
  const sightGap = (camY, camZ, sx) => {
    const ez = camZ - targetZ;
    if (ez < 1e-3) return 0;
    let gap = 0;
    for (let i = 0; i < blockers.length; i++) {
      const b = blockers[i];
      const t0 = (camZ - b.maxZ) / ez;
      const t1 = (camZ - b.minZ) / ez;
      const tEnter = Math.max(0, Math.min(1, Math.min(t0, t1)));
      const tExit = Math.max(0, Math.min(1, Math.max(t0, t1)));
      if (tEnter > tExit) continue;

      // 视线在 XZ 上不再是沿 Z 的直线：t=0 在相机端 (targetX+sx)，
      // t=1 在角色 (targetX)，所以任意 t 处的 x = targetX + sx*(1-t)。
      //
      // 判据随之改变：不再问「targetX 在不在盒子 X 内」，
      // 而是问「视线穿过盒子 Z 区间的那一小段，x 有没有落进盒子 X 内」。
      // 横移正是靠这一步生效的 —— 视线斜了，就能从房子侧边掠过。
      const xIn = targetX + sx * (1 - tEnter);
      const xOut = targetX + sx * (1 - tExit);
      if (Math.max(xIn, xOut) < b.minX || Math.min(xIn, xOut) > b.maxX) continue;

      // ---------------------------------------------------------------
      //  【缺口必须按 tExit 算，不是 tEnter】—— 这一处算错过
      // ---------------------------------------------------------------
      // 视线高度沿 t 单调下降：rayY(t) = camY + (1.2 - camY)·t
      // 所以在盒子区间内，**tExit 处视线最低**，那才是真正的瓶颈。
      //
      // 用 tEnter 会得到「视线刚进盒子时的高度」——那时还在高处，
      // 算出来的缺口是负数，于是把一个明确遮挡的盒子判成「不挡」。
      //
      // 实测：城区西北机位，相机 y=31.5/z=153.7，角色 z=120，
      // 房子顶 8.17、位于角色 +Z 侧 7.92：
      //   tEnter=0.676 → rayY=11.02（高于屋顶 8.17）
      //   tExit =0.854 → rayY=5.62 （低于屋顶 8.17）← 视线在这里穿过了屋顶
      //   用 tEnter: need = -4.16  → 误判「不挡」
      //   用 tExit : need = +20.23 → 正确判定「遮挡」
      //
      // 判据的正确写法：视线在区间内是否**跨过**了顶面，
      // 即 t_enter 处高于顶、t_exit 处低于顶。
      const sightIn = camY + (SIGHT_END_Y - camY) * tEnter;
      const sightOut = camY + (SIGHT_END_Y - camY) * tExit;
      if (sightOut >= b.top) continue;          // 离开盒子时仍高于顶 → 能越过
      if (sightIn <= SIGHT_END_Y) continue;     // 进入盒子时已在地面以下 → 不成立

      const need = (b.top + 1.5 - sightOut) / Math.max(0.2, 1 - tExit);
      if (need > gap) gap = need;
    }
    return gap;
  };

  // ---- 第 1 阶段：求一个「视线通畅」的抬升/距离组合 ----
  // 迭代求解：抬升会改变视线落点，从而改变「哪一栋房子挡在前面」，
  // 所以单次解析解不收敛。每轮 O(遮挡物数)，6 轮足够。
  for (let iter = 0; iter < 6; iter++) {
    const camY = baseY + lift;
    const ez = baseDist - pull;
    if (ez < 2) break;               // 距离已到下限，不能再近

    const gap = sightGap(camY, targetZ + ez, shiftX);
    if (gap <= 0.01) break;          // 视线已通畅

    // 抬升优先；抬到上限仍不够就缩短距离。
    const room = maxLift - lift;
    if (room > 0.05) {
      lift += Math.min(gap, room);
    } else {
      pull += Math.min(gap * 0.4, (baseDist - minDist) - pull);
    }
  }

  // ---- 第 2 阶段：俯角约束（必须在调整完成之后一次性生效）----
  //
  // 【这一段的位置是关键，写在迭代里会失效】
  //
  // 第一版把约束放进迭代循环开头，结果与末尾的缩短逻辑互相拉扯：
  //   约束算出 pull -= 14.9（要拉远）
  //   同一轮末尾缩短逻辑又pull += ...
  //   下一轮约束再减……
  // 两个方向在同一个变量上反复覆盖，最终收敛到「缩短下限」，
  // 俯角依然是 58.5°，约束形同虚设。
  //
  // 约束是**边界条件**，不是迭代的一部分：
  // 先求出任意一个可行解，再一次性把它投影到俯角允许的范围内。
  //
  // 俯角 = atan((camY - 1.2) / ez) <= MAX_PITCH
  // ⟺ ez >= (camY - 1.2) / tan(MAX_PITCH)
  // 抬得越高，距离必须按比例拉远，俯角才不变。
  //
  // 拉远之后视线会变得更平，可能重新被远处的房子挡住 ——
  // 所以要再抬一点补回来，抬升上限依然生效。
  for (let guard = 0; guard < 3; guard++) {
    const camY = baseY + lift;
    const ez = baseDist - pull;
    const minEz = (camY - SIGHT_END_Y) / Math.tan(MAX_PITCH);
    if (ez >= minEz) break;          // 俯角已合规

    // 先直接按比例拉远到合规
    pull -= (minEz - ez);

    // 拉远后视线可能重新被挡 —— 补一次抬升
    const newEz = baseDist - pull;
    const gap = sightGap(camY, targetZ + newEz, shiftX);
    if (gap > 0.01 && maxLift - lift > 0.05) {
      // 抬升会让俯角再次超限，所以只能抬「刚好够」的部分
      lift += Math.min(gap, maxLift - lift);
    }
  }

  // ---- 第 3 阶段：水平绕行（唯一能解决「正后方有房」的手段）----
  //
  // 走到这里说明抬升与缩短都已用尽，视线仍被挡。
  //
  // 【横移必须与缩短联合，单靠横移无效 —— 这是本阶段的核心】
  // 视线在盒子处的横向位移 = sx · (1 - tExit)。
  // 房子通常在角色身后不远处，此时 tExit ≈ 0.87，(1 - tExit) ≈ 0.13 ——
  // 也就是说 sx 挪 17 单位，视线在房子处只横移了 2.25。
  // 而 7.6 宽的房子需要横移 ≥3.6 才绕得出去。**纯横移差了一倍。**
  //
  // 反过来缩短距离会让tExit 变小、(1-tExit) 变大，横移效率显著提高：
  //   ez=34 → (1-tExit)=0.13 → sx=17 只横移 2.25（不够）
  //   ez=19 → (1-tExit)=0.24 → sx=17 横移 4.03（够）
  // 所以这里对每个横移量都重新解一遍最短可用距离，取两者都满足的第一个解。
  //
  // 【搜索顺序即择优】
  // 可行解有无数个（横移越大、距离越近都能绕出去），但代价不同：
  // 横移让构图歪、缩短让取景近。先扫横移方向与幅度（由小到大），
  // 对每个横移量再从当前距离一路缩到下限 ——
  // 于是找到的第一个解就是「横移最小、且在该横移下取景最远」的组合。
  // 抬升不动：它已经在前两阶段用尽，这里再动只会让俯角更陡。
  if (sightGap(baseY + lift, targetZ + (baseDist - pull), 0) > 0.01) {
    const STEP = baseDist * 0.12;          // 每次横移约 4 单位
    const STEPS = Math.max(1, Math.round(maxShift / STEP));
    // 候选距离：从当前距离一路试到缩短下限。
    // 逐个距离 × 逐个横移，找到第一个通畅组合即停 ——
    // 距离按「由远到近」排列，所以找到的第一个就是取景最远的那档。
    let best = null;
    for (let dir = -1; dir <= 1 && !best; dir += 2) {
      for (let k = 1; k <= STEPS && !best; k++) {
        const sx = dir * k * STEP;
        // 俯角 = atan((camY - SIGHT_END_Y) / ez) <= MAX_PITCH
        //     ⟺ ez >= (camY - SIGHT_END_Y) / tan(MAX_PITCH)
        //
        // 【为什么必须逐个校验，而不是只在阶段结束时统一处理】
        // 缩短到下限(0.55×34≈19) 且camY 已抬到 31.5 时，
        // 俯角 = atan(30.3/19) = 58°，直接突破 48° 上限——
        // 画面退化成俯视平面地图，比被房子挡住更糟。
        // 实测正是这样：横街西口俯角飙到 54.7°。
        //
        // 最短合法距离就是这个 minEz，循环从它开始。
        const minEz = (baseY + lift - SIGHT_END_Y) / Math.tan(MAX_PITCH);
        for (let ez = baseDist - pull; ez >= minEz - 1e-6; ez -= STEP * 0.5) {
          if (sightGap(baseY + lift, targetZ + ez, sx) <= 0.01) {
            best = { sx, ez };
            break;
          }
        }
      }
    }
    if (best) {
      shiftX = best.sx;
      // 缩短量转回 pull 的表达（pull > 0 表示缩短）
      pull += (baseDist - pull) - best.ez;
    }
  }

  // ---- 兜底：任何路径都不允许突破俯角上限 ----
  // 上面三个阶段各自都会改动 lift / pull，理论上可能叠加出超限的组合。
  // 这个函数**绝不能返回俯角超过 MAX_PITCH 的解**——
  // 画面退化成俯视平面地图，比被任何东西遮挡都更糟。
  // 所以在这里无条件校正一次，不信任调用路径的自洽性。
  {
    const finalCamY = baseY + lift;
    const minEz = (finalCamY - SIGHT_END_Y) / Math.tan(MAX_PITCH);
    const ez = baseDist - pull;
    if (ez < minEz) pull -= (minEz - ez);      // 拉远到合规
  }

  return { lift, pull, shiftX };
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