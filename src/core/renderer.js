/**
 * HD-2D 渲染管线核心
 *
 * 管线顺序（顺序本身是设计的一部分，不要随意调整）：
 *   RenderPass
 *     -> PosterizePass       色阶量化   ┐
 *     -> UnrealBloomPass     柔和辉光   ├ 全部必须在像素化「之前」
 *     -> TiltShiftPass       微缩景深   ┘
 *     -> RenderPixelatedPass 像素化
 *     -> OutputPass          tone mapping + 色彩空间
 *     -> GradePass           色彩分级（split-tone / 暗角 / 颗粒）
 *
 * 为什么 GradePass 在最后：
 *   调色必须在 tone mapping 之后。放之前的话，暗部会先进 ACES 的暗部压缩
 *   区被压平，再做 split-tone 时暗部已无偏移空间 ——「加了效果但看不出来」。
 *
 * 为什么所有逐像素运算都在像素化之前：
 *   它们按 gl_FragCoord 逐像素工作。放在 RenderPixelatedPass 之后，
 *   同一个像素块内每个像素的结果都不同，干净的色块会被打成彩色噪点。
 *
 * 为什么 bloom 在像素化之前：
 *   UnrealBloomPass 的高斯核是连续采样，放在像素化之后会把像素块边缘磨圆成
 *   「发光的水彩」，直接毁掉像素感。放在之前，柔和感被保留，随后被重新
 *   量化成硬像素块 —— 这正符合 OT2 的观感（有 bloom，但颗粒是硬的）。
 *
 * 为什么 posterize 也在像素化之前：
 *   它按 `gl_FragCoord` 逐像素工作。放在像素化之后时，同一个像素块内每个
 *   像素的取整结果不同，干净色块被打成彩色噪点 —— 实测整个画面退化为
 *   马赛克。放到像素化之前做量化，随后被像素化收拢，才是要的硬色阶。
 */
import {
  WebGLRenderer,
  PCFShadowMap,
  ACESFilmicToneMapping,
  NoToneMapping,
  SRGBColorSpace,
  Vector2,
  Vector3
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { TiltShiftPass, PosterizePass } from '../shaders/tiltShift.js';
import { GradePass } from '../shaders/grade.js';

/**
 * 像素化颗粒大小。角色精灵的屏幕尺寸也按这个值对齐。
 *
 * ===================================================================
 * 【为什么从 6 降到 4】—— 这一条直接决定角色能不能看清
 * ===================================================================
 * 角色素材是 32×32 的精灵。像素化粒度决定「精灵能被保留多少细节」：
 * 一个精灵最终只有 (32 / PIXEL_SIZE) 个像素块。
 *
 * 历代取值与实测结论：
 *   粒度 6 + 16px 素材→ 2.7 格宽，主角读作「一个橙色小方块」
 *   粒度 4 + 32px 素材 → 8 格宽，但仍只有 77px 高，
 *                        sprite-check.html 实测：五官消失，
 *                        只剩「橙衣/红裙/棕发」三块颜色
 *   粒度 3 + 32px 素材 → 约 11 格宽 / 100px 高，
 *                        五官、发髻、红星发饰、星形吉他全部可辨
 *
 * 为什么粒度 3 不像 HD-2D：HD-2D 的像素感并不来自「大颗粒」，
 * 它来自「精灵与 3D 体块共用同一张像素网格」。只要两者对齐，
 * 粒度 3 依然有明确的 HD-2D 观感；而角色不可辨的代价远大于颗粒变小。
 *
 * 结论：取 3。这是在 sprite-check.html 上逐帧比对后定下的值，
 * 不是凭感觉选的—— 页面第②区就是「按游戏内实际尺寸渲染」的模拟，
 * 改完可以直接看效果，不用再靠猜。
 */
export const PIXEL_SIZE = 3;

export function createRenderer(canvas) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false, // 像素化场景下 MSAA 会与像素网格打架
    powerPreference: 'high-performance'
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // 注：r186 已移除 PCFSoftShadowMap，用 PCFShadowMap（PCF 默认）
  renderer.shadowMap.type = PCFShadowMap;

  // ---------- 色调映射：只做一次，且必须只做一次 ----------
  //
  // 关键：使用 EffectComposer 时，renderer.toneMapping 会与 OutputPass
  // **各做一次**。OutputPass 内部读 renderer.toneMapping 并执行映射；
  // 而 RenderPass 在渲染到 composer 的 render target 时，three 也会按
  // renderer.toneMapping 把结果映射一遍 —— 双重映射把中高光压掉一大截，
  // 画面发灰、对比度尽失，读起来就是「脏、粗糙、没有光影层次」。
  //
  // 实测：双映射时整个广场呈死灰褐，屋檐的暗面与墙面的亮面几乎同明度。
  //
  // 正确做法：renderer 级别设为 NoToneMapping，把映射完全交给 OutputPass
  // 这一处执行。曝光仍然通过 toneMappingExposure 统一控制。
  renderer.toneMapping = NoToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.outputColorSpace = SRGBColorSpace;

  return renderer;
}

