"""
三合一诊断：碰撞缺失 / 淡出缺失 / 建筑落在海上
================================================================
用户反馈三个问题，本脚本一次性量化，不靠推断：

  1. 「很多房子没有做碰撞体积可以穿过去」
  2. 「也有部分房子没有做人物遮盖时的透视」
  3. 「有好多房子被放置到海上无法到达」

【为什么必须先量化，而不是直接改代码】
上一轮三个 bug 全部是「数量对、位置错」，
而所有诊断只统计数量，于是完美掩盖。
本脚本的核心是**逐栋交叉校验**：
  · 碰撞：buildingTags（生成侧）vs blockers（登记侧），逐栋配对
  · 淡出：几何体实际顶点的 aFadeId vs 该栋应有的 blockers 下标
  · 海上：建筑 z vs 实际水面覆盖范围

【为什么碰撞必须按「栋」校验，不能只数solid 数量】
上一轮 fade_dump 发现 777 个盒子中心恰好在 (0,0)，
而 solid 计数一直是 874 —— 数量完全正常。
数量只能证明「登记过」，证不了「登记在正确的位置」。

运行：python3.11 tools/triage.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'screenshots')


def main():
    from playwright.sync_api import sync_playwright

    url = 'http://127.0.0.1:4173/'

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                '--no-sandbox', '--disable-setuid-sandbox',
                '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                '--window-size=1280,760',
            ],
        )
        page = browser.new_page(viewport={'width': 1280, 'height': 760})
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
        page.goto(url, wait_until='load')
        page.wait_for_function('window.__HD2D__ && window.__HD2D__.buildingTags', timeout=180000)
        page.wait_for_timeout(3000)

        r = page.evaluate(TRIAGE_JS)

        browser.close()

    print('=== 三合一诊断 ===')
    print('JS 错误 %d 条' % len(errs))
    for e in errs[:5]:
        print('   ! ' + e[:150])

    print('')
    print('--- 规模 ---')
    for k in ('tags', 'blockers', 'solid', 'mergedMeshes', 'meshesWithAttr',
              'attrIdMin', 'attrIdMax'):
        print('  %-16s %s' % (k, r['scale'][k]))

    # ---------- 问题 1：碰撞缺失 ----------
    print('')
    print('--- 问题1 碰撞 ---')
    c = r['collide']
    print('  建筑标签 %d 栋' % c['tags'])
    print('  其中有 solid 盒 %d 栋  缺碰撞 %d 栋' % (c['withSolid'], c['missing']))
    if c['missingSamples']:
        print('  缺碰撞样本:')
        for s in c['missingSamples'][:8]:
            print('    %-14s @ (%7.1f,%7.1f)  %s' % (s['key'], s['x'], s['z'], s['note']))
    print('  有盒但 solid=false %d 栋' % c['notSolid'])
    if c['notSolidSamples']:
        print('  非 solid 样本:')
        for s in c['notSolidSamples'][:6]:
            print('    %-14s @ (%7.1f,%7.1f)' % (s['key'], s['x'], s['z']))
    print('  最近的盒子仍远于 3m 的: %d 栋（这才是真错位）' % c['farCount'])
    for s in c.get('devSamples', []):
        print('    %-14s tag(%7.1f,%7.1f) 最近盒(%7.1f,%7.1f) 偏差 %.2f'
              % (s['key'], s['tx'], s['tz'], s['bx'], s['bz'], s['dev']))

    # ---------- 问题 2：淡出缺失 ----------
    print('')
    print('--- 问题2 淡出 ---')
    f = r['fade']
    print('  几何体带 aFadeId 的 mesh %d 个' % f['meshesWithAttr'])
    print('  aFadeId 范围 [%s, %s]' % (f['attrIdMin'], f['attrIdMax']))
    print('  登记组号范围 [%s, %s]' % (f['grpMin'], f['grpMax']))
    print('  该有 aFadeId 却缺失的栋: %d' % f['tagsWithoutGroup'])
    if f['tagsWithoutGroupSamples']:
        print('  缺失样本:')
        for s in f['tagsWithoutGroupSamples'][:8]:
            print('    %-14s @ (%7.1f,%7.1f)  %s' % (s['key'], s['x'], s['z'], s['note']))
    print('  几何体带 id 但 blockers 里查不到该组: %d' % f['orphanIds'])
    print('  顶点数为 0 的栋: %d' % f['zeroVertGroups'])
    if f['note']:
        print('  ! ' + f['note'])

    # ---------- 问题 3：海上建筑 ----------
    print('')
    print('--- 问题3 海上建筑 ---')
    s = r['sea']
    print('  岸线 z=%.1f  水面覆盖 z <= %.1f' % (s['shoreZ'], s['seaEdgeZ']))
    print('  落在水面上的建筑: %d 栋' % s['onWater'])
    if s['onWaterSamples']:
        print('  样本:')
        for x in s['onWaterSamples'][:10]:
            print('    %-14s @ (%7.1f,%7.1f)  离岸 %.1f' % (x['key'], x['x'], x['z'], x['depth']))
    print('  街区地块总数 %d，其中生成在水面上的 %d' % (s['blockTotal'], s['blockInWater']))
    if s['note']:
        print('  ! ' + s['note'])

    # ---------- 综合判定 ----------
    bad = []
    if c['missing']:
        bad.append('碰撞缺失 %d 栋' % c['missing'])
    if c['farCount']:
        bad.append('盒子与房子完全无关 %d 栋' % c['farCount'])
    if f['tagsWithoutGroup']:
        bad.append('淡出组号缺失 %d 栋' % f['tagsWithoutGroup'])
    if f['orphanIds']:
        bad.append('孤立 aFadeId %d' % f['orphanIds'])
    if s['onWater']:
        bad.append('海上建筑 %d 栋' % s['onWater'])
    if errs:
        bad.append('JS 错误 %d 条' % len(errs))
    print('')
    if bad:
        for x in bad:
            print('  x ' + x)
        return 1
    print('  三项全部通过。')
    return 0


TRIAGE_JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const B = H.blockers || [];
  const W = H.worldBounds;

  // ---------- 水面实际覆盖范围 ----------
  // 地面从 shorelineZ 开始往 +Z 铺，水面从 shorelineZ 往 -Z 铺。
  // 因此「水上」的判据是建筑中心的 z 小于岸线。
  // 用 seaSize 反推水面北缘，而不是硬编码。
  const shoreZ = -4;
  const seaSize = (() => {
    const w = H.scene && H.scene.getObjectByName('water');
    if (w && w.geometry && w.geometry.parameters) return w.geometry.parameters.width;
    return 320;
  })();

  // ------------------------------------------------------------------
  // 问题 1：碰撞 —— 逐栋交叉校验
  // ------------------------------------------------------------------
  // 【为什么不能只数 solid 数量】
  // 上一轮 777 个盒子全在 (0,0)，而 solid 计数一直是 874，完全正常。
  // 数量只能证明「登记过」，证不了「登记在正确的位置」。
  // 所以这里对每栋建筑找**包含它中心**的 solid 盒，而不是找最近的盒。
  const solidBoxes = [];
  for (let i = 0; i < B.length; i++) if (B[i].solid) solidBoxes.push(B[i]);

  let withSolid = 0, missing = 0, notSolid = 0;
  const missingSamples = [], notSolidSamples = [];
  let maxDev = 0, farCount = 0;
  const devSamples = [];

  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    // 找中心落在盒内的那个（膨胀 1.5 容差，抵住登记时的 EAVE 余量）
    //
    // 【为什么必须用「包含」而不是「最近」】
    // 早前用「找最近的盒子」算偏差，于是带院墙的房子
    // （houseWithGarden 的登记盒含院墙，比主体宽出一圈）
    // 全部报出 2~7 米的偏差 —— 看着像位置错位，
    // 实际那栋房子在自己的盒里，位置完全正确。
    //
    // 判据应该是「这栋房子有没有被一个盒子包住」，
    // 而「盒子中心偏不偏」这个问题对带院墙的房子没有意义。
    // 记偏差只用于诊断「盒子与房子完全无关」这种极端情况。
    let hit = -1, containDev = 0, nearest = -1, nearestDev = Infinity;
    for (let k = 0; k < B.length; k++) {
      const b = B[k];
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const dev = Math.hypot(cx - t.x, cz - t.z);
      if (dev < nearestDev) { nearestDev = dev; nearest = k; }
      if (t.x > b.minX - 1.5 && t.x < b.maxX + 1.5 &&
          t.z > b.minZ - 1.5 && t.z < b.maxZ + 1.5) {
        if (b.solid && hit < 0) { hit = k; containDev = dev; }
        else if (!b.solid && hit < 0) hit = -(k + 2);
      }
    }
    if (hit >= 0) {
      withSolid++;
      // 只有「最近的盒子离得很远」才是真异常 —— 说明这栋房子
      // 附近的盒子和它毫无关系，典型的「盒子登记在别处」。
      if (nearestDev > 3.0) {
        farCount++;
        if (devSamples.length < 6) {
          const b = B[nearest];
          devSamples.push({ key: t.key, tx: t.x, tz: t.z,
            bx: (b.minX + b.maxX) / 2, bz: (b.minZ + b.maxZ) / 2, dev: nearestDev });
        }
      }
      if (nearestDev > maxDev) maxDev = nearestDev;
    } else if (hit < -1) {
      notSolid++;
      if (notSolidSamples.length < 6)
        notSolidSamples.push({ key: t.key, x: t.x, z: t.z });
    } else {
      missing++;
      if (missingSamples.length < 8)
        missingSamples.push({ key: t.key, x: t.x, z: t.z, note: '完全无盒' });
    }
  }

  // ------------------------------------------------------------------
  // 问题 2：淡出 —— 几何体实际顶点 vs 登记组号
  // ------------------------------------------------------------------
  // 【核心：按「栋」查，而不是只看 id 范围】
  // 淡出系统只认 aFadeId。栋号 = blockers 下标。
  // 若某栋的 userData.fadeGroup 是 -1（没登记上），
  // 它的顶点就不会被写入 id —— 房子照常渲染，但永远不淡出。
  let tagsWithoutGroup = 0, orphanIds = 0, zeroVert = 0;
  const tagsWithoutGroupSamples = [];

  // 收集所有几何体上出现过的 id
  const seen = new Set();
  let meshesWithAttr = 0, attrMin = Infinity, attrMax = -Infinity;
  let meshesTotal = 0;
  const scene = H.scene;
  if (scene) {
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (o.name === 'water' || o.name === 'blob-shadow') return;
      const a = o.geometry.attributes && o.geometry.attributes.aFadeId;
      if (!a) return;
      meshesWithAttr++;
      const arr = a.array;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < attrMin) attrMin = v;
        if (v > attrMax) attrMax = v;
        if (v >= 0) seen.add(v);
      }
    });
  }

  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const g = t.group;
    let fg = -2;
    let p = g;
    while (p) {
      if (p.userData && p.userData.fadeGroup !== undefined) { fg = p.userData.fadeGroup; break; }
      p = p.parent;
    }
    if (fg < 0) {
      tagsWithoutGroup++;
      if (tagsWithoutGroupSamples.length < 8)
        tagsWithoutGroupSamples.push({
          key: t.key, x: t.x, z: t.z,
          note: fg === -2 ? 'Group 上无 fadeGroup 字段' : 'fadeGroup=' + fg
        });
    } else if (!seen.has(fg)) {
      zeroVert++;
    }
  }
  for (const v of seen) if (v >= B.length) orphanIds++;

  let grpMin = Infinity, grpMax = -Infinity;
  for (let i = 0; i < B.length; i++) {
    const g = B[i].fadeGroup;
    if (g < grpMin) grpMin = g;
    if (g > grpMax) grpMax = g;
  }

  // ------------------------------------------------------------------
  // 问题 3：海上建筑
  // ------------------------------------------------------------------
  // 【不能只看 z < shorelineZ】
  // 建筑有进深，中心在岸线内侧 2 米、但进深 7 米的教堂，
  // 屋顶已经悬在海面上。判据用「盒子南缘」。
  const onWater = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    let minZ = t.z, maxZ = t.z, w = 2, d = 2;
    for (let k = 0; k < B.length; k++) {
      const b = B[k];
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      if (Math.hypot(cx - t.x, cz - t.z) < 3) {
        minZ = b.minZ; maxZ = b.maxZ;
        w = b.maxX - b.minX; d = b.maxZ - b.minZ;
        break;
      }
    }
    if (minZ < shoreZ) {
      onWater.push({ key: t.key, x: t.x, z: t.z, depth: shoreZ - minZ });
    }
  }

  // 街区地块：复算一遍网格，看哪些地块整体在水上
  const BLOCK = 20;
  let blockTotal = 0, blockInWater = 0;
  for (let gz = W.minZ + BLOCK; gz < W.maxZ; gz += BLOCK) {
    for (let gx = W.minX + BLOCK; gx < W.maxX; gx += BLOCK) {
      if (gz < 2) continue;
      blockTotal++;
      if (gz - BLOCK / 2 < shoreZ) blockInWater++;
    }
  }

  let meshesTotal2 = 0;
  if (scene) scene.traverse(o => { if (o.isMesh) meshesTotal2++; });

  return {
    scale: {
      tags: T.length, blockers: B.length, solid: solidBoxes.length,
      mergedMeshes: H.mergeStats ? H.mergeStats.after : -1,
      meshesWithAttr, attrIdMin: attrMin === Infinity ? 'none' : attrMin,
      attrIdMax: attrMax === -Infinity ? 'none' : attrMax,
      attrIdCount: seen.size,
    },
    collide: {
      tags: T.length, withSolid, missing, notSolid,
      missingSamples, notSolidSamples, devSamples,
      maxDeviation: maxDev, farCount,
    },
    fade: {
      meshesWithAttr, attrIdMin: attrMin === Infinity ? 'none' : attrMin,
      attrIdMax: attrMax === -Infinity ? 'none' : attrMax,
      grpMin: grpMin === Infinity ? 'none' : grpMin,
      grpMax: grpMax === -Infinity ? 'none' : grpMax,
      tagsWithoutGroup, tagsWithoutGroupSamples,
      orphanIds, zeroVertGroups: zeroVert,
      note: tagsWithoutGroup
        ? ('有 ' + tagsWithoutGroup + ' 栋的 fadeGroup 缺失 —— 这些房子永远不淡出')
        : '',
    },
    sea: {
      shoreZ, seaEdgeZ: shoreZ - seaSize / 2,
      onWater: onWater.length,
      onWaterSamples: onWater.slice(0, 10),
      blockTotal, blockInWater,
      note: onWater.length
        ? ('最深的压在水面下 ' + Math.max.apply(null, onWater.map(o => o.depth)).toFixed(1) + ' 米')
        : '',
    },
  };
}
"""


if __name__ == '__main__':
    sys.exit(main())