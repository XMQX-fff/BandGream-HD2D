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
 *
 * ----------------------------------------------------------------------
 *  【分桶为什么不按「栋」拆开 —— 这里踩过一个昂贵的弯路】
 * ----------------------------------------------------------------------
 *
 * 建筑淡出（core/fade.js）需要「一栋楼能被独立控制」，
 * 而合并之后一栋楼被打散进各个材质桶里，不再是独立对象。
 * 最直觉的修法是把桶键从「材质」改成「(材质, 栋号)」，
 * 合并结果就变成「一栋楼 = 一组可独立控制的 mesh」。
 *
 * **这个方案会让帧率崩掉。** 全城上千栋、每栋 4~6 种材质
 * （墙/屋顶/门窗/装饰/接触阴影），二元组分桶后桶数约 4000~6000，
 * 而现在只有几十个 —— draw call 涨两位数。
 * 本项目的瓶颈完全在 CPU 端的提交开销（实测分辨率降到 1/16
 * 帧率几乎不变，证实不是 GPU 填充率问题），
 * 为一个视觉增强把性能打掉两个数量级不可接受。
 *
 * 所以分桶逻辑**保持不变**（只按材质），
 * 改为在合并时给每个顶点附带一个 `aFadeId` 逐顶点属性。
 * 逐顶点数据不受分桶约束 —— 同一个合并 mesh 里可以同时装着
 * 几百栋楼的顶点，各自带不同的 aFadeId。
 * 淡出系统在 shader 里按 aFadeId 查表决定丢弃哪些片元，
 * 于是**draw call 数量与优化前完全一致**。
 *
 * 【aFadeId 的语义】
 *   ≥ 0  该顶点属于 blockers 列表里的第几号遮挡物（= 哪栋楼）
 *   = -1 不参与淡出（地面、树、路灯、船、接触阴影等）
 * 用 -1 而不是 0：0 是合法的栋号，而被 discard 的片元
 * 在 GPU 上会读到未初始化属性值（通常是 0），
 * 于是「不参与淡出」的片元会误查成第 0 栋、跟着别人一起淡。
 */
import { Mesh, Group, Float32BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 需要保留独立的对象名 */
const KEEP_ALONE = new Set(['water']);

/** 逐顶点属性名。与 fade.js 的 shader 注入保持一致。 */
const FADE_ATTR = 'aFadeId';

/**
 * 沿父链向上找该 mesh 所属的栋号（fadeGroup）。
 *
 * 【为什么要沿父链找，而不是只看 mesh 自己】
 * 建筑是一个 Group（墙、屋顶、门窗、烟囱各自是独立 mesh），
 * fadeGroup 打在 Group 的 userData 上，构件自己身上没有。
 *
 * @returns {number} 栋号，未归属返回 -1
 */
function findFadeGroup(obj) {
  let p = obj;
  while (p) {
    const fg = p.userData && p.userData.fadeGroup;
    // 0 是**无效**的栋号（FADE_ID 从 1 自增），跳过它继续往上找。
    // 这样嵌套 Group（街区内再套房子组）也能正确取到最内层的栋号。
    if (fg !== undefined && fg > 0) return fg;
    p = p.parent;
  }
  return -1;
}

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
      // 记下所属栋号：合并时写进逐顶点属性，供淡出 shader 查表
      child.userData._fadeGroup = findFadeGroup(child);
      out.push(child);
      continue;
    }
    if (child.children && child.children.length) collectStatic(child, out);
  }
}

