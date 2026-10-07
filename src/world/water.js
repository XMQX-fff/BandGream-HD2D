/**
 * 风格化海面
 *
 * 为什么不用 Reflector.js / Water.js：
 *  1. 两者每帧都额外渲染一遍场景到反射 RT。本场景已经在跑像素化 pass，
 *     再加一遍 = 每帧 3 遍场景渲染。
 *  2. 反射 RT 是 HalfFloatType + LinearFilter，与主链路的 NearestFilter
 *     不一致 —— 水面会成为画面里唯一「不像素化」的区域，非常突兀。
 *  3. 物理正确的平面镜面反射 ≠ HD-2D。OT2 的水面是风格化手绘波纹。
 *
 * 做法：程序化波纹 normal map + 菲涅尔 + 天空/屋顶纯色近似反射。
 * 零额外 pass、完全兼容像素化。水面 roughness 偏低是对的 —— 水面高光
 * 正是 HD-2D 的重要特征（与建筑相反）。
 */
import { Mesh, PlaneGeometry, ShaderMaterial, Color, Vector3, DoubleSide } from 'three';
import { CanvasTexture, RepeatWrapping, NearestFilter } from 'three';

/** 程序化生成像素风波纹 normal map（保持 Nearest 以符合像素风） */
function makeWaveNormalTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);

  // 叠加几组不同频率/方向的正弦波，形成手绘感的规则波纹
  const waves = [
    { fx: 0.055, fy: 0.020, a: 1.00, p: 0.0 },
    { fx: -0.030, fy: 0.048, a: 0.75, p: 1.7 },
    { fx: 0.014, fy: -0.062, a: 0.55, p: 3.1 },
    { fx: 0.090, fy: 0.075, a: 0.28, p: 0.6 }
  ];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      // 周期性采样，保证纹理无缝平铺
      let h = 0;
      for (const w of waves) {
        h += w.a * Math.sin(2 * Math.PI * (w.fx * x + w.fy * y) + w.p);
      }
      h /= 3.58; // 归一化到约 [-1,1]

      // 由高度场差分求法线
      const eps = 1.0;
      let hx = 0, hy = 0;
      for (const w of waves) {
        const ph = 2 * Math.PI * (w.fx * x + w.fy * y) + w.p;
        hx += w.a * Math.cos(ph) * w.fx * eps * S;
        hy += w.a * Math.cos(ph) * w.fy * eps * S;
      }

      let nx = -hx * 0.006;
      let ny = -hy * 0.006;
      const nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len;
      const nzn = nz / len;

      const i = (y * S + x) * 4;
      img.data[i]     = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nzn * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

export function createWater({ size = 320, segments = 1, color = 0x2e9ec4, deep = 0x14567f } = {}) {
  const waveTex = makeWaveNormalTexture();
  waveTex.repeat.set(size / 90, size / 90);

  const uniforms = {
    uTime:       { value: 0 },
    uWaveMap:    { value: waveTex },
    uShallow:    { value: new Color(color) },
    uDeep:       { value: new Color(deep) },
    uSkyColor:   { value: new Color(0x9fd8ef) },
    uRoofColor:  { value: new Color(0xb5563a) },
    uSunDir:     { value: new Vector3(0.45, 0.72, 0.52).normalize() },
    uSunColor:   { value: new Color(0xfff0c8) },
    uFogColor:   { value: new Color(0xbfe3f2) },
    uFogNear:    { value: 60.0 },
    uFogFar:     { value: 210.0 }
  };

  const material = new ShaderMaterial({
    uniforms,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float     uTime;
      uniform sampler2D uWaveMap;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uSkyColor;
      uniform vec3 uRoofColor;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vWorldPos;
      varying vec2 vUv;

      void main() {
        // 两层反向滚动的波纹，制造流动感
        vec3 n1 = texture2D( uWaveMap, vWorldPos.xz * 0.0125 + vec2(  uTime * 0.013, uTime * 0.009 ) ).rgb * 2.0 - 1.0;
        vec3 n2 = texture2D( uWaveMap, vWorldPos.xz * 0.0068 - vec2( uTime * 0.008, uTime * 0.011 ) ).rgb * 2.0 - 1.0;
        vec3 n  = normalize( vec3( n1.x + n2.x * 0.7, 1.0, n1.y + n2.y * 0.7 ) );

        vec3 viewDir = normalize( cameraPosition - vWorldPos );

        // 菲涅尔：视线越平，反射越强
        float fres = pow( 1.0 - clamp( dot( viewDir, n ), 0.0, 1.0 ), 2.4 );
        fres = clamp( fres, 0.0, 1.0 );

        // 水体本色：近处偏浅、远处偏深（用视线距离近似水深）
        float dist = length( cameraPosition - vWorldPos );
        float deepMix = smoothstep( 10.0, 120.0, dist );
        vec3 water = mix( uShallow, uDeep, deepMix * 0.75 );

        // 反射色：天空 + 赭红屋顶（港口的近似色反射，纯色即可）
        vec3 refl = mix( uSkyColor, uRoofColor, 0.30 + 0.20 * n.x );

        vec3 col = mix( water, refl, fres * 0.72 );

        // 阳光高光（Bloop 的主要来源）
        vec3 h = normalize( uSunDir + viewDir );
        float spec = pow( max( dot( n, h ), 0.0 ), 90.0 );
        col += uSunColor * spec * 1.7;

        // 波纹高光带：手绘感的碎光
        float sparkle = smoothstep( 0.86, 1.0, n.x * 0.5 + n.z * 0.5 ) * 0.10;
        col += uSunColor * sparkle;

        // 手动雾（与场景 Fog 保持一致，避免水面在远处突兀）
        float fogF = smoothstep( uFogNear, uFogFar, dist );
        col = mix( col, uFogColor, fogF );

        gl_FragColor = vec4( col, 1.0 );
      }
    `
  });

  const mesh = new Mesh(new PlaneGeometry(size, size, segments, segments), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.name = 'water';
  mesh.userData.update = (t) => { uniforms.uTime.value = t; };
  return mesh;
}