"""定位负 Z 建筑的来源 —— 城区生成器全部夹在 B.minZ=-2 之后，
负Z 建筑必然来自别处。先查清是谁生成的，再决定怎么修。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(headless=False, args=[
            '--no-sandbox', '--disable-setuid-sandbox',
            '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--window-size=1280,760'])
        pg = b.new_page(viewport={'width': 1280, 'height': 760})
        pg.goto('http://127.0.0.1:4173/', wait_until='load')
        pg.wait_for_function('window.__HD2D__ && window.__HD2D__.buildingTags', timeout=180000)
        pg.wait_for_timeout(2500)
        r = pg.evaluate(JS)
        b.close()

    print('=== 负 Z 建筑溯源 ===')
    print('WORLD.bounds %s' % r['bounds'])
    print('建筑标签 %d，其中 z < -2 的 %d 栋' % (r['total'], r['negCount']))
    print('')
    print('按 zone 分布:')
    for z, n in sorted(r['byZone'].items(), key=lambda kv: -kv[1]):
        print('  %-12s %d' % (z, n))
    print('')
    print('按类型分布:')
    for k, n in sorted(r['byKey'].items(), key=lambda kv: -kv[1]):
        print('  %-16s %d' % (k, n))
    print('')
    print('Z 范围: %.1f .. %.1f' % (r['zMin'], r['zMax']))
    print('前 12 栋负 Z 建筑:')
    for t in r['samples']:
        print('  %-16s (%7.1f,%8.1f)  zone=%-10s depth=%.1f'
              % (t['key'], t['x'], t['z'], t['zone'], t['depth']))

    print('')
    print('=== 场景里的顶层 Group ===')
    for g in r['groups']:
        print('  %-22s children=%d' % (g['name'], g['count']))

    print('')
    print('=== 盒子偏差 >1m 的样本 ===')
    for s in r['devSamples']:
        print('  %-16s tag(%7.1f,%7.1f) box(%7.1f,%7.1f) 偏差 %.2f'
              % (s['key'], s['tx'], s['tz'], s['bx'], s['bz'], s['dev']))
    print('')
    print('负Z 建筑对应的盒子 solid 情况: %s' % r['negBoxSolid'])
    return 0


JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const B = H.blockers || [];
  const W = H.worldBounds;

  const neg = T.filter(t => t.z < -2);
  const byZone = {}, byKey = {};
  let zMin = Infinity, zMax = -Infinity;
  for (const t of T) {
    if (t.z < zMin) zMin = t.z;
    if (t.z > zMax) zMax = t.z;
    if (t.z < -2) {
      byZone[t.zone] = (byZone[t.zone] || 0) + 1;
      byKey[t.key] = (byKey[t.key] || 0) + 1;
    }
  }

  // 负Z 建筑是否真的有 solid 盒（玩家是撞到还是穿过去）
  let negSolid = 0, negNone = 0;
  for (const t of neg) {
    let hit = false;
    for (const b of B) {
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      if (Math.hypot(cx - t.x, cz - t.z) < 2 && b.solid) { hit = true; break; }
    }
    if (hit) negSolid++; else negNone++;
  }

  // 偏差样本：盒子中心离标签中心 >1m
  const devSamples = [];
  for (const t of T) {
    let bd = Infinity, box = null;
    for (const b of B) {
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const d = Math.hypot(cx - t.x, cz - t.z);
      if (d < bd) { bd = d; box = b; }
    }
    if (bd > 1 && devSamples.length < 10 && t.z > -2) {
      devSamples.push({ key: t.key, tx: t.x, tz: t.z,
        bx: (box.minX + box.maxX) / 2, bz: (box.minZ + box.maxZ) / 2, dev: bd });
    }
  }

  // 场景顶层结构：找负Z 建筑挂在哪个 Group 下
  const groups = [];
  if (H.scene) {
    for (const c of H.scene.children) {
      groups.push({ name: c.name || c.type, count: c.children.length });
    }
  }

  return {
    bounds: W, total: T.length, negCount: neg.length,
    byZone, byKey, zMin, zMax,
    samples: neg.slice(0, 12).map(t => ({ key: t.key, x: t.x, z: t.z, zone: t.zone, depth: t.depth })),
    groups,
    devSamples,
    negBoxSolid: 'solid=' + negSolid + ' 无solid=' + negNone,
  };
}
"""

if __name__ == '__main__':
    sys.exit(main())