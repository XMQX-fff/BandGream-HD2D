/**
 * 静态几何合并 —— 把上千个 draw call 压到几十个
 *
 * 为什么需要：
 *   港口场景由大量小构件组成（房屋的每根梁、每个窗户框、每个木桶的桶箍……），
 *   三角形总数只有 3 万，但 draw call 高达 1600+。瓶颈完全在 CPU 端的
 *   每帧状态切换与提交，而非 GPU。实测把分辨率降到 1/16 帧率几乎不变，
 *   证实了这一点。
 *
 * 做法：
 *   遍历场景，按「材质实例」分桶，把每个 Mesh 的世界矩阵烘焙进顶点后合并。
 *   同材质才能合并 —— 所以材质必须复用（props.js 的 MATS 缓存已保证）。
 *
 * 不合并的东西：
 *   - 角色 / NPC 精灵（要逐帧换贴图 offset）
 *   - 水面（自定义 shader，动画顶点）
 *   - 任何带 userData.dynamic 标记的物体
 */
import { Mesh, Group, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 需要保留独立的对象名 */
const KEEP_ALONE = new Set(['water']);

/** 递归收集静态网格（跳过 Sprite/Points/自定义 shader 材质） */
function collectStatic(root, out, skipRoot = false) {
  for (const child of root.children) {
    if (!skipRoot && KEEP_ALONE.has(child.name)) continue;
    if (child.userData.dynamic) continue;

    // 精灵与点精灵不能合并（贴图 offset 逐帧变）
    if (child.isSprite || child.isPoints || child.isLine) continue;
    // 自定义 shader 材质（水面）不合并
    if (child.material && child.material.isShaderMaterial) continue;

    if (child.isMesh && child.geometry && child.geometry.isBufferGeometry) {
      // 非索引几何体（mergeGeometries 要求一致），统一转索引以减少顶点
      out.push(child);
      continue;
    }
    if (child.children && child.children.length) collectStatic(child, out);
  }
}

/**
 * 把 root 下的静态网格按材质合并，替换为少量新 Mesh。
 * @returns {{before:number, after:number, meshes:Mesh[]}}
 */
export function mergeStatics(root) {
  root.updateMatrixWorld(true);

  const buckets = new Map(); // material -> Mesh[]
  const meshes = [];
  collectStatic(root, meshes);
  const before = meshes.length;

  for (const m of meshes) {
    const mat = m.material;
    if (!mat) continue;
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat).push(m);
  }

  // 记录所有待删除的顶层来源：直接收集的 mesh 及其祖先 Group
  const toRemove = new Set();
  for (const m of meshes) {
    toRemove.add(m);
    let p = m.parent;
    while (p && p !== root) { toRemove.add(p); p = p.parent; }
  }
  for (const obj of toRemove) obj.removeFromParent();

  const mergedGroup = new Group();
  mergedGroup.name = 'statics_merged';

  let after = 0;
  for (const [mat, group] of buckets) {
    if (group.length === 1) {
      // 单个 mesh 无需合并，直接还原（保持原世界变换）
      const m = group[0];
      m.matrix.copy(m.matrixWorld);
      m.matrix.decompose(m.position, m.quaternion, m.scale);
      mergedGroup.add(m);
      after++;
      continue;
    }

    const geos = [];
    let castShadow = false;
    let receiveShadow = false;
    for (const m of group) {
      const g = m.geometry.clone();
      // 世界矩阵烘焙进顶点，合并后无需再套父级变换
      g.applyMatrix4(m.matrixWorld);
      // 统一属性集：只保留合并所需的三件套，避免属性不一致导致合并失败
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') {
          g.deleteAttribute(name);
        }
      }
      castShadow = castShadow || m.castShadow;
      receiveShadow = receiveShadow || m.receiveShadow;
      if (!g.attributes.uv) {
        // 没有 UV 的几何体补一张全 0 的，保证属性集一致
        const count = g.attributes.position.count;
        g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(count * 2), 2));
      }
      geos.push(g.index ? g.toNonIndexed() : g);
    }

    let merged = null;
    try {
      merged = mergeGeometries(geos, false);
    } catch (err) {
      console.warn('[mergeStatics] 合并失败，回退为独立 mesh', mat.name, err);
      merged = null;
    }

    if (merged) {
      const mesh = new Mesh(merged, mat);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mergedGroup.add(mesh);
      after++;
      for (const g of geos) g.dispose();
    } else {
      // 回退：保留原物体
      for (const m of group) mergedGroup.add(m);
      after += group.length;
    }
  }

  root.add(mergedGroup);
  return { before, after, meshes: mergedGroup.children };
}

/** 便于在窗口里检查合并结果 */
export function countDrawables(root) {
  let n = 0;
  root.traverse((o) => {
    if ((o.isMesh || o.isSprite || o.isPoints || o.isLine) && o.visible) n++;
  });
  return n;
}