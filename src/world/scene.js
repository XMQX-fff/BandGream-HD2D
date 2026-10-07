/**
 * 海港小镇·托托哈风格 —— 场景总装
 *
 * 布局分区（世界坐标）：
 *   相机始终位于角色 +Z 方向、朝 -Z 俯视，因此「-Z」是玩家的前进方向（北）。
 *
 *   Z < -40海面（远处，视线尽头）
 *   Z ≈ -38  码头前沿（石板路 + 系船柱 + 栈桥伸入海中）
 *   Z -34..18 港口广场（可活动区，两侧为建筑群）
 *   Z > 18    城镇纵深（远景建筑剪影）
 */
import {
  DodecahedronGeometry,
  BoxGeometry,
  Scene,
  Group,
  Fog,
  Color,
  HemisphereLight,
  DirectionalLight,
  AmbientLight,
  Mesh,
  PlaneGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  AdditiveBlending,
  BackSide,
  SphereGeometry,
  CanvasTexture,
  LinearFilter,
  RepeatWrapping
} from 'three';
import * as HD2D_GEN from './hd2dTextures.js';
import { initHD2D } from './textures.js';
import { createWater } from './water.js';
import { createOutskirts } from './city.js';

const HD2D = initHD2D(HD2D_GEN);

import {
  createHouse, createBarrel, createBarrelStack, createCrate, createLampPost,
  createMooringBollard, createPier, createBoat, createBanner, createLantern,
  createPlanter, createBench, createTree, createFountain, createBlobShadow,
  createWaveBreak, createLighthouse
} from './props.js';

const FOG_COLOR = 0xbfdff0;

/**
 * 太阳相对玩家的偏移量 —— **全项目唯一数据源**。
 *
 * HD-2D 的立体感几乎全靠「明确的亮面 / 明确的暗面」。太阳必须在场景的
 * 侧后方（这里取 -X +Z），正面直视镜头的光会把所有物体拍平成没有暗面的
 * 贴纸 —— 实测过：太阳挪到 (34,46,26) 时，广场上每栋房子亮度完全一致，
 * 立体感全部消失。
 *
 * 【高度 22 而不是 34 —— 这是一次关键的修正】
 * 俯仰角决定了阴影的长度：太阳高度角 tan = 22 / hypot(30,40) ≈ 0.5，
 * 即约 26°，影子长度约为物体高度的 2 倍。
 *
 * y=34 时高度角约 39°，影子只有 1.2 倍物高 ——
 * 在 30° 俯视的相机下，这个长度的影子几乎全部藏在物体自身底下，
 * 视觉上就是「没有影子」。实测 y=34 时画面里所有物体的接地感都很弱，
 * 整个场景读作「一堆漂浮的模型」。
 *
 * 26° 的高度角是平衡点：影子够长（能看清方向与形状），
 * 又不会长到横穿整个广场、互相交叠成脏块。
 *
 * 之所以要导出：main.js 的阴影相机跟随逻辑每帧要用同一个偏移量设置
 * sun.position。曾经那里硬编码了一组旧值，把这里调好的侧逆光每帧覆盖回去，
 * 导致「改了光照参数却完全看不到变化」的假象。
 */
export const SUN_OFFSET = { x: -30, y: 22, z: 40 };

export const WORLD = {
  // ==================================================================
  //  【地图尺寸的唯一数据源】—— 扩地图时只改这里，其他地方全部派生
  // ==================================================================
  //
  //  【为什么必须参数化，不能只把地面 PlaneGeometry 乘 10】
  // 第一版扩图只改了地面尺寸，结果世界直接坏掉，原因有四个，
  // 每一个都��独立于地面尺寸存在：
  //
  //   1. 雾   FOG_FAR = 340  —— 玩家走出 340 单位后整个世界被雾吞成一片
  //                            纯色，天空穹顶也会被地面穿透露出边缘
  //   2. 天空 半径 240       —— 地面放大到 1400 后，相机往远处一走，
  //                            天空球被地面顶穿，视野里出现「地平线断口」
  //   3. 相机 far = 400       —— 直接被远裁剪面切掉，远处物体凭空消失
  //   4. 地面贴图 repeat 26  —— repeat 是「每多少个 tile 铺满」，
  //                            几何放大 10 倍而 repeat 不变，单块石板
  //                            从1.35 世界单位变成 13.5，贴图被拉伸成马赛克
  //
  // 所以 SCALE 乘上去之后，下面每一项都必须跟着乘，否则一定有一处坏掉。
  //
  //  【为什么雾和天空的倍数不等于 SCALE】
  // 雾是「视觉引导」：它应该在你**看得见的范围内**起作用，而不是在
  // 地图边界才起作用。地图放大 10 倍后如果雾也放大 10 倍（FOG_FAR=3400），
  // 那么站在地图中央时远处反而完全看不到雾化，远景剪影全部清晰，
  // HD-2D 最标志性的「远景融进背景」就没了，画面会读作「一堆贴纸摆在大空地上」。
  // 所以雾用开方缩放（sqrt(10)≈3.16）：视野内的雾化强度保持不变，
  // 只是雾的**作用距离**跟着地图一起延展。
  //
  // 天空同理 —— 天空球只需比「雾的远端+ 一点余量」大即可，
  // 太大反而让渐变在视野里拉得太平，失去地平线附近的颜色层次。
  SCALE: 10,

  // 可玩区：28 × 26 → 280 × 260，严格 10 倍。这是「地图 10 倍」的唯一度量。
  bounds: { minX: -140, maxX: 140, minZ: -2, maxZ: 240 },

  // 地面几何体：覆盖可玩区 + 外围余量。
  // 【为什么不直接 140×10=1400】
  // 地面不需要和可玩区等大 —— 它只要「在任何位置都看不到边缘」即可。
  // 斜俯视相机的水平视野很窄（约 ±20 单位），玩家永远看不到自己
  // 附近 ±100 以外的东西。地面开到 1400 纯属浪费。
  //
  // 【Z 方向的余量必须算准】
  // 可玩区 Z ∈ [-2, 240]，地面中心在 SHORE + groundD/2 = -4 + groundD/2，
  // 覆盖 Z ∈ [-4, -4+groundD]。要让 Z=240 被覆盖，
  // 需要 groundD >= 244。取 300 →覆盖到 Z=296，比边界多 56 单位余量。
  // （第一版取 380 时算下来是 376，但当时误以为中心是 0，差了半个身位。）
  groundW: 440,                   // X ∈ [-220, 220]，可玩区 ±140 + 80 余量
  groundD: 300,                   // Z ∈ [-4, 296]，可玩区 -2..240 + 56 余量

  seaLevel: 0,
  /** 码头前沿的海界线 */
  shorelineZ: -4,

  /** 雾：范围随地图延展，但倍数是 sqrt(SCALE) 而非 SCALE —— 见上方说明 */
  fogNear: 95 * Math.sqrt(10),    // ≈ 300
  fogFar: 340 * Math.sqrt(10),     // ≈ 1075

  /** 天空穹顶半径：必须大于 fogFar，否则地平线会出现地面顶穿天空的断口 */
  skyRadius: 420 * 2.6,           // ≈ 1092 > fogFar

  /** 海面：420 × 10，海岸线是 10 倍地图里唯一的水平线，必须够宽 */
  seaSize: 4200
};

