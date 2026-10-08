"""查盒子重叠的确切来源 —— 是同一栋登记了两次，还是两栋真盖在一起"""
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

    print('=== 盒子重叠溯源 ===')
    print('建筑标签 %d  solid 盒 %d' % (r['tags'], r['solids']))
    print('')
    print('--- solid 盒里有几个是「建筑」---')
    print('  能匹配到建筑标签的solid 盒: %d' % r['boxWithTag'])
    print('  匹配不到（喷泉/灯塔/树/栈桥等）: %d' % (r['solids'] - r['boxWithTag']))
    if r['unmatchedSamples']:
        print('  未匹配样本:')
        for s in r['unmatchedSamples'][:8]:
            print('    盒 @(%7.1f,%7.1f) %.1f×%.1f top=%.1f'
                  % (s['x'], s['z'], s['w'], s['d'], s['top']))
    print('')
    print('--- 完全重叠（同一位置两栋）---')
    print('  中心距 <1.5m 的建筑对: %d' % r['dupPairs'])
    for s in r['dupSamples'][:10]:
        print('    %-14s (%7.1f,%7.1f) zone=%-9s ↔ %-14s (%7.1f,%7.1f) zone=%-9s 中心距 %.2f'
              % (s['k1'], s['x1'], s['z1'], s['z1z'], s['k2'], s['x2'], s['z2'], s['z2z'], s['d']))
    print('')
    print('--- 部分重叠 >0.5m 的对 ---')
    print('  总对数 %d' % r['ovPairs'])
    print('  按重叠深度分布:')
    for k in ['<1', '1-2', '2-3', '3-5', '5+']:
        if k not in r['ovHist']:
            continue
        print('    重叠 %-5s 米: %d 对' % (k, r['ovHist'][k]))
    print('')
    print('--- 相邻沿街建筑的登记盒间距 ---')
    print('  沿街相邻两栋的盒面净距: min=%.2f 中位=%.2f（负数=重叠）'
          % (r['gapMin'], r['gapMed']))
    print('  样本:')
    for s in r['gapSamples'][:8]:
        print('    %-14s → %-14s 盒面净距 %+.2f'
              % (s['k1'], s['k2'], s['gap']))
    return 0


JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const B = H.blockers || [];
  const solids = B.filter(b => b.solid);

  // 给每个 solid 盒找最近的建筑标签
  const tagOf = (b) => {
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    let best = null, bd = 2.5;
    for (const t of T) {
      const d = Math.hypot(t.x - cx, t.z - cz);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  };
  let boxWithTag = 0;
  const unmatched = [];
  for (const b of solids) {
    const t = tagOf(b);
    if (t) boxWithTag++;
    else if (unmatched.length < 8) unmatched.push({
      x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2,
      w: b.maxX - b.minX, d: b.maxZ - b.minZ, top: b.top,
    });
  }

  // 完全重叠：两栋建筑中心距 < 1.5
  const dup = [];
  for (let i = 0; i < T.length; i++) {
    for (let j = i + 1; j < T.length; j++) {
      const d = Math.hypot(T[i].x - T[j].x, T[i].z - T[j].z);
      if (d < 1.5) dup.push({ k1: T[i].key, x1: T[i].x, z1: T[i].z, z1z: T[i].zone,
                              k2: T[j].key, x2: T[j].x, z2: T[j].z, z2z: T[j].zone, d });
    }
  }

  // 部分重叠
  const hist = {};
  let ovPairs = 0;
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i], c = solids[j];
      const ow = Math.min(a.maxX, c.maxX) - Math.max(a.minX, c.minX);
      const od = Math.min(a.maxZ, c.maxZ) - Math.max(a.minZ, c.minZ);
      if (ow > 0.5 && od > 0.5) {
        ovPairs++;
        const depth = Math.min(ow, od);
        const k = depth < 1 ? '<1' : depth < 2 ? '1-2' : depth < 3 ? '2-3' : depth < 5 ? '3-5' : '5+';
        hist[k] = (hist[k] || 0) + 1;
      }
    }
  }

  // 沿街相邻两栋的盒面净距：沿主街 x=40 两侧各取一列
  const west = T.filter(t => t.x < 40 && t.x > 20 && t.z > 10 && t.z < 230)
                .sort((a, b) => a.z - b.z);
  const gaps = [];
  for (let i = 1; i < west.length; i++) {
    const a = west[i - 1], c = west[i];
    // 找 a 的盒子
    let ab = null;
    for (const b of solids) {
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      if (Math.hypot(cx - a.x, cz - a.z) < 1.5) { ab = b; break; }
    }
    if (!ab) continue;
    gaps.push({ k1: a.key, k2: c.key, gap: (c.z - c.depth / 2) - (a.z + a.depth / 2) });
  }
  gaps.sort((x, y) => x.gap - y.gap);

  return {
    tags: T.length, solids: solids.length, boxWithTag,
    unmatchedSamples: unmatched,
    dupPairs: dup.length,
    dupSamples: dup.slice(0, 10),
    ovPairs, ovHist: hist,
    gapMin: gaps.length ? gaps[0].gap : 0,
    gapMed: gaps.length ? gaps[Math.floor(gaps.length / 2)].gap : 0,
    gapSamples: gaps.slice(0, 8),
  };
}
"""

if __name__ == '__main__':
    sys.exit(main())