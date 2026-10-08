/**
 * 入口：引导、渲染循环、resize
 */
import { Vector3, Raycaster } from 'three';
import { createRenderer, createComposer, PIXEL_SIZE } from './core/renderer.js';
import { createCamera, updateCamera, viewDistanceAlongForward, CAMERA_CONFIG, cameraFit } from './core/camera.js';
import { createInput } from './core/input.js';
import { createScene, WORLD } from './world/scene.js';
import { createCharacter } from './world/character.js';
import { mergeStatics, countDrawables } from './core/optimize.js';
import { bakeVertexAO } from './core/vertexAO.js';
import { createFade, injectFade } from './core/fade.js';

const canvas = document.getElementById('scene');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');

const renderer = createRenderer(canvas);
const camera = createCamera();
const { scene, sun, water, blockers, buildingTags, SUN_OFFSET } = createScene();

// 遮挡物列表（房子 + 树）同时交给两个消费方：
//   相机 —— 视线避障，避免镜头穿墙 / 被树冠糊脸
//   角色 —— 碰撞，防止玩家走进房子内部
//
// 【为什么必须是同一份列表】
// 之前相机用的是 city.js 的 houseBounds（只有房子），
// 角色则完全没有碰撞 —— 两个消费方拿到的是不一致的信息，
// 于是出现「相机认为视线通畅、实际被树挡住」这类
// 只有射线诊断才能发现的偏差。单一数据源消除这类不一致。
camera.userData.blockers = blockers;

const { composer, tiltShift } = createComposer(renderer, scene, camera);
const input = createInput(window);

// ---------- 角色 ----------
const hero = createCharacter('hero');
// 碰撞必须在 setPosition 之前注入 —— 出生点本身也要过碰撞，
// 否则手滑改错坐标就会把角色塞进墙里，且没有任何报错。
hero.setColliders(blockers);
// 出生点 (6,14)：偏离喷泉中轴。
//
// 【为什么不放广场正中】斜俯视相机在角色正后方，角色永远处于
// 喷泉与相机之间 —— 出生在x=0 时主角会被喷泉立柱整个挡住，
// 画面上只剩一团影子（实测：完全看不见角色）。
// 偏到x=6 之后，喷泉在角色左前方，两者轮廓不重叠。
hero.setPosition(6.0, 14.0);
scene.add(hero.sprite);
scene.add(hero.shadow);

// NPC（静态，做场景氛围）—— 每个 key 对应图集里的一列（见 cast.meta.json）
const npcs = [
  { key: 'npcFisher',  x: -8.5,  z: 1.0,  dir: 0 },
  { key: 'npcGuard',   x: 7.5,   z: 0.0,  dir: 3 },
  { key: 'npcChild',   x: -3.5,  z: 5.0,  dir: 0 },
  { key: 'npcFisher2', x: 11.0,  z: 3.5,  dir: 2 },
  { key: 'npcChild2',  x: -10.5, z: 9.0,  dir: 1 },
  { key: 'npcGuard2',  x: 4.0,   z: 14.0, dir: 0 },
  { key: 'npcElder',   x: -13.0, z: -1.0, dir: 0 },
  { key: 'npcFisher',  x: 12.5,  z: -1.5, dir: 2 }
].map((cfg) => {
  const c = createCharacter(cfg.key);
  // NPC 也注入碰撞：它们固定不动，setPosition 的推出逻辑
  // 能保证「坐标写错时不会静默地把 NPC 塞进墙里」——
  // 实测把 NPC 放在喷泉台上时，画面上就只剩一根柱子。
  c.setColliders(blockers);
  c.setPosition(cfg.x, cfg.z);
  c.setDir(cfg.dir);
  scene.add(c.sprite);
  scene.add(c.shadow);
  return c;
});