export function createScene() {
  const scene = new Scene();

  // 雾：HD-2D 的远景雾化很关键，能把远处精灵/建筑融进背景，
  // 同时掩盖 NearestFilter 无mipmap 造成的远处闪烁
  scene.fog = new Fog(FOG_COLOR, WORLD.fogNear, WORLD.fogFar);
  scene.background = new Color(FOG_COLOR);

  // ---------- 光照 ----------
  // HD-2D 的观感关键是「明确的亮面 / 明确的暗面」，而不是全局均匀照明。
  //
  // 【之前失败的原因】
  //   hemi 1.15 + ambient 0.26 是很强的补光，等于把太阳照出的暗面
  //   重新填平 —— 每个物体的亮面与暗面亮度接近，立体感消失。
  //   表现就是「改了光照参数却看不出变化」，画面平得像贴纸。
  //
  // 【现在的配比】
  //   hemi 0.48—— 只留一点点天光，唯一作用是让暗部**带蓝色调**
  //                （HD-2D 的阴影是「带色的暗」，纯黑会显得廉价）
  //                从 0.62 降到 0.48：天光给暗部补多少，
  //                直接决定阴影里能看到多少细节。补多了，
  //                影子里的石板缝和砖块全部被填平，
  //                整个地面读作「一张没有厚度的贴图」。
  //   ambient 0.08 —— 几乎去掉，把暗面交还给太阳
  //   sun 2.75 —— 唯一的主力，亮面/暗面的亮度差就是立体感的来源
  const hemi = new HemisphereLight(0xc4e2ff, 0x7a6448, 0.48);
  scene.add(hemi);

  const ambient = new AmbientLight(0xfff4e4, 0.08);
  scene.add(ambient);

  // 侧逆光：从场景左后方打过来，物体右侧留暗面，屋檐投下长影。
  const sun = new DirectionalLight(0xffeec4, 2.75);
  sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z);
  sun.castShadow = true;
  // 【2048 → 1024：实测阴影 pass 占单帧 313ms，是最大的一块可省开销】
  // 阴影相机范围只有 ±26，2048 铺上去是 39 texel/单位；
  // 但 HD-2D 的最终输出是 pixelSize=3 的低分辨率画面，
  // 屏幕上 1 个像素对应约 1/3 世界单位 —— 39 texel 的精度
  // 在成片里根本用不到，肉眼只会看到更硬的边。
  // 1024 降到 19 texel/单位，配合 radius=1.8 的柔化，
  // 画面上看不出差别，阴影 pass 开销降到 1/4。
  sun.shadow.mapSize.set(1024, 1024);
  // shadow camera 收紧到玩家周围，texel 密度才够（范围过大会全是锯齿）
  //
  // 范围 ±26 的来历：实测相机的地面可视横向半宽最大 25.5（身前 30 单位处），
  // 阴影相机必须覆盖**可见范围里会有投影的部分**，否则玩家会看到
  // 「物体投影被硬切断在 26 单位处」。
  sun.shadow.camera.left = -28;
  sun.shadow.camera.right = 28;
  sun.shadow.camera.top = 28;
  sun.shadow.camera.bottom = -28;
  sun.shadow.camera.near = 1;
  // far 要够远才能容下太阳位置（hypot(30,22,40) ≈ 54）+ 场景深度。
  // 之前 160 偏大，会让阴影贴图浪费大量精度在空区间上。
  sun.shadow.camera.far = 110;
  sun.shadow.radius = 1.8;   // 别太大，低分辨率下会变脏边
  sun.shadow.normalBias = 0.03;// 斜俯角下比 bias 更合适，可避免 acne
  sun.shadow.bias = -0.0003;
  scene.add(sun);
  scene.add(sun.target);

  // ---------- 天空穹顶（渐变，低多边形） ----------
  scene.add(createSkyDome());

  // ---------- 地面 ----------
  const ground = createGround();
  scene.add(ground);

  // ---------- 沙滩缓坡 ----------
  // 没有它，海陆交界是一道生硬的直角切口，像拿刀切出来的。
  // 缓坡还能给画面中部引入一条亮色带，打破整片米黄的单调。
  scene.add(createBeachSlope());

  // ---------- 海面（紧贴海界线，向 -Z 延伸） ----------
  // size 和位置必须用**同一个** WORLD.seaSize 计算。
  // 之前这里是两个独立字面量（size: 420 和 420/2），改一个忘一个
  // 就会让海面中心偏移半个身位 —— 那种错误在画面上极难看出原因。
  const water = createWater({ size: WORLD.seaSize, color: 0x33a3c8, deep: 0x15597f });
  water.position.set(0, -0.35, WORLD.shorelineZ - WORLD.seaSize / 2);
  scene.add(water);

  // ---------- 港口建筑群 ----------
  scene.add(createTown());

  // ---------- 广场陈设 ----------
  scene.add(createPlaza());

  // ---------- 栈桥与船 ----------
  scene.add(createHarbor());

  // ---------- 外围城区（280×260 的内容来源）----------
  // 核心区（|X| <= 50 且 Z < 40）保持原样，其余区域由程序化街区填充。
  scene.add(createOutskirts(WORLD, 50));

  return { scene, sun, water, ground, SUN_OFFSET };
}

