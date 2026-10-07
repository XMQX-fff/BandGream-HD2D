/**
 * HD-2D 风格化后处理 Pass
 *
 * 包含两个自定义 pass：
 *  - TiltShiftPass   微缩模型景深（替代 BokehPass，理由见下方注释）
 *  - PosterizePass   色阶量化，去"塑料感"性价比最高的一步
 */
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderMaterial, Vector2 } from 'three';

/**
 * TiltShiftPass —— 微缩景深
 *
 * 为什么不用 BokehPass：
 *  1. BokehShader 的 `PERSPECTIVE_CAMERA` define 在 r186 中恒为 1，且
 *     BokehPass 从不覆盖它，深度解码只按透视相机走。
 *  2. 它的深度 RT 是全分辨率，而底图已被 NearestFilter 像素化，
 *     模糊采样会落在像素块内部或跨块，把像素块半途抹开 —— 这是 HD-2D
 *     最典型的「像素感被景深毁掉」。
 *
 * 本 pass 的设计：
 *  - 不解码深度。模糊半径由 JS 侧算好的 uniform 驱动，聚焦带中心固定
 *    在屏幕中下部。俯角 30-40° 时屏幕 Y 同时受世界 X 与深度影响，若用
 *    「角色屏幕 Y」驱动带心，左右走位会让带子上下抖动 —— 俯视角下的致命耦合。
 *  - 采样偏移以像素块为单位并做半像素量化，保证模糊后仍保留硬像素颗粒。
 */
export class TiltShiftPass extends Pass {
  constructor(pixelSize = 3) {
    super();
    this.pixelSize = pixelSize;

    this.uniforms = {
      tDiffuse:    { value: null },
      // 聚焦带中心（屏幕空间 0..1，0=底部）
      uFocusCenter: { value: 0.45 },
      // 聚焦带半宽，带内几乎不模糊
      uFocusWidth:  { value: 0.15 },
      // 带外最大模糊半径（单位：像素块）
      uMaxBlur:     { value: 1.5 },
      // 角色视距带来的额外模糊梯度
      uDepthBias:   { value: 0.5 },
      // 角色视距归一化 0..1
      uFocusDistance: { value: 0.5 },
      // 一个像素块的屏幕尺寸（1/低分辨率宽高）
      uPixelTexel:  { value: new Vector2(1 / 480, 1 / 270) }
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
        uniform float uFocusCenter;
        uniform float uFocusWidth;
        uniform float uMaxBlur;
        uniform float uDepthBias;
        uniform float uFocusDistance;
        uniform vec2  uPixelTexel;
        varying vec2 vUv;

        const int  TAPS = 12;

        void main() {
          // 一个像素块的 UV 尺寸
          vec2 texel = uPixelTexel;

          // 垂直带状遮罩：离聚焦带中心越远越糊
          float dist = abs( vUv.y - uFocusCenter );
          float band = 1.0 - smoothstep( uFocusWidth, uFocusWidth * 3.4, dist );

          // 角色视距带来的整体模糊微调
          float depthTerm = abs( uFocusDistance - 0.5 ) * uDepthBias;

          // 汇聚为半径（单位：像素块），并做半像素块量化以保住颗粒感
          float radiusPx = ( 1.0 - band ) * uMaxBlur + depthTerm * 0.6;
          radiusPx = floor( radiusPx * 2.0 + 0.25 ) * 0.5;

          if ( radiusPx < 0.3 ) {
            gl_FragColor = texture2D( tDiffuse, vUv );
            return;
          }

          vec2 o = texel * radiusPx;

          vec4 sum = texture2D( tDiffuse, vUv ) * 0.20;
          sum += texture2D( tDiffuse, vUv + vec2(  o.x, 0.0 ) * 0.5 ) * 0.10;
          sum += texture2D( tDiffuse, vUv + vec2( -o.x, 0.0 ) * 0.5 ) * 0.10;
          sum += texture2D( tDiffuse, vUv + vec2( 0.0,  o.y ) * 0.5 ) * 0.10;
          sum += texture2D( tDiffuse, vUv + vec2( 0.0, -o.y ) * 0.5 ) * 0.10;
          sum += texture2D( tDiffuse, vUv + o * 0.7 ) * 0.08;
          sum += texture2D( tDiffuse, vUv - o * 0.7 ) * 0.08;
          sum += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) * 0.7 ) * 0.08;
          sum += texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) * 0.7 ) * 0.08;
          sum += texture2D( tDiffuse, vUv + o ) * 0.04;
          sum += texture2D( tDiffuse, vUv - o ) * 0.04;
          sum += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ) * 0.04;
          sum += texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ) * 0.04;

          gl_FragColor = sum;
        }
      `
    });

    this.fsQuad = new FullScreenQuad(this.material);
  }

  /**
   * 每帧更新聚焦参数。
   * @param {number} playerViewDist 角色沿相机 forward 轴的视距
   * @param {number} cameraHeight   相机离地高度
   */
  update(playerViewDist, cameraHeight) {
    // 归一化视距：假定可玩范围视距落在 [d0, d1]
    const d0 = cameraHeight * 0.8;
    const d1 = cameraHeight * 2.4;
    const t = Math.min(1, Math.max(0, (playerViewDist - d0) / Math.max(1e-3, d1 - d0)));
    this.uniforms.uFocusDistance.value = t;
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
    // 传入的是 EffectComposer 的全屏尺寸，但着色器采样的是「像素化之后」的
    // RT —— 那张 RT 的宽高只有全屏的 1/pixelSize。
    // 早期版本直接把 (w,h) 当成像素块 UV 尺寸用，导致模糊半径被放大 pixelSize 倍，
    // 整个画面（连本该清晰的聚焦带）都被抹糊，HD-2D 的硬像素颗粒全丢。
    const p = this.pixelSize || 1;
    this.uniforms.uPixelTexel.value.set(p / Math.max(1, w), p / Math.max(1, h));
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

/**
 * PosterizePass —— 色阶量化 + 饱和度提升
 *
 * 即使做了像素化，颜色仍是连续渐变，画面依然偏「3D 渲染」而非「手绘」。
 * 量化到 N 级是去塑料感最大的杠杆。
 */
export class PosterizePass extends Pass {
  constructor(levels = 28, saturation = 1.14) {
    super();
    this.uniforms = {
      tDiffuse:    { value: null },
      uLevels:     { value: levels },
      uSaturation: { value: saturation }
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
        uniform float uLevels;
        uniform float uSaturation;
        varying vec2 vUv;

        void main() {
          vec4 texel = texture2D( tDiffuse, vUv );
          vec3 c = texel.rgb;

          // 饱和度提升
          float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
          c = mix( vec3( luma ), c, uSaturation );

          // 注意：这里刻意不加 dither 抖动。
          // 本 pass 必须跑在 RenderPixelatedPass「之前」（全分辨率），
          // 一旦放到像素化之后，逐像素随机的 dither 会让同一个像素块内
          // 每个像素的量化结果不同 —— 干净的色块被打成彩色噪点，
          // 正好毁掉 HD-2D 最核心的硬像素颗粒感。
          c = floor( c * uLevels + 0.5 ) / uLevels;

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

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}