// ---------- 静态合并 ----------
// 在角色创建之后调用：角色精灵/影子带 dynamic 标记会被自动跳过。
// 调试模式：?debug=raw 跳过全部后处理，?debug=noao 跳过顶点 AO，
//?debug=nomerge 跳过静态合并（射线诊断用 —— 合并后整座城是一个
// 巨型 mesh，射线只能知道「被合并体挡住」，无法定位是哪一个物体）。
//
// 【必须声明在 frame() 之前】
// 之前这段在文件末尾用 const 声明，而 frame() 在首帧就读它——
// const 有暂时性死区，首帧必然抛 ReferenceError: Cannot access 'DEBUG'
// before initialization，整帧渲染直接挂掉，画面停在空白。
const DEBUG = new URLSearchParams(location.search).get('debug');
const DEBUG_RAW = DEBUG === 'raw';
const DEBUG_NOAO = DEBUG === 'noao';
const DEBUG_NOMERGE = DEBUG === 'nomerge';

if (DEBUG) console.warn(`[debug] ${DEBUG}：调试模式已启用`);

// 把上千个构件按材质合并成几十个 mesh，draw call 数量级下降。
const mergeStats = DEBUG_NOMERGE
  ? { before: 0, after: 0, meshes: [] }
  : mergeStatics(scene);

// 顶点 AO 烘焙 —— 必须在合并之后做：
// 合并器把世界变换烘进了顶点，AO 才能按最终世界坐标计算。
// 放在合并之前只能拿到物体局部坐标，墙根高度会算错。
const aoResult = (DEBUG_RAW || DEBUG_NOAO || DEBUG_NOMERGE)
  ? { baked: 0, skipped: 0 }
  : bakeVertexAO(scene.children, {
  // 水面与天空穹顶不能烘 AO：它们的法线与高度都不参与遮蔽逻辑，
  // 强加会让水面出现整片灰暗。
  skip: (m) => !m.isMesh || m.name === 'water' || m.name === 'skydome'
});
console.info(`[HD2D] vertex AO: ${aoResult.baked} vertical meshes baked, ${aoResult.skipped} horizontal skipped`);

// ---------- 建筑遮挡淡出 ----------
//
// 【为什么必须在 AO 烘焙之后注入】
// bakeVertexAO 会为每个烘过的 mesh **克隆材质**（并按源材质缓存复用）。
// 若在它之前注入 onBeforeCompile，克隆出来的材质不会继承注入 ——
// 淡出会对「原材质生效、对克隆材质失效」，
// 而恰好所有竖直构件（墙，也就是最该淡出的部分）都走了克隆。
// 这个顺序依赖很隐蔽，日志里也看不出来，只有画面上「有的淡有的不淡」。
//
// 【为什么按 blockers 而不是「可见栋」建表】
// fadeGroup 就是 blockers 的下标（见 city.js registerBlocker），
// 所以查找表直接以 blockers 为准，一张表覆盖全部登记物，
// 不需要额外的映射或重建。
const fade = DEBUG_NOMERGE
  ? null
  : createFade(blockers);

if (fade) {
  injectFade(mergeStats.materials, fade.texture);
  console.info(`[HD2D] building fade: ${blockers.length} groups, lut ready`);
}

// ---------- resize ----------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h;
  camera.aspect = aspect;
  // 竖屏/横屏切换时 FOV 也要跟着变，否则手机旋转屏幕后视野会突然被裁掉
  camera.fov = CAMERA_CONFIG.fov * cameraFit(aspect).fovScale;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ---------- 循环 ----------
// rAF 时间戳与 performance.now() 同源，但仍在首帧做一次对齐，
// 确保第一帧的 dt 为 0 而非负数
let last = null;
const playerPos = new Vector3();

/**
 * 俯角环形缓冲（见 frame() 内的说明）。
 * 只在诊断脚本主动索取时才分配 —— 正常游玩不需要它。
 */