/** 渐变天空穹顶 */
function createSkyDome() {
  const geo = new SphereGeometry(WORLD.skyRadius, 16, 12);
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.0, '#5aa8d8');
  g.addColorStop(0.35, '#8fcdea');
  g.addColorStop(0.62, '#c4e6f2');
  g.addColorStop(1.0, '#f2e2c8');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new CanvasTexture(c);
  // 天空是纯渐变，线性采样更平滑（横向只有 4 texel，靠双线性铺开）
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = 'srgb';
  tex.wrapS = RepeatWrapping;

  const mat = new MeshBasicMaterial({ map: tex, side: BackSide, fog: false, depthWrite: false });
  const dome = new Mesh(geo, mat);
  dome.renderOrder = -1;
  return dome;
}

/**
 * 石板码头地面
 *
 * ===================================================================
 * 【为什么弃用 Kenney `floor_stone_sand_random`】—— 这一版最关键的改动
 * ===================================================================
 * 那张贴图整张是**随机噪点**（浅褐色沙粒）。地面是场景里面积最大的表面，
 * 于是 140×120 的地面上铺满了大小相近、互不相干的杂色块。PIXEL_SIZE=6
 * 的像素化把每个 texel 放大成 6×6 屏幕像素，噪点被等比放大 —— 画面读作
 * 「脏、粗糙、没细节」。
 *
 * 问题不在分辨率，在于**贴图缺少大尺度结构**。HD-2D 的地面是
 * 「一块块可辨认的石板」：缝隙是明确的直线，块内只有 2~3 级明度，
 * 视线能读出"这是一条铺装的路"。噪点里没有石板，只有沙子。
 *
 * 现在换成程序化生成的 stonePaving / largeFlagstone（见 hd2dTextures.js）。
 *
 * ===================================================================
 * 【铺装分区】—— OT2 的核心手法
 * ===================================================================
 *   base  —— 码头底层地面，大范围、中明度
 *   plaza —— 广场面板，更暗一档、更大格的石块
 *   curb  —— 路缘石，凸起的实体边界
 *
 * 用**铺装分区**而非调色来划分功能区：喷泉的暖白石之所以能从广场里
 * 「跳」出来，靠的是脚下这块明显更暗的面板，而不是把喷泉调亮
 * （在强日照下调亮只会和地面同亮，颜色对比根本立不住）。
 */
