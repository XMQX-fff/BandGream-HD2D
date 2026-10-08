"""院子的真实净空 —— 只量，不复算

【为什么这个脚本不该长】
本轮我已经栽了两次跟头，两次都是同一个原因：
**诊断脚本在 Python/JS 里重建了一遍生成逻辑**。

  · trace_funnel.py 早期版本硬编码 inset=3.0 / 排除带=30 / 边长=28，
    代码改��算法后脚本还在按旧值算 → 报出「丢弃 79%」这种假数字，
    我据此改了两次参数，房子从 374 掉到 167。
  · 本脚本第一版没排除主街/横街，把沿街房子当成了院墙，
    于是报出「净空中位 0.00」—— 也是假数字。

所以这里的规则只有一条：**一个参数都不许复算**。
生成侧已经把计数放进实现本身（city.js 的 traceDrop → window.__GEN_DROP__），
本脚本只负责「量已经生成的东西」，以及打印实现侧报上来的数。

它量的是：每个地块中心到最近登记盒边缘的距离，
按 zone 分组 —— 因为「围合墙有多厚」和「院子能不能塞下东西」
是两个不同的问题，混在一起平均就会得到没有意义的数。
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
        pg.add_init_script('window.__GEN_TRACE__ = true;')
        pg.goto('http://127.0.0.1:4173/', wait_until='load')
        pg.wait_for_function('window.__HD2D__ && window.__HD2D__.buildingTags',
                             timeout=180000)
        pg.wait_for_timeout(2000)
        r = pg.evaluate(JS)
        b.close()

    d = r['drop']
    total = d['kept'] + d['oob'] + d['dup']

    print('=== 实现侧报上来的生成计数（不重算）===')
    print('  尝试 %d 次' % total)
    print('    成功 %d' % d['kept'])
    print('    越界丢弃 %d (%.0f%%)' % (d['oob'], 100.0 * d['oob'] / max(1, total)))
    print('    重叠丢弃 %d (%.0f%%)' % (d['dup'], 100.0 * d['dup'] / max(1, total)))
    print('')

    print('=== 按 zone 统计（从 buildingTags 读，不推断）===')
    print('  %-12s %6s %8s %8s %8s' % ('zone', '栋数', '面宽中位', '进深中位', '盒对角'))
    for z, v in sorted(r['zones'].items()):
        print('  %-12s %6d %8.2f %8.2f %8.2f'
              % (z, v['n'], v['w50'], v['d50'], v['diag50']))
    print('')

    print('=== 院子净空（中心 → 最近登记盒边缘，按最近的 zone 归类）===')
    print('  采样地块 %d 个（只统计四面都有围合的地块）' % r['enclosed'])
    print('')
    print('  %-12s %5s %8s %8s %8s %8s' %
          ('最近者', '样本', '净空min', 'p25', '中位', 'max'))
    for z, v in sorted(r['clear'].items()):
        print('  %-12s %5d %8.2f %8.2f %8.2f %8.2f'
              % (z, v['n'], v['min'], v['p25'], v['p50'], v['max']))
    print('')

    print('=== 判定 ===')
    need_w = r['yardW'] + 1.0     # 两栋并排：各自面宽 + 1 米缝
    need_d = r['yardD'] + 1.0
    print('  院内小体量登记盒 %.2f × %.2f' % (r['yardW'], r['yardD']))
    print('  两栋并排需要 X %.2f  Z %.2f' % (need_w, need_d))
    print('')
    ok = 0
    for z, v in sorted(r['clear'].items()):
        if z == 'yard':
            continue
        fitX = v['p50'] >= need_w
        fitZ = v['p50'] >= need_d
        verdict = '放得下' if (fitX and fitZ) else (
            'X 不够' if not fitX else 'Z 不够')
        print('  %-12s 中位净空 %.2f → %s' % (z, v['p50'], verdict))
        if fitX and fitZ:
            ok += 1
    print('')
    print('  可填的地块类别：%d 种' % ok)
    if ok == 0:
        print('  → 院子确实放不下，两栋小体量都嫌挤')
        print('    这时正确的做法不是硬塞，而是**放弃院内填充**，')
        print('    改用「把 BLOCK 放大」或「让 dense 少排一边」来换院子。')
    print('')

    print('=== 盒子重叠现状（按 zone 对）===')
    ov = r['overlap']
    print('  重叠对总数 %d' % ov['total'])
    for k, n in sorted(ov['byPair'].items(), key=lambda kv: -kv[1])[:10]:
        print('    %-22s %d' % (k, n))
    return 0


JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const B = H.blockers || [];
  const BLOCK = 30;
  const W = H.worldBounds;

  // ---- 按 zone 统计登记盒尺寸 -------------------------------------------
  // 用 tag 的 (x,z) 反查盒子中心来配对 —— 这是上一轮修好的口径，
  // 盒子登记在正确的位置上，配对阈值 1.5 米足够。
  const boxes = [];
  for (const t of T) {
    for (const b of B) {
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.minZ) / 2;
      const cz2 = (b.minZ + b.maxZ) / 2;
      if (Math.hypot(cx - t.x, cz2 - t.z) < 1.5) {
        boxes.push({ x: cx, z: cz2, w: b.maxX - b.minX, d: b.maxZ - b.minZ,
                     zone: t.zone || 'unknown', key: t.key });
        break;
      }
    }
  }

  const pct = (a, q) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
  };

  // ---- 按 zone 汇总 -----------------------------------------------------
  const zones = {};
  for (const b of boxes) {
    const z = zones[b.zone] || (zones[b.zone] = { ws: [], ds: [], dg: [] });
    z.ws.push(b.w); z.ds.push(b.d); z.dg.push(Math.hypot(b.w, b.d));
  }
  const zout = {};
  for (const k of Object.keys(zones)) {
    const v = zones[k];
    zout[k] = { n: v.ws.length, w50: pct(v.ws, 0.5), d50: pct(v.ds, 0.5),
                diag50: pct(v.dg, 0.5) };
  }

  // ---- 院子净空：只统计「四面都有围合」的地块 ----------------------------
  // 判据用**最近的那个盒子属于哪个 zone** 来归类，
  // 这样 civic（只排一边）与 dense（四边）不会被平均掉。
  const grid = [];
  for (let gz = W.minZ + BLOCK; gz < W.maxZ; gz += BLOCK) {
    for (let gx = W.minX + BLOCK; gx < W.maxX; gx += BLOCK) {
      if (gz < 2) continue;
      grid.push([gx, gz]);
    }
  }

  const clear = {};
  let enclosed = 0;
  for (const [gx, gz] of grid) {
    // 本地块范围内的盒子
    const own = boxes.filter(b =>
      Math.abs(b.x - gx) < BLOCK / 2 + 2 && Math.abs(b.z - gz) < BLOCK / 2 + 2);
    if (own.length < 3) continue;

    let best = Infinity, bestZone = null;
    for (const b of own) {
      // -----------------------------------------------------------------
      //  按「主方向」取净空 —— 这里曾写成
      //    max(|dx| - w/2, |dz| - d/2)
      //  那算的是「到盒子最近的那个角」，不是「到最近的那面墙」。
      //  四面围合时两者差别很大：沿边排布的房子横向宽、纵向薄，
      //  max() 会取到横向那一项（-w/2 常为负）→ 净空系统性偏小。
      //
      //  与 city.js 的判据保持一致：离中心更远的那根轴才作数。
      // -----------------------------------------------------------------
      const dx = Math.abs(b.x - gx), dz = Math.abs(b.z - gz);
      const gap = (dx >= dz) ? (dx - b.w / 2) : (dz - b.d / 2);
      if (gap < best) { best = gap; bestZone = b.zone; }
    }
    if (!bestZone || best === Infinity) continue;
    // 院子自己的房子不算「墙」
    if (bestZone === 'yard') continue;
    enclosed++;
    const c = clear[bestZone] || (clear[bestZone] = { v: [] });
    c.v.push(Math.max(0, best));
  }
  const cout = {};
  for (const k of Object.keys(clear)) {
    const v = clear[k].v;
    cout[k] = { n: v.length, min: Math.min(...v), p25: pct(v, 0.25),
                p50: pct(v, 0.5), max: Math.max(...v) };
  }

  // ---- 院内小体量的登记盒 ------------------------------------------------
  const yardB = boxes.find(b => b.zone === 'yard');
  const fallback = boxes.find(b => b.key === 'shed') || boxes.find(b => b.zone === 'perimeter');

  // ---- 盒子重叠：按 zone 对归类 -------------------------------------------
  let total = 0;
  const byPair = {};
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = (a.w + b.w) / 2 - Math.abs(a.x - b.x);
      const oz = (a.d + b.d) / 2 - Math.abs(a.z - b.z);
      if (ox > 0 && oz > 0) {
        total++;
        const key = [a.zone, b.zone].sort().join('↔');
        byPair[key] = (byPair[key] || 0) + 1;
      }
    }
  }

  return {
    drop: window.__GEN_DROP__ || { kept: 0, oob: 0, dup: 0 },
    zones: zout,
    clear: cout,
    enclosed,
    yardW: yardB ? yardB.w : (fallback ? fallback.w : 4),
    yardD: yardB ? yardB.d : (fallback ? fallback.d : 3),
    overlap: { total, byPair },
  };
}
"""

if __name__ == '__main__':
    sys.exit(main())