let pitchLog = null;
let pitchIdx = 0;
let PITCH_LOG = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;

  // dt 必须钳制在 (0, 0.05]。若为负（或首帧的 last 与 rAF 时间基不一致），
  // 相机阻尼系数会变成负数，lerp 每帧把相机推得更远，指数发散到 1e7量级。
  const rawDt = last === null ? 0 : (now - last) / 1000;
  const dt = Number.isFinite(rawDt) ? Math.min(0.05, Math.max(0, rawDt)) : 0.016;
  last = now;

  // 输入：屏幕上下 => 世界 -Z/+Z（相机在 +Z 后方看向 -Z）
  const mv = input.vector();
  const speedScale = 1.0;
  const dx = mv.x * speedScale;
  const dz = -mv.z * speedScale; // W(up) => 向北(-Z)

  hero.update(dt, dx, dz, WORLD.bounds);

  // 阴影相机跟随玩家，保证 texel 密度。
  //
  // 这里必须用与 scene.js 里定义太阳时**同一组偏移量**。
  // 之前这里硬编码了 (34,46,26)，每帧把 scene.js 精心调好的侧逆光
  // (-30,34,40) 覆盖回正前方 —— 结果所有物体正面受光、没有暗面，
  // 画面被拍平成「无立体感的贴纸」，而我一直在 scene.js 里调参数却看不到任何变化。
  // 唯一光源只有一个，所以偏移量必须来自单一数据源。
  playerPos.set(hero.state.x, 0, hero.state.z);
  sun.position.set(
    playerPos.x + SUN_OFFSET.x,
    SUN_OFFSET.y,
    playerPos.z + SUN_OFFSET.z
  );
  sun.target.position.copy(playerPos);
  sun.target.updateMatrixWorld();


  // 相机跟随
  updateCamera(camera, hero.state.x, 0, hero.state.z, dt);

  // ---------------------------------------------------------------------
  //  建筑遮挡淡出
  // ---------------------------------------------------------------------
  //
  // 【为什么用 camera.position 而不是 desired】
  // desired 是相机「即将到达」的位置，而实际渲染的是 camera.position
  // （已被阻尼插值）。用 desired 判定会提前一帧淡出 ——
  // 表现为角色还在楼前，楼就先淡了，边缘处闪一下。
  //
  // 【为什么必须在 updateCamera 之后】
  // 判定依赖相机的真实位置与朝向。updateCamera 之前 camera.position
  // 还是上一帧的落点，视线与实际画面不一致。
  //
  // 【终点用角色脚下而非胸口】
  // 遮挡判据要的是「角色被挡住没有」，而角色精灵的贴图重心在脚下
  // 附近。终点取 y=1.2（与 camera.js 的 SIGHT_END_Y 一致），
  // 保证两套判据对「挡没挡」的判断不会打架 ——
  // 若这里用别的值，会出现「相机认为通畅、淡出认为遮挡」的空档，
  // 画面表现是「楼没淡但角色还是被挡」。
  if (fade) {
    fade.update(
      camera.position.x, camera.position.y, camera.position.z,
      hero.state.x, hero.state.z, dt
    );
  }

  // 俯角时间序列 —— 供 tools/pitch_test.py 读取。
  //
  // 【为什么必须逐帧记录，不能只暴露「当前俯角」】
  // 「镜头跳变」是帧与帧之间的现象：相机在 24.6° 与 48.1° 之间反复切换。
  // 任何只读「某一瞬间俯角」的诊断都测不到它——
  // 读到多少完全取决于你在跳变的哪个相位上采样，
  // 而静态机位测试（每点等 15 秒收敛后读一次）更是恒定读到一个稳定值。
  // 只有把每一帧的俯角排成时间序列，才能算出摆幅与跳变频率。
  //
  // 环形缓冲：固定长度覆盖最近约 4 秒（60fps × 240），
  // 诊断脚本读它就得到连续信号。开销是每帧一次 Math.atan2，可忽略。
  if (PITCH_LOG) {
    pitchLog[pitchIdx] = Math.atan2(camera.position.y - 1.2,
      Math.max(0.001, camera.position.z - hero.state.z)) * 180 / Math.PI;
    pitchIdx = (pitchIdx + 1) % PITCH_LOG;
  }

  // 水面动画
  if (water.userData.update) water.userData.update(t);

  // 景深聚焦半径跟随角色视距
  const viewDist = viewDistanceAlongForward(
    camera,
    new Vector3(hero.state.x, 1.0, hero.state.z)
  );
  tiltShift.update(viewDist, CAMERA_CONFIG.height);

  if (DEBUG === 'raw') {
    renderer.render(scene, camera);
  } else {
    composer.render();
  }
}

