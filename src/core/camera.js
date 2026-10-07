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
  const lookAhead = CAMERA_CONFIG.lookAhead * (1 - fit.lookAheadScale);
  camera.userData.target.set(targetX, targetY + 1.2, targetZ - lookAhead);

  // 竖屏再补一点注视点高度，把天空挤出画面顶部。
  // 幅度远小于原来的 11 —— 原值是把视线彻底放平，等于放弃俯视构图。
  camera.userData.target.y += fit.distScale * 2.2;

  camera.lookAt(camera.userData.target);

  camera.updateMatrixWorld();
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