export function createComposer(renderer, scene, camera) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);

  composer.addPass(new RenderPass(scene, camera));

  // ---------- 色阶量化 ----------
  // 去塑料感的关键一步：像素化只解决「颗粒形状」，不解决「颜色仍是连续渐变」。
  // 量化到有限级数才能读出手绘感。
  // 必须在像素化之前（它按 gl_FragCoord 逐像素工作，放在之后会把像素块打成噪点）。
  // 28 级是实测平衡点：更低会把 Kenney 的低频手绘贴图压成色块噪声。
  const posterize = new PosterizePass(28, 1.0);
  composer.addPass(posterize);

  // ---------- Bloom ----------
  // 在像素化之前：连续的高斯核若跑在像素化之后，会把像素块边缘磨圆成
  // 「发光的水彩」，直接毁掉像素感。放在之前，柔和感被保留，
  // 随后被重新量化成硬像素块 —— 这正符合 OT2 的观感（有 bloom，但颗粒是硬的）。
  //
  // 【参数从 (0.5, 0.7, 0.75) 提到 (0.72, 0.62, 0.68)】
  // 光影层次有**两个**来源，之前只做了一个：
  //   ① 亮度分布 —— 由舞台光 + 太阳角度提供（已做）
  //   ② 亮部溢出 —— 极亮的像素把光「溢」到周围像素上（bloom）
  // 只做 ① 的画面是「对比度够了但不发光」—— 喷泉白石、屋顶高光、
  // 水面反光都停在「白」而没有「亮起来」。
  //
  // threshold 0.75 → 0.68：让更多中高调像素参与辉光，而不是只有极少数。
  // radius 0.7 → 0.62：半径太大反而把像素块的硬边缘糊掉。
  const bloom = new UnrealBloomPass(new Vector2(w, h), 0.72, 0.62, 0.68);
  composer.addPass(bloom);

  // ---------- 移轴景深 ----------
  // 必须在像素化之前：采样偏移以像素块为单位并做半像素量化，
  // 这样模糊后仍保留硬像素颗粒。放到之后会把像素块半途抹开。
  const tiltShift = new TiltShiftPass(PIXEL_SIZE);
  composer.addPass(tiltShift);

  // ---------- 像素化 ----------
  // three r186 内置「低分辨率 RT + NearestFilter + 法线/深度边缘描边」。
  // 签名是 (pixelSize, scene, camera, options) —— scene/camera 必传。
  //
  // 注意它是管线的中段而非末段：前面所有逐像素运算都必须跑在它之前，
  // 否则同一个像素块内每个像素的运算结果不同，干净的色块会被打成噪点。
  const pixelPass = new RenderPixelatedPass(PIXEL_SIZE, scene, camera, {
    // OT2 有描边感，保留但不过强
    normalEdgeStrength: 0.45,
    depthEdgeStrength: 0.5
  });
  composer.addPass(pixelPass);

  // ---------- 色调映射 ----------
  // 必须在 GradePass 之前：调色要在 tone mapping 的暗部压缩之后做，
  // 否则暗部先被压平，split-tone 就再也没有偏移空间（调研已验证此顺序）。
  // 因此这里关掉 renderer 级别的 toneMapping，改由 OutputPass 承担，
  // 避免映射被做两次。
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // ---------- 色彩分级 ----------
  // 管线最后一步：split-tone 冷影暖光 + 暗角 + 颗粒。
  // 这是「有光影层次」和「只是被均匀照亮」的分界线 —— 单一色调滤镜做不到
  // 暗部冷、亮部暖的分离，而后者正是 OT2 画面辨识度的来源。
  const grade = new GradePass({
    exposure: 1.02,      // renderer 已用 toneMappingExposure=1.18，这里只做微调
    // 对比度提到 1.13：「有光影层次」在数学上就等于「有对比度」。
    // 1.09 时画面虽然有亮有暗，但中间调被压缩得太平 ——
    // 屋顶的暗面与墙面的亮面只差一档，肉眼看不出哪个更亮。
    // 幂曲线（pow）比 (c-0.5)*k+0.5 更柔和，接近 0/1 处不会产生
    // 硬削波造成色阶断层 —— 这点在暗部尤其重要。
    contrast: 1.13,
    saturation: 1.12,
    // split-tone 是「氛围调味」不是「主色调」。
    // 0.055（hd2d-diorama 的原值）在本场景实测过强：地面、屋顶、树全被
    // 染成同一片褐，反而丢掉了 HD-2D 依赖的清晰色块区分。
    // 0.032 只在暗部/亮部边缘染出色偏，中间调保持原色。
    splitStrength: 0.032,
    vignette: 0.34,
    grain: 0.014,
    // lift 抬一点暗部：HD-2D 的阴影是「带色的暗」而不是纯黑。
    // 但不能抬多 —— 0.03 时整个暗部被抬成灰蓝，画面读作「雾蒙蒙」。
    // 0.012~0.02 是平衡点：暗部仍是暗的，但能看出颜色倾向（冷）。
    lift: new Vector3(0.010, 0.014, 0.026),

    // ---------- 舞台光 ----------
    // 「有光影层次」的核心来源。之前只有 split-tone（色相分离），
    // 它让暗部偏蓝、亮部偏暖，但**不改变亮度分布**——
    // 整个画面的明暗关系仍然和均匀打光时一样，等于「加了滤镜但没光影」。
    //
    // 舞台光做的是真正的事：让画面中心比四周亮出一档。
    // 中心略偏下（0.54），因为斜俯视下「被照亮的场地」在画面中下部，
    // 偏上会照到天空，读作镜头起雾而不是场地受光。
    lightCenter: new Vector2(0.5, 0.54),
    lightRadius: 0.62,
    lightStrength: 0.30
  });
  composer.addPass(grade);

  return { composer, bloom, pixelPass, tiltShift, posterize, grade };
}