// ---------- 启动 ----------
onResize();

/**
 * 让相机立即落到「跟随角色」的稳态位置，跳过阻尼插值。
 *
 * 【实现要点：不能简单地 camera.position.copy(desired)】
 * desired 只在 updateCamera 内部算出来，算完立刻就被 lerp 消费掉了，
 * 外部拿不到。所以这里复用同样的公式重算一次——
 * **必须与 updateCamera 的基准一致**，否则相机会落在
 * 「角色位置对、俯角错」的中间态，比不等还糟。
 *
 * 三个通道都要处理：
 *   位置（含抬升/横移/缩距）→ 由 solveSightline 的结果决定
 *   注视点（含 lookAhead 随抬升收缩）→ 同上
 *   朝向 → lookAt
 *
 * 不改 userData 里的滤波状态（_lift/_shiftX/_clearFor）：
 * 那些是「动画进行中」的状态，瞬移后让它们保持原值，
 * 下一帧 updateCamera 会自然收敛到新位置——
 * 强行清零反而会造成一次可见的镜头跳动。
 */
function snapCamera() {
  const cfg = CAMERA_CONFIG;
  const fit = cameraFit(camera.aspect);
  const cam = camera.position;
  const tx = hero.state.x;
  const tz = hero.state.z;

  // 与 updateCamera 相同的基准高度/距离
  const baseY = cfg.height * fit.heightScale;
  const baseDist = cfg.distance * fit.distScale;

  // 稳态下滤波值已收敛，直接用当前滤波值当目标
  const lift = camera.userData._lift;
  const pull = camera.userData._pull;
  const shift = camera.userData._shiftX;

  cam.x = tx + shift;
  cam.y = baseY + lift;
  cam.z = tz + baseDist - pull;

  // 注视点：与 updateCamera 同款，lookAhead 按抬升/缩距收缩
  const liftRatio = Math.max(0, lift / Math.max(1e-6, baseY));
  const pullRatio = Math.max(0, pull / Math.max(1e-6, baseDist));
  const liftFactor = Math.max(0, 1 - Math.max(liftRatio / 0.9, pullRatio / 0.45));
  const lookAhead = cfg.lookAhead * (1 - fit.lookAheadScale) * liftFactor;
  camera.userData.target.set(tx + shift, 1.2 + fit.distScale * 2.2, tz - lookAhead);
  camera.lookAt(camera.userData.target);
  camera.updateMatrixWorld();
}

// 贴图异步加载，等一帧渲染完成后再淡出 loading
requestAnimationFrame(frame);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    loadingText.textContent = '准备就绪';
    loadingEl.classList.add('hidden');
  });
});

