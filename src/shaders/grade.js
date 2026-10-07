/**
 * GradePass —— HD-2D 色彩分级
 *
 * 配方来自 hd2d-diorama（src/post/shaders.js COMPOSITE_FRAG）的实测参数，
 * 那一版是逐条对着《歧路旅人2》截图调出来的。核心不是饱和度，而是
 * **split-tone（冷影暖光）**：把暗部往青蓝推、亮部往橙黄拉。
 * 这正是 OT2 给人的「黄昏海港」印象的核心 —— 单一色调滤镜做不到这个分离。
 *
 * 关键顺序约束（来自调研结论，也是踩过的坑）：
 *   调色必须放在 tone mapping **之后**。
 *   放之前的话，暗部会先进 ACES 的暗部压缩区被压平，再做 split-tone
 *   时暗部已经没有空间可偏移，结果是「加了效果但看不出来」。
 *
 * 与 PosterizePass 的分工：
 *   Posterize 管「色阶数量」（去塑料感），Grade 管「色相分布」（加氛围）。
 *   两者都必须在像素化之前 —— 逐像素的运算放在像素化后会打碎像素块。
 */
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderMaterial, Vector2, Vector3 } from 'three';

export class GradePass extends Pass {
  constructor({
    exposure = 1.0,
    contrast = 1.07,
    saturation = 1.12,
    splitStrength = 0.05,
    shadowTint = new Vector3(-0.35, -0.10, 0.55),
    highlightTint = new Vector3(0.50, 0.18, -0.35),
    vignette = 0.45,
    /** 舞台光：屏幕空间的亮区中心（0~1 UV）+ 半径 + 强度 */
    lightCenter = new Vector2(0.5, 0.55),
    lightRadius = 0.62,
    lightStrength = 0.22,
    grain = 0.02,
    lift = new Vector3(0.0, 0.0, 0.0),
    gain = new Vector3(1.0, 1.0, 1.0)
  } = {}) {
    super();

    this.uniforms = {
      tDiffuse:      { value: null },
      uExposure:     { value: exposure },
      uContrast:     { value: contrast },
      uSaturation:   { value: saturation },
      uSplit:        { value: splitStrength },
      // split-tone 用 vec3 存两个色调（shadows / highlights）
      uShadowTint:   { value: shadowTint },
      uHighlightTint:{ value: highlightTint },
      uVignette:     { value: vignette },
      uLightCenter:  { value: lightCenter },
      uLightRadius:  { value: lightRadius },
      uLightStrength:{ value: lightStrength },
      uGrain:        { value: grain },
      uLift:         { value: lift },
      uGain:         { value: gain },
      uResolution:   { value: new Vector2(1, 1) }
    };

    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uExposure;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uSplit;
        uniform vec3  uShadowTint;
        uniform vec3  uHighlightTint;
        uniform float uVignette;
        uniform vec2  uLightCenter;
        uniform float uLightRadius;
        uniform float uLightStrength;
        uniform float uGrain;
        uniform vec3  uLift;
        uniform vec3  uGain;
        uniform vec2  uResolution;
        varying vec2 vUv;

        const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

        void main() {
          vec4 texel = texture2D( tDiffuse, vUv );
          vec3 c = texel.rgb;

          // ---------- 1. 曝光 ----------
          c *= uExposure;

          // ---------- 2. Lift / Gain ----------
          // 比单纯调对比度更可控：lift 抬暗部（决定阴影"死黑"还是"通透"），
          // gain 调整体亮度。两者分离后暗部细节不会被对比度吃掉。
          c = c * uGain + uLift;

          // ---------- 3. 对比度 ----------
          // 以 0.5 为轴的 S 形曲线。幂函数实现，比 (c-0.5)*k+0.5 更柔和，
          // 在 0 和 1 附近不会产生硬削波（那会造成色阶断层）。
          c = pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / uContrast ) );

          // ---------- 4. 饱和度 ----------
          float l = dot( c, LUMA );
          c = mix( vec3( l ), c, uSaturation );

          // ---------- 5. Split-tone（冷影暖光）----------
          // 这是本 pass 的核心。按亮度分两段施加相反色偏：
          //   暗部 -> 冷（青蓝，uShadowTint）
          //   亮部 -> 暖（橙黄，uHighlightTint）
          // 用 pow 曲线让中段几乎不受影响，避免整体染色。
          float w = smoothstep( 0.0, 1.0, l );
          vec3 shadowW = uShadowTint * pow( 1.0 - w, 2.0 );
          vec3 highW   = uHighlightTint * pow( w, 2.0 );
          c += ( shadowW + highW ) * uSplit;

          c = clamp( c, 0.0, 1.0 );

          // ---------- 6. 舞台光（关键的光影层次来源）----------
          //
          // 【为什么必须放在屏幕空间，不能用地面上的贴片】
          // 之前把亮区做成一张铺在广场上的径向渐变面片，结果：
          //   - 面片的**几何边界**永远会露出来。被像素化后，
          //     那圈边界读作「一条斜穿画面的虚线」，非常刺眼。
          //   - 面片跟着角色走时还要跟着旋转（俯视地面有透视），
          //     边界在屏幕上不是圆的而是斜的，更明显。
          //
          // 放到屏幕空间就没有这个问题：渐变的边界永远在画面之外，
          // 只剩下「中心亮、四周暗」这一个纯粹的亮度分布。
          //
          // 语义上这才是「舞台光」的本意 —— OT2 的镜头永远是斜俯视，
          // 光是从摄影棚上方打下来的，观众看到的是「一束光落在广场上」，
          // 而不是真的有一块发光的地面。
          //
          // 做法：中心提亮 + 四周压暗，两者共用同一个距离场，
          // 因此叠加后得到的是一条平滑的亮度曲线而不是两个色块。
          vec2 ld = ( vUv - uLightCenter ) * vec2( 1.0, 0.78 );
          float lDist = length( ld ) / uLightRadius;
          // smoothstep 让亮区边缘柔和，不出现可见的等高线
          float lFall = 1.0 - smoothstep( 0.35, 1.25, lDist );
          c *= 1.0 + uLightStrength * lFall;
          c *= 1.0 - uLightStrength * 0.42 * ( 1.0 - lFall );

          // ---------- 7. 暗角 ----------
          // 椭圆暗角，半径按画幅宽高比校正 —— 直接用 uv 距离会在
          // 非正方形视口下变成椭圆亮斑（手机上会很明显）。
          vec2 d = ( vUv - 0.5 ) * vec2( 1.0, 1.0 );
          float vig = 1.0 - uVignette * dot( d, d ) * 1.9;
          c *= clamp( vig, 0.0, 1.0 );

          // ---------- 8. 颗粒 ----------
          // 极轻的哈希噪声，作用是打散大面积平涂的色带（banding）。
          // 注意必须在像素化之前加：放到之后会破坏硬像素块。
          float n = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          c += ( n - 0.5 ) * uGrain;

          gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), texel.a );
        }
      `
    });

    this.fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  setSize(w, h) {
    this.uniforms.uResolution.value.set(w, h);
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