/**
 * 把 root 下的静态网格按材质合并，替换为少量新 Mesh。
 *
 * 每个合并结果都带一个 `aFadeId` 逐顶点属性，标注该顶点属于哪栋楼。
 * 分桶逻辑不变（只按材质），因此 draw call 数量与优化前一致 ——
 * 详见文件顶部「分桶为什么不按栋拆开」的说明。
 *
 * @returns {{before:number, after:number, meshes:Mesh[], materials:Material[]}}
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

  /**
   * 给几何体补一个常量值的 aFadeId 属性。
   *
   * 【为什么必须给「所有」几何体都补，包括 -1 的】
   * 两个独立的原因，缺一不可：
   *
   *  ① mergeGeometries 要求所有待合并几何体的属性集**完全一致**，
   *    少一个属性就会 merge 失败（抛错并回退为独立 mesh）。
   *    而一个材质桶里通常既有建筑构件、也有地面/树/道具 ——
   *    只有建筑构件的 fadeGroup ≥ 0。所以缺省值必须显式填 -1。
   *
   *  ② 被 discard 的片元在 GPU 上会读到**未初始化**的属性值
   *    （实践中通常是 0）。0 是合法栋号，
   *    于是「不参与淡出」的片元会误查成第 0 栋、跟着第 0 栋一起淡。
   *    -1 让 shader 能显式判负走「永远实体」分支。
   */
  function ensureFadeAttr(geo, group) {
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n);
    if (group > 0) arr.fill(group);
    else arr.fill(-1);
    geo.setAttribute(FADE_ATTR, new Float32BufferAttribute(arr, 1));
  }

  let after = 0;
  for (const [mat, group] of buckets) {
    if (group.length === 1) {
      // 单个 mesh 无需合并，直接还原（保持原世界变换）
      const m = group[0];
      m.matrix.copy(m.matrixWorld);
      m.matrix.decompose(m.position, m.quaternion, m.scale);
      // 单 mesh 路径同样要补属性 —— 它也会被注入淡出 shader，
      // 缺属性会导致该 mesh 读到未定义值。
      //
      // 【必须 clone 几何体，不能就地改】
      // props.js 用 MATS 缓存复用材质，几何体也可能被多个 mesh 共享
      // （尤其 LOD 各级复用同一套 BoxGeometry 的情况）。
      // 就地 setAttribute 会把属性写到共享对象上，
      // 于是「共享同一几何体的另一栋楼」也会带上错误的栋号 ——
      // 静默错淡，且只在特定 LOD 组合下出现，极难复现。
      if (!m.geometry.userData.fadeOwned) {
        m.geometry = m.geometry.clone();
        m.geometry.userData.fadeOwned = true;
      }
      ensureFadeAttr(m.geometry, m.userData._fadeGroup);
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
      // 统一属性集：只保留合并所需的三件套 + 淡出用的 aFadeId，
      // 避免属性不一致导致合并失败。
      // 【aFadeId 必须进白名单】否则它会被下面的循环删掉，
      // 而它的值必须在 applyMatrix4 之后按「每个顶点同一值」写入。
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== FADE_ATTR) {
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
      // 逐顶点打栋号。注意 toNonIndexed() 会复制全部属性，
      // 所以必须在它之后设置 —— 否则转换后的几何体上没有这个属性。
      const ng = g.index ? g.toNonIndexed() : g;
      ensureFadeAttr(ng, m.userData._fadeGroup);
      geos.push(ng);
      // toNonIndexed() 产生的是新几何体，原件已无用。
      // 不 dispose 会让每个构件的原始几何体都留在显存里 ——
      // 上千个构件累积起来是几 MB 的纯浪费。
      if (ng !== g) g.dispose();
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
      //
      // 【这里也必须补属性 —— 否则诊断脚本会报「有无 fade 属性的 mesh」
      //   数量不为零，而这个数量不为零意味着那些 mesh 在 shader 里
      //   读到的 aFadeId 是未初始化值。症状与「淡出完全不生效」一致，
      //   但根因完全不同：一个是查表逻辑错，一个是输入是垃圾。
      //   两者必须能区分开，所以这里补齐，让「有无属性」恒为零。
      for (const m of group) {
        ensureFadeAttr(m.geometry, m.userData._fadeGroup);
        mergedGroup.add(m);
      }
      after += group.length;
    }
  }

  root.add(mergedGroup);

  /**
   * 收集去重后的材质列表。
   *
   * 淡出注入要按材质走 onBeforeCompile，而分桶时同一个材质
   * 可能产出多个 mesh（单 mesh 路径 + 合并路径），
   * 所以这里对材质去重后返回，供调用方一次性注入。
   */
  const materials = new Set();
  for (const m of mergedGroup.children) {
    if (m.material) materials.add(m.material);
  }

  return { before, after, meshes: mergedGroup.children, materials: Array.from(materials) };
}

/** 便于在窗口里检查合并结果 */
export function countDrawables(root) {
  let n = 0;
  root.traverse((o) => {
    if ((o.isMesh || o.isSprite || o.isPoints || o.isLine) && o.visible) n++;
  });
  return n;
}