// 调试钩子：供截图脚本读取渲染状态
window.__HD2D__ = {
  ready: true,
  pixelSize: PIXEL_SIZE,
  // 暴露诊断脚本需要的构造器。
  // 只给 Raycaster / Vector3 两个具名导入 —— 写成 `import * as THREE`
  // 会把整个 three 命名空间钉死，tree-shaking 失效，产物直接翻几倍。
  THREE: { Raycaster, Vector3 },
  mergeStats,
  // scene 本身：诊断脚本要 traverse 才能统计
  // 「有多少 mesh 带 aFadeId」「有没有房子落在水面外」——
  // 这两类问题只看 blockers 数组是答不出来的。
  scene,
  drawables: () => countDrawables(scene),
  /**
   * 主角控制器 —— 诊断脚本要跑**真实的**碰撞求解，
   * 不能在脚本里抄一份（抄的那份会随实现演进而过期，
   * 且过期的副本报出来的数字看着和真实的一样）。
   */
  hero,
  /**
   * 当前淡出状态。诊断脚本读它确认淡出真的在发生
   * —— 画面上「楼变透明了」也可能来自后处理，不一定是我们注入的。
   */
  fadeStats: () => (fade ? fade.stats() : null),
  /**
   * 只算「该淡出谁」，不改动任何状态。
   *
   * 【为什么需要它 —— 测试机位不能再靠手挑】
   * 原先 fade_probe.py 里四个机位坐标是手写的常数。
   * 布局一改版（civic 地块留空、sparse 缺边），
   * 那些坐标周围可能已经没有建筑了 ——
   * 测出「0 栋淡出」，看起来像功能没生效，
   * 实际是**测试点选在了空地上**。
   *
   * 与其猜坐标，不如让代码自己回答：
   * 扫全城、返回真正会触发的点。这才是可信的测试集。
   *
   * 参数与 fade.probe 一致（相机位置 + 角色位置），
   * 刻意**不接受 dt、也不写状态**——
   * 诊断要的是「这一刻该淡谁」这个几何事实，
   * 而不是「低帧率下跑了 3 帧后淡到了什么程度」。
   */
  fadeProbe: fade ? fade.probe : null,
  /**
   * 可玩城区范围（WORLD.bounds）。
   * 诊断脚本必须按它圈定采样区 —— 遮挡物列表里还含 createOutskirts
   * 撒的郊野散点，按遮挡物边界采样会跑到「房子浮在水面上」的荒地，
   * 拍出来的图与城区布局毫无关系。
   */
  worldBounds: WORLD.bounds,
  /**
   * 立刻复位全部淡出状态（诊断用）。
   * 软渲染只有 1.2 fps，靠「等它恢复」测不出干净的状态 ——
   * 每个机位前先复位，断言才是确定性的。详见 core/fade.js 的 reset()。
   */
  fadeReset: fade ? fade.reset : null,
  getState: () => ({
    x: hero.state.x, z: hero.state.z, dir: hero.state.dir,
    // 卡在实心体内 = 穿模。诊断脚本据此判断碰撞是否生效。
    stuck: hero.isStuck()
  }),
  setPlayerPos: (x, z) => hero.setPosition(x, z),
  /**
   * 瞬移角色**并让相机立即落位**（跳过阻尼）。
   *
   * 【为什么必须单独开这个接口 —— 淡出测试踩出来的坑】
   * setPlayerPos 只挪角色，相机仍被阻尼拉着飞过去。
   * 软渲染下帧率只有 0.6 fps，阻尼系数 6.5/s 需要
   * 「帧数 × dt」累积到足够大才能收敛 ——
   * 实测等了 7 秒相机还停在半路（角色 z=190，相机却在 z=215，
   * 方向甚至是反的），此时视线暂时通畅，
   * 于是四个机位测出来的遮挡数全是 0。
   *
   * 症状极具误导性：看起来像「淡出功能完全没生效」，
   * 实际是**相机根本没到测试位置**。
   * 而淡出判定用的正是相机的真实位置 ——
   * 判定没错，是输入的状态不对。
   *
   * 顺带也修好了截图脚本的老问题：
   * city_shots.py 靠 SETTLE_MS=11000 硬等收敛，
   * 在 0.6 fps 下这11 秒只跑了 6~7 帧，收敛并不彻底。
   */
  teleport: (x, z) => {
    hero.setPosition(x, z);
    snapCamera();
  },
  /**
   * 只改朝向、不改位置。截图脚本用。
   * 【为什么需要单独一个接口】dir 是 0~3 的方向枚举,只在 character.js 的
   * move() 里由移动向量推导。之前只能「边走边转」,截图脚本要么走一段路
   * (位置就偏了,拍不到目标机位),要么直接改内部 state(那是作弊,绕过封装)。
   *所以在调试钩子里补一个显式 setter,取值与 dirFromVector 完全一致:
   *   0=南(+z) 1=北(-z) 2=西(-x) 3=东(+x)
   */
  faceTo: (deg) => {
    const a = ((deg % 360) + 360) % 360;
    hero.state.dir = [0, 3, 1, 2][Math.round(a / 90) % 4];
    return hero.state.dir;
  },
  // 遮挡物列表本身也要给：诊断脚本要算「角色离最近实心建筑多远」，
  // 光给个长度是算不出来的（之前 walk_test.py 读 H.blockers 拿到 undefined，
  // nearWall 一路报 999，看着像贴墙很远，其实是数据根本没送到）。
  blockers,
  // 建筑类型标签：{key, x, z, depth, top, zone}。
  // city_report.py 靠它统计类型分布 —— 不能靠 blockers 的几何反推，
  // 带院/出挑会让反推全错（见 buildingTypes.js 的 tagBuilding 注释）。
  buildingTags,
  blockerCount: () => blockers.length,
  solidCount: () => blockers.filter((b) => b.solid).length,
  /**
   * 取俯角时间序列（最近 N 帧，按时间顺序）。
   * 传 N 可临时开/关记录 —— 见 frame() 内PITCH_LOG 的说明。
   */
  pitchSeries: (n = 240) => {
    if (!PITCH_LOG || n !== PITCH_LOG) {
      PITCH_LOG = n;
      pitchLog = new Float32Array(n);
      pitchIdx = 0;
    }
    // 环形缓冲展开成时间顺序
    const out = [];
    for (let i = 0; i < PITCH_LOG; i++) {
      out.push(pitchLog[(pitchIdx + i) % PITCH_LOG]);
    }
    return out;
  },
  camera, renderer, scene, composer,
  /**
   * 诊断：列出「当前把视线挡住的盒子」。
   *
   * 【为什么需要】
   * 俯角仍会冲到 50°，说明第 0 阶段（横移+缩距）在某处解不出解，
   * 于是落到抬升兜底。但**是哪几个盒子逼出来的**光看俯角看不出来 ——
   * 可能是单个巨型仓库，也可能是三栋房子叠成一道墙。
   * 这两种情况的解法完全不同：前者要加宽横移，后者要拉长横移方向。
   *
   * 返回每个挡路盒子的中心/尺寸/距离相机多远，按距离排序。
   */
  sightBlockers: () => {
    const s = hero.state;
    const cx = camera.position.x;
    const cz = camera.position.z;
    const cy = camera.position.y;
    const out = [];
    for (const b of blockers) {
      // 视线是「相机 → 角色」的线段，不是 XZ 平面上的矩形。
      // 参数化：t=0 在相机，t=1 在角色。
      //   x(t) = cx + (s.x - cx)·t
      //   z(t) = cz + (s.z - cz)·t
      //   y(t) = cy + (1.2 - cy)·t
      // 盒子在 Z 区间 [minZ,maxZ] 上对应的 t 区间：
      const ez = cz - s.z;
      if (Math.abs(ez) < 1e-3) continue;
      const t0 = (cz - b.maxZ) / ez;
      const t1 = (cz - b.minZ) / ez;
      const tEnter = Math.max(0, Math.min(1, Math.min(t0, t1)));
      const tExit = Math.max(0, Math.min(1, Math.max(t0, t1)));
      if (tEnter > tExit) continue;
      // X 也要落在盒内（与 camera.js 的 sightGap 同款判据）
      const xIn = cx + (s.x - cx) * tEnter;
      const xOut = cx + (s.x - cx) * tExit;
      if (Math.max(xIn, xOut) < b.minX || Math.min(xIn, xOut) > b.maxX) continue;
      // 视线在 tExit 处最低，那才是瓶颈（camera.js 里踩过这个坑）
      const rayY = cy + (1.2 - cy) * tExit;
      if (rayY > b.top) continue;
      out.push({
        cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2,
        w: b.maxX - b.minX, d: b.maxZ - b.minZ, top: b.top,
        tExit, rayY,
        dist: Math.hypot((b.minX + b.maxX) / 2 - s.x, (b.minZ + b.maxZ) / 2 - s.z)
      });
    }
    out.sort((p, q) => p.dist - q.dist);
    return { camX: cx, camY: cy, camZ: cz, heroX: s.x, heroZ: s.z, list: out.slice(0, 8) };
  }
};