function createGround() {
  // repeat 26：tile边长 = 140/26 ≈ 5.4 世界单位，除以 4x4 格
  // → 单块石板约 1.35 单位 ≈ 1.25 米。
  //
  // 【从 18 提到 26 的原因】
  // 18时单块约 1.95 单位，相机拉近后每块石板在屏幕上占约 90px，
  // 读作「一格一格的停车场」。26 时约 70px，才读作「石板路」。
  // 参考尺度：角色 1.95 高= 1.8 米，那么 1.35 单位的石板正好是
  // 一块能单脚踩上去的尺寸，比例可信。
  //
  // 饱和度提到 0.21：之前 0.15 太淡，加上 2.75 强度的太阳和
  // 0.62 的天光之后，石板的暖色被完全冲淡成灰米色 —— 读作
  //「水泥地」。HD-2D 的地面必须**明确偏暖**，才能和屋顶的赭红、
  // 树叶的绿形成色相分离。
  // ==================================================================
  //  【repeat 必须随 SCALE 同步 —— 这是扩地图最容易漏的一处】
  // ==================================================================
  // repeat 的语义是「贴图在整个几何体上铺多少个 tile」，它和几何体的
  // 世界尺寸是**两个独立量**。地面从 140 宽涨到 1400（10 倍）而 repeat
  // 保持 26 时，单块石板的世界尺寸会从 1.35 单位涨到 13.5 单位 ——
  // 也就是说每一块「石板」变成了一间房那么大，贴图被拉伸到无法辨认。
  //
  // 正确做法：repeat = 基准 repeat × SCALE，tile 世界尺寸恒定不变。
  // 这样无论地图多大，石板永远是 1.35 单位，视觉密度一致。
  //
  // 【为什么石板尺寸必须锁死】
  // 石板大小是判断「这有多大」的核心视觉线索，它同时决定了
  // 「角色 vs 石板」的比例。角色 2.95 高，一只脚约 0.6 单位，
  // 石板 1.35 单位≈ 单脚能踩上去的尺寸 —— 比例才可信。
  // 一旦石板跟着地图一起变大，哪怕地面的总 repeat 数对上了，
  // 玩家也会立刻觉得「尺度崩了」，因为参照物（人）的相对大小变了。
  const mat = new MeshStandardMaterial({
    map: HD2D.tex('stonePaving', { seed: 7, hue: 37, sat: 0.22, baseL: 0.70 }, 26 * WORLD.SCALE),
    roughness: 0.94,
    metalness: 0.0
  });
  mat.color.setHex(0xffffff);

  // 地面只覆盖码头与城镇，海面区域不铺地面。
  const SHORE = WORLD.shorelineZ;
  const ground = new PlaneGeometry(WORLD.groundW, WORLD.groundD);
  const base = new Mesh(ground, mat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(0, 0, SHORE + WORLD.groundD / 2);
  base.receiveShadow = true;
  base.name = 'ground';

  // ---------- 广场面板 ----------
  // 明度比底层低约 10%，格子更大（2×2 tile）——
  // 大格子 + 暗一档 = 明确的功能区划分，给中央喷泉一个可对比的底。
  //
  // 【截图复核后的两项修正】
  //   baseL 0.58 → 0.66：原来 0.58 太暗。在 2.75 强度的阳光下，
  //   暗一档的结果不是「沉稳」而是「水泥灰」—— 石板里那点暖色
  //   (hue 30) 全被亮度不足吃掉了，读作��未干的水泥板」。
  //   OT2 的广场石板在日光下是**明确的暖米色**，不是灰色。
  //
  //   hue 30 → 36：暖色再往黄推一点。广场地面占画面面积最大，
  //   它的色相基本决定了整个画面的「温度」。偏黄才能和右侧
  //   赭红屋顶、左上方青蓝海面形成三角色相分离。
  const plazaMat = new MeshStandardMaterial({
    map: HD2D.tex('largeFlagstone', { seed: 21, hue: 36, sat: 0.20, baseL: 0.66 }, 9 * WORLD.SCALE),
    roughness: 0.95,
    metalness: 0.0
  });
  plazaMat.color.setHex(0xffffff);

  const PLAZA_CZ = 11;
  const PLAZA_W = 30;
  const PLAZA_D = 34;
  const plaza = new Mesh(new PlaneGeometry(PLAZA_W, PLAZA_D), plazaMat);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(0, 0.02, PLAZA_CZ);
  plaza.receiveShadow = true;
  plaza.name = 'plaza_deck';

  const g = new Group();
  g.name = 'ground_group';
  g.add(base, plaza);

  // ---------- 路缘石 ----------
  // 面板边界如果只靠色差，读作「一张贴纸浮在地上」。
  // 用一圈真实凸起的石缘把边界变成实体，它自身投下的浅影
  // 会给整个广场一个明确的范围感 —— 这是建筑做法，也是 OT2 的做法。
  const curbMat = new MeshStandardMaterial({
    map: HD2D.tex('stoneBlocks', { seed: 91, hue: 33, sat: 0.10, baseL: 0.72 }, 2),
    roughness: 0.92,
    metalness: 0.0
  });
  curbMat.color.setHex(0xfff0d8);

  const CH = 0.26;
  const CT = 0.55;
  const hw = PLAZA_W / 2 + CT / 2;
  const hd = PLAZA_D / 2 + CT / 2;

  const curbLong = new BoxGeometry(CT, CH, PLAZA_D + CT * 2);
  const curbShort = new BoxGeometry(PLAZA_W - CT * 2, CH, CT);
  for (const [x, z] of [[-hw, PLAZA_CZ], [hw, PLAZA_CZ]]) {
    const m = new Mesh(curbLong, curbMat);
    m.position.set(x, CH / 2 + 0.02, PLAZA_CZ);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  for (const z of [PLAZA_CZ - hd, PLAZA_CZ + hd]) {
    const m = new Mesh(curbShort, curbMat);
    m.position.set(0, CH / 2 + 0.02, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }

  // 主通道缺口：海侧（-Z）正中留 6 单位宽开口
  for (const s of [-1, 1]) {
    const m = new Mesh(new BoxGeometry((PLAZA_W - 6) / 2, CH, CT), curbMat);
    m.position.set(s * (6 / 2 + (PLAZA_W - 6) / 4), CH / 2 + 0.02, PLAZA_CZ - hd);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }

  // 【光影层次为什么不在这里做】
  // 曾在这里放过两张地面贴片：一张加色的「光池」、一张减色的「半影」。
  // 两个都失败了，原因是几何边界：
  //   - 面片边界被像素化后读作「一条斜穿画面的虚线」，比不做更糟
  //   - 俯视地面有透视，圆形渐变在屏幕上不是圆而是斜椭圆，边界更明显
  //   - 半影跟着玩家走时，边界在画面里不断移动，读作「有什么东西在闪」
  //
  // 现在改由 GradePass 的**屏幕空间舞台光**承担：渐变边界永远在画面外，
  // 只留下「中心亮、四周暗」这一个纯粹的亮度分布。
  // 详见 shaders/grade.js 第6 步的说明。
  return g;
}

/** 建筑群 —— 沿广场两侧排列，正面朝向中央通道 */
function createTown() {
  const town = new Group();

  // 【建筑外移的原因】
  // 之前近侧房子在 |X| = 16~17.5，而广场铺装只到 |X| = 15。
  // 也就是说房子紧贴着活动区边缘 —— 相机一旦跟到玩家 X=14 左右，
  // 整个右半屏就是一面墙，读作「撞墙了」而不是「走进广场」。
  //
  // OT2 的城镇建筑与可活动区之间始终留有一段**过渡空间**
  // （花坛、树、长椅），既不挡视线，也让建筑有「后面还有街」的感觉。
  // 现在把建筑推到 |X| >= 20，广场与建筑之间留出约 5 单位的缓冲带，
  // 那里放树与花坛。
  const houses = [
    [-20.5, 2.5, 7, 6, 5.0, 2.4, 0xfaf4e8, 0xfff4ec],
    [21.0, 2.5, 6.5, 6, 4.6, 2.2, 0xf2e8d4, 0xf6e2d2],
    [-23.0, 10,  6.5, 6, 4.8, 2.3, 0xfdf8ec, 0xfffaf4],
    [23.5, 10,  7, 6, 5.2, 2.5, 0xf6ecda, 0xf8e6da],
    [-20.0, 17.5, 6.5, 6, 4.6, 2.2, 0xf8f0e0, 0xffeede],
    [20.5, 17.5, 6, 6, 4.5, 2.1, 0xfcf4e4, 0xf6e6d8],
    [-22.5, 25,  7.5, 6.5, 5.4, 2.6, 0xfdf6e8, 0xfff8f0],
    [22.5, 25,  7, 6, 5.0, 2.4, 0xf4ecdc, 0xf2ddd0]
  ];

  houses.forEach(([x, z, w, d, h, roofH, wallTint, roofTint], i) => {
    const house = createHouse({ w, d, h, roofH, wallTint, roofTint, seed: i });
    house.position.set(x, 0, z);
    // 正面（+Z，带门窗的一面）朝向相机一侧的通道，略微内倾
    house.rotation.y = (i % 3 - 1) * 0.07;
    town.add(house);
  });

  // 远景剪影建筑（制造纵深）
  //
  // tint 必须**偏向雾色**而不是往深里压。这些房子处在 FOG_NEAR~FOG_FAR
  // 区间，雾会把它们往天蓝方向混，若本体再偏深褐，混出来的就是
  // 一层脏灰 —— 「远景发脏」正是这么来的。正确的做法是让远景
  // 本体就是**高明度、低饱和的暖白**，靠雾去拉开层次。
  const far = [
    [-34, 32, 10, 8, 7.0, 0xe6d8c2, 0xf0e4d4],
    [36, 34, 11, 8, 7.5, 0xe8dcc6, 0xecdfd0],
    [-42, 16, 12, 9, 8.0, 0xe4d6be, 0xe8dcd0],
    [44, 18, 12, 9, 8.5, 0xe6d8c2, 0xeedacd],
    [-38, 2,  12, 10, 8.0, 0xe2d4ba, 0xe6dacd],
    [40, 3,  13, 10, 8.5, 0xe4d6be, 0xeadeD0]
  ];
  for (const [x, z, w, d, h, wallTint, roofTint] of far) {
    const house = createHouse({
      w, d, h, roofH: h * 0.42, wallTint, roofTint, seed: 0
    });
    house.position.set(x, 0, z);
    house.rotation.y = (x < 0 ? 1 : -1) * 0.12;
    town.add(house);
  }

  return town;
}

/** 栈桥、船与港口道具 —— 集中在码头前沿（Z ≈ -36） */
function createHarbor() {
  const harbor = new Group();
  const SHORE = WORLD.shorelineZ;

  // 主栈桥：从码头伸入海中（朝 -Z）
  const pier = createPier(17, 5);
  pier.position.set(-7, 0, SHORE - 8.5);
  harbor.add(pier);

  // 侧栈桥
  const pier2 = createPier(12, 4);
  pier2.position.set(15, 0, SHORE - 6);
  harbor.add(pier2);

  // 船（停在栈桥旁，海面上）
  const boat1 = createBoat({ len: 6.5, tint: 0x8a5a3a });
  boat1.position.set(-12.4, 0, SHORE - 8);
  boat1.rotation.y = 0.18;
  harbor.add(boat1);

  const boat2 = createBoat({ len: 5, tint: 0x6f7f92 });
  boat2.position.set(18.4, 0, SHORE - 6);
  boat2.rotation.y = -1.42;
  harbor.add(boat2);

  const boat3 = createBoat({ len: 4.4, tint: 0x9a6a42 });
  boat3.position.set(-2, 0, SHORE - 17);
  boat3.rotation.y = 0.42;
  harbor.add(boat3);

  // 系船柱：沿码头前沿一排
  for (let i = -5; i <= 5; i++) {
    const b = createMooringBollard();
    b.position.set(i * 5.4, 0.5, SHORE + 1.6);
    harbor.add(b);
  }

  // 码头边的栏杆（点缀，避免前沿空旷）
  // 路灯：沿码头与通道两侧
  for (const x of [-24, -12.5, 12.5, 24]) {
    const lamp = createLampPost();
    lamp.position.set(x, 0.5, SHORE + 3.4);
    harbor.add(lamp);
  }
  // 广场区的灯柱。
  //
  // 【从±11.5 外移到 ±15.5 的原因】
  // 斜俯视相机下，「挡在角色前面」的东西就是画面正中的遮挡物。
  // 灯柱在 x=±11.5 时，角色在(6,14) 往西走几步，
  // 灯柱的杆身+ 灯罩恰好落在角色轮廓上 —— 实测截图里主角被灯柱横穿，
  // 角色读作「站在路灯后面」。
  //
  // 灯柱是竖直的细杆，比喷泉更难避开：喷泉可以挪 z，
  // 灯柱只有 x 一个自由度，所以必须给活动区留出足够的外边距。
  for (const [x, z] of [[-15.5, -14], [15.5, -14], [-15.5, 4], [15.5, 4]]) {
    const lamp = createLampPost();
    lamp.position.set(x, 0.5, z);
    harbor.add(lamp);
  }

  // 旗帜：码头两端
  const b1 = createBanner();
  b1.position.set(-27, 0.5, SHORE + 2.4);
  harbor.add(b1);
  const b2 = createBanner();
  b2.position.set(27, 0.5, SHORE + 2.4);
  harbor.add(b2);

  // 木桶堆
  const stackA = createBarrelStack();
  stackA.position.set(-20, 0.5, SHORE + 5);
  harbor.add(stackA);
  const stackB = createBarrelStack();
  stackB.position.set(19.5, 0.5, SHORE + 5.4);
  harbor.add(stackB);

  // 散落木桶
  for (const [x, z] of [[-15.5, SHORE + 4.6], [-14.8, SHORE + 3.1], [9.5, SHORE + 4.8], [11.2, SHORE + 3.3]]) {
    const b = createBarrel();
    b.position.set(x, 0.5, z);
    b.rotation.y = x * 0.7;
    harbor.add(b);
  }

  // 木箱
  const crates = [
    [-22.5, SHORE + 4.2, 0.3], [-21.0, SHORE + 5.0, -0.5],
    [21.5, SHORE + 4.0, 0.8], [23.0, SHORE + 4.8, 0.1],
    [-7.5, SHORE + 4.6, 0.4], [7.2, SHORE + 3.8, -0.3]
  ];
  for (const [x, z, ry] of crates) {
    const c = createCrate(0.95);
    c.position.set(x, 0.5, z);
    c.rotation.y = ry;
    harbor.add(c);
  }

  // 放在木箱上的油灯（高低层次 + bloom 光源）
  const lanternSpots = [[-22.5, SHORE + 4.2], [23.0, SHORE + 4.8], [-7.5, SHORE + 4.6]];
  for (const [x, z] of lanternSpots) {
    const l = createLantern();
    l.position.set(x, 1.28, z);
    harbor.add(l);
  }

  // ==========================================================================
  //  延展码头 —— 把 28 宽的港口前沿扩展到 280 宽
  // ==========================================================================
  // 【为什么必须延展，不能只靠程序化城区】
  // 海岸线是这张地图上唯一的水平线，是「这是个港口」的空间声明。
  // 地图放大 10 倍后，如果海岸线仍然只有28 单位宽，
  // 玩家往东西两侧各走 100 单位后会发现「内陆」——
  // 一个两面都是陆地的地图读作「盆地」，港口城市的地形逻辑就崩了。
  //
  // 所以东侧要延续成「带栈桥的海滨大道」，
  // 西侧延续成「防波堤 + 小渔港」，让海岸线贯穿整张地图。
  const harborExtend = new Group();

  // ---- 东段：海滨栈桥（每 60 单位一座，沿 Z 排布）----
  for (let x = 42; x <= WORLD.bounds.maxX - 20; x += 60) {
    const px = createPier(16, 4.5);
    px.position.set(x, 0, SHORE - 7);
    harborExtend.add(px);
    // 系船柱
    for (let k = -1; k <= 1; k++) {
      const b = createMooringBollard();
      b.position.set(x + k * 3.2, 0.5, SHORE + 1.6);
      harborExtend.add(b);
    }
    // 泊船
    const bt = createBoat({ len: randHull(), tint: pickHull() });
    bt.position.set(x + randHullOff(), 0, SHORE - 7.5);
    bt.rotation.y = randHullRot();
    harborExtend.add(bt);
    // 路灯
    const lp = createLampPost();
    lp.position.set(x - 4, 0.5, SHORE + 3.4);
    harborExtend.add(lp);
  }

  // ---- 西段：防波堤（石垒 + 灯塔）----
  // 防波堤是港口的视觉边界，它的存在让「海」这件事有了尽头，
  // 而不是无限延伸到雾里。
  for (let x = -40; x >= WORLD.bounds.minX + 16; x -= 34) {
    const w = createWaveBreak();
    w.position.set(x, 0, SHORE - 3);
    harborExtend.add(w);
  }
  const lighthouse = createLighthouse();
  lighthouse.position.set(WORLD.bounds.minX + 30, 0, SHORE - 12);
  harborExtend.add(lighthouse);

  harbor.add(harborExtend);
  return harbor;
}

// 延展段的小工具函数：用固定公式而非随机数，保证每次生成完全一致
const randHull = () => 5 + ((WORLD.bounds.maxX * 7 + 13) % 3);
const randHullOff = () => (((WORLD.bounds.maxX * 5) % 3) - 1) * 4;
const randHullRot = () => (((WORLD.bounds.maxX * 3) % 5) - 2) * 0.25;
const pickHull = () => [0x8a5a3a, 0x6f7f92, 0x9a6a42][WORLD.bounds.maxX % 3];

/** 广场陈设 —— 填补空旷石板地面，制造中景层次 */
function createPlaza() {
  const plaza = new Group();

  // 中央喷泉：广场的视觉焦点（台座直径 8.8，立柱总高约 6.3）
  //
  // 【位置从 (0,10) 移到 (0, 12.5)】
  // 斜俯视相机下，画面纵向的排布由 z 决定（z 越小越靠画面上方）。
  // 喷泉在 z=10 时，它的立柱（高 6.3）投影落在角色身上 ——
  // 主角恰好被喷泉的水柱和顶盘挡住，读作「有人在柱子后面」。
  // 往后挪 2.5 单位后，喷泉完全位于角色上方的画面区域，
  // 两者轮廓不再重叠，主角清晰可辨。
  const fountain = createFountain();
  fountain.position.set(0, 0, 12.5);
  plaza.add(fountain);

  // 喷泉外圈长椅（围合感，同时暗示「可停留」）
  // 半径必须> 喷泉台座 4.4，否则长椅会插进池壁里。
  // 全部跟随喷泉新的 z=12.5 平移，保持围合关系。
  //
  // 【删掉 (6.6, 9.1) 与 (-6.6, 9.1) 这两张】
  // 出生点是 (6,14)，相机在角色身后朝 +z 看。
  // 这两张长椅在 z=9.1，正好落在「相机 → 主角」的连线上 ——
  // 斜俯视下长椅靠背在画面上恰好盖住主角的头部，
  // 实测截图里主角读作「从长椅后面探出半个身子」。
  //
  // 判据：相机到角色是沿 -z 方向的视线，凡是 z < 角色.z 且 |x - 角色.x| < 3
  // 的高物件都会遮挡主角。摆放道具时必须先想这条视线。
  const benchSpots = [
    [-7.4, 12.5, Math.PI / 2], [7.4, 12.5, -Math.PI / 2],
    [0, 19.1, Math.PI], [0, 5.9, 0],
    [-8.2, 8.4, Math.PI * 0.72], [8.2, 8.4, -Math.PI * 0.72]
  ];
  for (const [x, z, ry] of benchSpots) {
    const b = createBench();
    b.position.set(x, 0, z);
    b.rotation.y = ry;
    plaza.add(b);
  }

  // 花坛：沿主通道两侧对称布置（X 收在 10 以内，给外缘的树让位）
  const planters = [
    [-9.4, 12.5, 1.5], [9.4, 12.5, 1.5],
    [-9.4, 2.5, 1.3], [9.4, 2.5, 1.3],
    [-11.8, 19.5, 1.7], [11.8, 19.5, 1.7]
  ];
  for (const [x, z, r] of planters) {
    const p = createPlanter(r);
    p.position.set(x, 0, z);
    plaza.add(p);
  }

  // 树：放在建筑与广场之间的过渡带（|X| ≈ 17），不再压在广场外缘。
  //
  // 【为什么改位置】
  // 之前树在 |X| = 13.2~14，紧贴广场边缘。它们真正该干的事是
  // **分隔「活动区」与「建筑区」**，而不是给广场加框景。
  // 挪到 17 之后，画面从左到右读作：
  //   石板广场（活动）→ 树列（过渡）→ 房屋（背景）
  // 三层深度 —— 这是 OT2 城镇景深的标准构成。
  //
  // 硬约束：建筑现在在 |X| >= 20，广场铺装到 |X| = 15，
  // 16~19 这一带正好留给树。树冠半径约 2.3，树心落在 17 时
  // 冠幅正好搭在建筑立面前，不穿模也不挡门脸。
  // 树冠的三档绿色由 props.js 的 leafMaterial() 提供（贴图自带明暗层次）。
  const trees = [
    [-17.0, 5.5, 5.2, 1.9],
    [-16.6, 13.0, 5.8, 2.1],
    [-17.2, 21.5, 5.4, 2.0],
    [17.0, 6.5, 5.0, 1.8],
    [16.6, 14.0, 5.6, 2.0],
    [17.2, 22.0, 5.2, 1.9]
  ];
  for (const [x, z, h, spread] of trees) {
    const t = createTree({ h, spread });
    t.position.set(x, 0, z);
    plaza.add(t);
  }

  // 路灯：沿通道两侧，把视线引向海面。
  //
  // 【从 ±6.2 外移到 ±9.5】
  // 之前这组在 x=±6.2，而出生点是 (6,14) —— 两者 x 几乎重合、
  // z 只差 3.5。斜俯视下灯柱就立在主角**正后方**，
  // 杆身加灯罩横穿角色轮廓，实测截图里主角被灯柱拦腰截断。
  //
  // 判据不是「灯柱在不在场景里」，而是「它在不在**相机的视锥里、
  // 且和角色在同一条视线上**」。竖直细杆只有 x 一个自由度可用，
  // 所以活动区（|x| < 9）内不放灯柱。
  for (const [x, z] of [[-9.5, 17.5], [9.5, 17.5], [-9.5, 1.0], [9.5, 1.0]]) {
    const l = createLampPost();
    l.position.set(x, 0, z);
    plaza.add(l);
  }

  // ---------- 台阶 ----------
  //
  // 【为什么空旷的广场地面是最大的构图问题】
  // 相机拉近到 distance=27 之后，画面下半部分（约 40%）全是石板地面，
  // 没有任何东西 —— 视线没有落脚点，画面重心偏上，读作「一片空地」
  // 而不是「一个广场」。
  //
  // OT2 处理这个问题的方式是**让地面本身有起伏**：
  // 广场不是一整块平地，而是由若干级台阶分成高低不同的台地。
  // 台阶有三个作用，缺一不可：
  //   1. 每一级侧面都会吃一道侧光 → 俯视下形成横向明暗带
  //   2. 台阶边缘是明确的几何线，把大片地面切成几块 → 不再空旷
  //   3. 玩家走上去时相机高度有轻微变化（这里靠台阶本身制造视觉差，
  //      不改碰撞，因为是纯装饰）
  //
  // 台地按「海侧低、陆侧高」排列，形成向海面递降的层次 ——
  // 这与场景本身「站在岸边看向大海」的方向一致。
  const stepMat = new MeshStandardMaterial({
    map: HD2D.tex('stoneBlocks', { seed: 1200, hue: 33, sat: 0.13, baseL: 0.74 }, 6),
    roughness: 0.93,
    metalness: 0.0
  });
  stepMat.color.setHex(0xfff4e2);

  // 三道横向台阶，从南到北逐级抬高，每级 0.22 高
  //
  // 位置必须在活动范围（maxZ = 24）之内，且不与喷泉长椅
  // （最北那把在 z=19.1）冲突。取 z = 20.0 / 21.8 / 23.6。
  for (let i = 0; i < 3; i++) {
    const w = 24 - i * 4;              // 越高越窄，做出收分
    const d = 1.4;
    const h = 0.22;
    const z = 20.0 + i * 1.8;
    const step = new Mesh(new BoxGeometry(w, h, d), stepMat);
    step.position.set(0, h / 2 + i * 0.22, z);
    step.castShadow = true;
    step.receiveShadow = true;
    plaza.add(step);

    // 台阶两端加方形柱墩：给横向线条一个垂直的收头，
    // 否则台阶读作「一条贴在地上的色带」而不是实体。
    for (const s of [-1, 1]) {
      const pier = new Mesh(new BoxGeometry(0.7, h + 0.42, 0.7), stepMat);
      pier.position.set(s * (w / 2 - 0.35), (h + 0.42) / 2 + i * 0.22, z);
      pier.castShadow = true;
      pier.receiveShadow = true;
      plaza.add(pier);
    }
  }

  // ---------- 广场角落的绿化 ----------
  //
  // 空旷的角落需要「低矮但茂密」的东西 —— 灌木比树合适：
  // 树太高会挡住建筑立面，灌木正好填补「地面到树冠之间」的空白层。
  // OT2 的广场角落几乎总有这种中层绿化。
  const shrubSpots = [
    [-12.5, 4.5], [12.5, 4.0], [-12.8, 16.5], [12.8, 17.0],
    [-6.5, 24.0], [6.5, 24.5], [-13.0, 21.0], [13.0, 20.5],
    [-3.0, 24.8], [3.0, 25.2]
  ];
  for (const [x, z] of shrubSpots) {
    const p = createPlanter(1.15);
    p.position.set(x, 0, z);
    plaza.add(p);
  }

  // ---------- 散落细节 ----------
  // 木箱与木桶散布在广场边缘，制造不规则感。
  // 完全对称的布局读作「摆出来的」，不对称才像「用过的广场」。
  const clutter = [
    [-11.2, 8.5, 0.5], [11.5, 8.0, -0.4], [-12.0, 19.0, 1.2],
    [11.8, 18.6, -1.0], [-4.5, 23.2, 0.3], [4.8, 22.8, -0.6]
  ];
  for (const [x, z, ry] of clutter) {
    const c = createCrate(0.85);
    c.position.set(x, 0, z);
    c.rotation.y = ry;
    plaza.add(c);
  }
  const barrelSpots = [[-10.4, 7.2, 0.3], [10.8, 6.8, 1.1], [12.2, 19.4, -0.2]];
  for (const [x, z, ry] of barrelSpots) {
    const b = createBarrel();
    b.position.set(x, 0, z);
    b.rotation.y = ry;
    plaza.add(b);
  }

  return plaza;
}

/** 沙滩缓坡 —— 衔接海面与陆地，消除生硬切口 */
function createBeachSlope() {
  const g = new Group();
  const SHORE = WORLD.shorelineZ;

  // 坡体：用 PlaneGeometry 顶点高度做出斜面
  const depth = 16;
  const geo = new PlaneGeometry(150, depth, 24, 8);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    // v 从 -0.5(靠海) 到 0.5(靠陆)；越靠海越低
    const t = (pos.getY(i) + depth / 2) / depth;   // 0 = 海侧, 1 = 陆侧
    const y = -1.4 + t * 1.45;
    pos.setZ(i, y);
  }
  geo.computeVertexNormals();

  const sandMat = new MeshStandardMaterial({
    // 程序化沙地：低频斑块，绝不做逐像素噪点。
    // 之前用 sand_random + repeat 13，整片岸线在像素化下读作「脏沙」。
    map: HD2D.tex('sandFlat', { seed: 33, hue: 40, sat: 0.30, baseL: 0.78 }, 5),
    roughness: 1.0,
    metalness: 0.0
  });
  sandMat.color.setHex(0xffffff);

  const slope = new Mesh(geo, sandMat);
  slope.rotation.x = -Math.PI / 2;
  slope.position.set(0, 0, SHORE - depth / 2);
  slope.receiveShadow = true;
  g.add(slope);

  // 礁石：打破坡面的单调，并给近岸一点体积感
  const rockMat = new MeshStandardMaterial({
    map: HD2D.tex('stoneBlocks', { seed: 95, hue: 30, sat: 0.09, baseL: 0.58 }, 1),
    roughness: 1.0,
    metalness: 0.0
  });
  rockMat.color.setHex(0xffffff);
  const rocks = [
    [-16, -5.5, 1.5, 0.8], [-13.5, -7.5, 0.9, 1.1], [15, -6.5, 1.7, 0.7],
    [18.5, -9.0, 1.2, 1.3], [-6, -9.5, 1.0, 0.6], [7, -8.0, 1.3, 0.9]
  ];
  for (const [rx, rz, r, ry] of rocks) {
    const rock = new Mesh(new DodecahedronGeometry(r, 0), rockMat);
    rock.position.set(rx, -0.35, SHORE + rz + 4);
    rock.rotation.set(ry * 0.4, ry, ry * 0.2);
    rock.scale.set(1, 0.62, 1);   // 压扁，更像滩涂礁石
    rock.castShadow = true;
    rock.receiveShadow = true;
    g.add(rock);
  }

  return g;
}
