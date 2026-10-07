/**
 * 入口：引导、渲染循环、resize
 */
import { Vector3 } from 'three';
import { createRenderer, createComposer, PIXEL_SIZE } from './core/renderer.js';
import { createCamera, updateCamera, viewDistanceAlongForward, CAMERA_CONFIG, cameraFit } from './core/camera.js';
import { createInput } from './core/input.js';
import { createScene, WORLD } from './world/scene.js';
import { createCharacter } from './world/character.js';
import { mergeStatics, countDrawables } from './core/optimize.js';
import { bakeVertexAO } from './core/vertexAO.js';

const canvas = document.getElementById('scene');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');

const renderer = createRenderer(canvas);
const camera = createCamera();
const { scene, sun, water, SUN_OFFSET } = createScene();
const { composer, tiltShift } = createComposer(renderer, scene, camera);
const input = createInput(window);

// ---------- 角色 ----------
const hero = createCharacter('hero');
// 出生点 (6,14)：偏离喷泉中轴。
//
// 【为什么不放广场正中】斜俯视相机在角色正后方，角色永远处于
// 喷泉与相机之间 —— 出生在x=0 时主角会被喷泉立柱整个挡住，
// 画面上只剩一团影子（实测：完全看不见角色）。
// 偏到x=6 之后，喷泉在角色左前方，两者轮廓不重叠。
hero.setPosition(6.0, 14.0);
scene.add(hero.sprite);
scene.add(hero.shadow);

// NPC（静态，做场景氛围）—— 每个 key 对应图集里的一列（见 cast.json）
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
  c.setPosition(cfg.x, cfg.z);
  c.setDir(cfg.dir);
  scene.add(c.sprite);
  scene.add(c.shadow);
  return c;
});

// ---------- 静态合并 ----------
// 在角色创建之后调用：角色精灵/影子带 dynamic 标记会被自动跳过。
// 把上千个构件按材质合并成几十个 mesh，draw call 数量级下降。
// 调试开关必须在 mergeStatics 之前定义
const DEBUG_RAW = new URLSearchParams(location.search).get('debug') === 'raw';
const DEBUG_NOAO = new URLSearchParams(location.search).get('debug') === 'noao';

const mergeStats = mergeStatics(scene);

// 顶点 AO 烘焙 —— 必须在合并之后做：
// 合并器把世界变换烘进了顶点，AO 才能按最终世界坐标计算。
// 放在合并之前只能拿到物体局部坐标，墙根高度会算错。
const aoResult = (DEBUG_RAW || DEBUG_NOAO) ? { baked: 0, skipped: 0 } : bakeVertexAO(scene.children, {
  // 水面与天空穹顶不能烘 AO：它们的法线与高度都不参与遮蔽逻辑，
  // 强加会让水面出现整片灰暗。
  skip: (m) => !m.isMesh || m.name === 'water' || m.name === 'skydome'
});
console.info(`[HD2D] vertex AO: ${aoResult.baked} vertical meshes baked, ${aoResult.skipped} horizontal skipped`);

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

// 调试模式：?debug=raw 跳过全部后处理，?debug=nopix 跳过像素化
const DEBUG = new URLSearchParams(location.search).get('debug');
if (DEBUG === 'raw') {
  console.warn('[debug] raw render: 跳过全部后处理');
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
  mergeStats,
  drawables: () => countDrawables(scene),
  getState: () => ({
    x: hero.state.x, z: hero.state.z, dir: hero.state.dir
  }),
  setPlayerPos: (x, z) => hero.setPosition(x, z),
  camera, renderer, scene, composer
};