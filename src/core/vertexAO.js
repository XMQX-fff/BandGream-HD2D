/**
 * 顶点 AO 烘焙 —— 用几何位置烘出环境光遮蔽，写进顶点色
 *
 * 为什么不加 SSAO/GTAO pass：
 *  1. 本项目的 HD-2D 观感不依赖精确的接触阴影，AO 只需要「物体底部变暗、
 *     角落积灰」这一个粗略信息。
 *  2. GTAO 需要额外的 depth + normal 预渲染通道。而 HD-2D 的管线里已经有
 *     RenderPixelatedPass 在低分辨率 RT 上重渲染一次场景，再加一遍预渲染
 *     会让填充率翻倍 —— 实测这台无 GPU 的沙盒里帧率已经很低。
 *  3. 顶点 AO 是**零运行时开销**的一次性计算：771 个 mesh 烘一次，
 *     之后每个像素只多带一个 vertex color。
 *
 * 参考实现：hd2d-diorama 的 envMaterial 同样用 vertexColors 承载 AO。
 *
 * 算法（针对本场景定制，不是通用 SSAO）：
 *  1. 高度项：越靠近地面越暗。这是 HD-2D 里最有效的 AO 来源 ——
 *     墙根、花坛底、喷泉基座都应该有一圈压暗，把物体「钉」在地面上。
 *  2. 向阳项：朝太阳的水平法线越接近阳光方向越亮，背面越暗。
 *     把光源方向烘进顶点色，等于给每个顶点一个廉价的漫反射近似，
 *     即使光源移动也能保持正确的明暗分布（因为偏移量固定）。
 *  3. 遮挡项：位于其他几何体「下方」的顶点额外压暗（简化的高度图采样）。
 */
import { Color, Vector3, Float32BufferAttribute } from 'three';

/** 太阳方向（与 scene.js 的 SUN_OFFSET 保持一致，指向光源） */
const SUN_DIR = new Vector3(-30, 34, 40).normalize();

/** 地面以下完全遮挡 */
const GROUND_Y = 0.0;

/** AO 强度可调，这里是烘焙进顶点色的整体倍率 */
const AO_STRENGTH = 0.55;

/**
 * 单个顶点的 AO 值（0 = 全暗，1 = 全亮）
 *
 * @param y      顶点世界高度
 * @param nx,ny,nz 顶点法线（世界空间）
 * @param occ    几何遮挡项 0..1（1 = 完全被挡）
 */
/**
 * 单个顶点的 AO 值（0.55 = 全暗侧，1.1 = 最亮）
 *
 * 力度必须克制 —— 这是本轮实测踩出来的：
 * AO 的作用只是「让物体和地面之间有接触感」，不是重新打光。
 * 第一版用了 0.35..1.15 的范围，结果整张地面被压成脏褐色，
 * 石板贴图的暖砂色、屋顶的暗红、木门的褐、树叶的绿全部消失 ——
 * 画面读作「一张糊掉的旧照片」。AO 一旦压过材质本身的颜色，
 * 画面就失去了 HD-2D 最依赖的清晰色块区分。
 *
 * 现在只保留 0.62..1.10：贴地顶点比高处暗约 38%，肉眼可见但不夺色。
 */
function vertexAO(y, nx, ny, nz, occ) {
  // --- 高度项（唯一的强项）---
  // 以 1.2 单位为衰减尺度：贴地顶点最暗，离地 1.2 以上完全不受影响。
  // 指数 0.55 让衰减集中在紧贴地面的一小段，读作「墙根接地」而非「渐变」。
  const h = Math.min(1, Math.max(0, y / 1.2));
  const heightAO = 0.62 + 0.38 * Math.pow(h, 0.55);

  // --- 向阳项（极弱）---
  // 只看水平法线分量，幅度仅 ±6%。这一项本来是想加强立体感，
  // 但实测它把同一栋房子的两面墙压成明显不同的颜色，
  // 而墙面之间的明暗本来就由真实光照负责 —— 重复着色只会串味。
  const hl = Math.hypot(nx, nz) || 1e-4;
  const dotSun = (nx * SUN_DIR.x + nz * SUN_DIR.z) / hl;
  const facingAO = 0.94 + 0.06 * dotSun;

  // 法线朝上的面（屋顶、地面）轻微提亮，模拟直接受光
  const upAO = 1 + 0.04 * Math.max(0, ny);

  let ao = heightAO * facingAO * upAO * (1 - occ * 0.3);
  return Math.min(1.1, Math.max(0.58, ao));
}

