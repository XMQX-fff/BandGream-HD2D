"""确定重叠判据里两个轴到底该用什么量 —— 不猜，直接量

makeBuilding 的坐标是：
   px = axis='z' ? line + side*offset : cursor
   pz = axis='z' ? cursor            : line + side*offset

offset = fp.depth/2 + yard（perimeter 时 yard=0）→ **按进深**

而 finish() 登记的盒子是 (w + EAVE*2) × (d + EAVE*2)
其中 w 是面宽、d 是进深 —— 盒子是**w 宽 d 深**，与 offset 用的是同一个 d。

所以：
  · 沿街方向（cursor 推进方向）→ 该用**登记盒的宽 w** 参与去重
  · 垂直街道方向（offset 方向）  → 该用**登记盒的深 d** 参与去重

而 axis='z' 时：cursor 沿 Z（→ 需要盒的 Z 向尺寸 = d）
              offset 沿 X（→ 需要盒的 X 向尺寸 = w）
即：**去重的两个半宽要按 axis 交换**，不能都拿 REG_WIDTH/REG_DEPTH 硬套。

本脚本把每个被丢弃的位置实测出来，验证这个判断。
"""
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

    print('=== 去重判据的轴向核对 ===')
    print('最终建筑 %d 栋' % r['tags'])
    print('')
    print('--- 已生成建筑的登记盒尺寸（按类型）---')
    for s in r['boxByType']:
        print('  %-16s 盒 %.1f × %.1f   标签depth %.1f' % (s['key'], s['w'], s['d'], s['tag']))
    print('')
    print('--- 关键核对：offset 用的是 depth，盒子进深是不是 depth+余量 ---')
    print('  期望 盒进深 ≈ 标签 depth + 1.0（或带院独栋 +1.92）')
    for s in r['depthCheck']:
        print('    %-16s 标签 %.1f  盒 %.1f  差 %+.2f' % (s['key'], s['tag'], s['box'], s['delta']))
    print('')
    print('--- 相邻建筑的实际间距（同一地块同一边的连续两栋）---')
    print('  样本 %d组' % len(r['adjSamples']))
    for s in r['adjSamples'][:10]:
        print('    %-14s → %-14s 中心距 %.2f  前栋面宽 %.1f  净距 %+.2f'
              % (s['k1'], s['k2'], s['dist'], s['w1'], s['gap']))
    print('')
    print('--- 若改用「盒进深」推进，各边能排几栋 ---')
    print('  地块边长 28.0，盒进深均值 %.1f  → %d 栋'
          % (r['avgBoxDepth'], int(28.0 / (r['avgBoxDepth'] + 0.55))))
    print('  地块边长 28.0，盒面宽均值 %.1f  → %d 栋'
          % (r['avgBoxWidth'], int(28.0 / (r['avgBoxWidth'] + 0.55))))
    return 0


JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const B = H.blockers || [];

  // 每个建筑找它的盒
  const boxOf = (t) => {
    let best = null, bd = 2.0;
    for (const b of B) {
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const d = Math.hypot(cx - t.x, cz - t.z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  };

  const byType = {};
  for (const t of T) {
    const b = boxOf(t);
    if (!b) continue;
    const k = t.key;
    if (!byType[k]) byType[k] = { key: k, w: 0, d: 0, tag: 0, n: 0 };
    byType[k].w += (b.maxX - b.minX);
    byType[k].d += (b.maxZ - b.minZ);
    byType[k].tag += t.depth;
    byType[k].n++;
  }
  const boxByType = Object.values(byType).map(v => ({
    key: v.key, w: v.w / v.n, d: v.d / v.n, tag: v.tag / v.n,
  })).sort((a, c) => a.key < c.key ? -1 : 1);

  const depthCheck = boxByType.map(v => ({
    key: v.key, tag: v.tag, box: v.d, delta: v.d - v.tag,
  }));

  // 相邻两栋：沿同一列（X 接近）按 Z 排序
  const cols = new Map();
  for (const t of T) {
    if (t.zone !== 'perimeter') continue;
    const k = Math.round(t.x / 4) * 4;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(t);
  }
  const adjSamples = [];
  for (const arr of cols.values()) {
    arr.sort((a, c) => a.z - c.z);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], c = arr[i];
      const ab = boxOf(a);
      if (!ab) continue;
      adjSamples.push({
        k1: a.key, k2: c.key, dist: c.z - a.z,
        w1: ab.maxX - ab.minX,
        gap: (c.z - c.depth / 2) - (a.z + a.depth / 2),
      });
    }
  }

  let sw = 0, sd = 0, n = 0;
  for (const t of T) {
    const b = boxOf(t);
    if (!b) continue;
    sw += b.maxX - b.minX; sd += b.maxZ - b.minZ; n++;
  }

  return {
    tags: T.length, boxByType, depthCheck,
    adjSamples: adjSamples.slice(0, 12),
    avgBoxDepth: sd / n, avgBoxWidth: sw / n,
  };
}
"""

if __name__ == '__main__':
    sys.exit(main())