/**
 * 给一批 mesh 烘顶点 AO 并开启 vertexColors。
 *
 * 必须逐 mesh 处理：three 的 vertexColors 是材质级开关，一旦开启
 * 所有顶点都需要 color 属性，缺失会得到未定义行为（通常是黑）。
 */
export function bakeVertexAO(meshes, { skip = () => false } = {}) {
  const scratch = new Color();
  let baked = 0;
  let skipped = 0;

  for (const mesh of meshes) {
    if (!mesh.isMesh) continue;
    const geo = mesh.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) continue;
    if (skip(mesh)) continue;

    const pos = geo.attributes.position;
    let normal = geo.attributes.normal;
    if (!normal) { geo.computeVertexNormals(); normal = geo.attributes.normal; }

    // ---------- 只处理「竖直」几何体 ----------
    //
    // 接触阴影的定义是「物体靠近地面时变暗」，所以受益者必须是墙、柱、
    // 树干这类竖直表面。水平面（地面、屋顶、平台）本来就已经被 AO 高度项
    // 判为「离地远、不受遮蔽」，对它们烘焙毫无意义，却因为高度项把它们
    // 整体压暗 —— 这正是第一版整片地面变成脏褐色的原因。
    //
    // 判定：法线的水平分量显著（|nx|+|nz| > 0.5）即认为是竖直面。
    let vertical = false;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(normal.getX(i)) + Math.abs(normal.getZ(i)) > 0.5) { vertical = true; break; }
    }
    if (!vertical) { skipped++; continue; }

    // 顶点已经烘进世界矩阵（合并器做过 matrixWorld 变换），
    // 所以 object matrix 对顶点坐标不再生效 —— 直接用几何坐标算高度。
    const n = pos.count;
    const colors = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const nx = normal.getX(i);
      const ny = normal.getY(i);
      const nz = normal.getZ(i);

      const y = pos.getY(i);
      // 沉入地下的结构视为完全遮挡（应被地面吃掉的那部分）
      const occ = y < GROUND_Y - 0.02 ? 1 : 0;

      const ao = vertexAO(y, nx, ny, nz, occ);
      // 顶点色存的是「乘性衰减系数」而不是颜色本身
      scratch.setRGB(ao, ao, ao);
      scratch.toArray(colors, i * 3);
    }

    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
    baked++;

    // ---------- 关键：材质必须克隆，不能就地开启 vertexColors ----------
    //
    // three 的 vertexColors 是**材质级**开关。一旦就地开启，所有引用同一材质的
    // mesh 都会被强制走 vColor 路径 —— 包括那些没有 color 属性的几何体，
    // 它们读到的是未定义的色值。实测后果：整个场景被压成脏褐色，
    // 屋顶的暗红、木门的暖褐、树的绿全部消失（材质颜色 × 未定义 vColor）。
    //
    // 所以这里给每个烘过 AO 的 mesh 克隆一份材质。
    // 代价是 draw call 增加（材质分桶被打破），换来的是正确性。
    // 折中：共享材质按「原材质 -> 克隆材质」缓存，同源材质仍共享克隆结果。
    const srcMat = mesh.material;
    if (srcMat && !srcMat.userData.aoCloned) {
      const cloned = srcMat.clone();
      cloned.vertexColors = true;
      cloned.userData.aoCloned = true;
      cloned.userData.aoSource = srcMat;
      // 缓存挂在源材质上：后续引用同一源材质的 mesh 直接复用
      srcMat.userData.aoClone = cloned;
      mesh.material = cloned;
    } else if (srcMat && srcMat.userData.aoClone) {
      mesh.material = srcMat.userData.aoClone;
    }
  }

  return { baked, skipped };
}
