"""为什么房子越来越少 —— 直接读实现里的丢弃计数

【为什么这个脚本不再自己复算】
上一版它在 Python 里重建了一遍生成逻辑（inset 硬编码 3.0、
排除带硬编码 30、边长硬编码 28）。代码改了内缩算法之后，
脚本还在按旧值算 —— 于是报出「丢弃 79%」这种
看起来像真实数据、实际是脚本自己算错的数字。

排查时我据此又改了 BLOCK 和内缩，房子从 374 掉到 167，
两次都是**被一个算错的诊断脚本带偏的**。

「诊断与实现各写一份」是最难查的一类错：
两边看起来都在认真工作，数字却对不上，
而且没有任何一方会报错。

所以现在改成：实现里丢弃时记原因（city.js 的 traceDrop），
脚本只读 `window.__GEN_DROP__`，一个参数都不复算。
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
        # 必须在页面脚本执行**之前**打开追踪，
        # 否则 createOutskirts 已经跑完，计数窗口就过了。
        pg.add_init_script('window.__GEN_TRACE__ = true;')
        pg.goto('http://127.0.0.1:4173/', wait_until='load')
        pg.wait_for_function('window.__HD2D__ && window.__HD2D__.buildingTags',
                             timeout=180000)
        pg.wait_for_timeout(2000)
        r = pg.evaluate(JS)
        b.close()

    d = r['drop']
    print('=== 生成漏斗（直接读实现计数）===')
    if not d:
        print('  没拿到 __GEN_DROP__ —— 追踪开关没生效')
        return 1
    total = max(1, d['kept'] + d['oob'] + d['dup'])
    print('  尝试 %d 次' % total)
    print('    成功生成 %d' % d['kept'])
    print('    越界丢弃 %d (%.0f%%)' % (d['oob'], 100.0 * d['oob'] / total))
    print('    重叠丢弃 %d (%.0f%%)  <<<' % (d['dup'], 100.0 * d['dup'] / total))
    print('')
    print('  重叠丢弃按 zone:')
    for z, n in sorted(d['dupByZone'].items(), key=lambda kv: -kv[1]):
        print('    %-12s %d' % (z, n))
    print('')
    print('  最终建筑标签 %d 栋' % r['tags'])
    for z, n in sorted(r['byZone'].items(), key=lambda kv: -kv[1]):
        print('    %-12s %d' % (z, n))
    print('')

    # 院内填充单独一段 —— 它的失败不落在 oob/dup 里
    ys, yt = d.get('yardSkip', 0), d.get('yardTry', 0)
    print('=== 院内填充（第三种失败：没走到 make 就被跳过）===')
    print('  因净空不足直接跳过 %d 个地块' % ys)
    print('  实际尝试 %d 次，成 %d 栋'
          % (yt, r['byZone'].get('yard', 0)))
    print('')
    print('--- 现存建筑最密的位置（判断是否仍有互撞残留）---')
    print('  %s' % r['hotspot'])
    for s in r['hotSamples'][:8]:
        print('    %-14s @(%7.1f,%7.1f)  %s' % (s['key'], s['x'], s['z'], s['zone']))
    return 0


JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const byZone = {};
  for (const t of T) byZone[t.zone] = (byZone[t.zone] || 0) + 1;
  const drop = window.__GEN_DROP__ || null;

  // 现存建筑最密的 20 米网格 —— 若仍有互撞残留，这里会看到贴得极近的一堆
  const cells = new Map();
  for (const t of T) {
    const k = Math.floor(t.x / 20) + ',' + Math.floor(t.z / 20);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(t);
  }
  let hotKey = null, hotN = 0;
  for (const [k, arr] of cells) {
    if (arr.length > hotN) { hotN = arr.length; hotKey = k; }
  }
  const hotSamples = [];
  if (hotKey) {
    const arr = cells.get(hotKey);
    for (let i = 0; i < Math.min(arr.length, 8); i++) {
      hotSamples.push({ x: arr[i].x, z: arr[i].z, key: arr[i].key, zone: arr[i].zone });
    }
  }

  return {
    drop, tags: T.length, byZone,
    hotspot: hotKey ? ('网格 %s 内 %d 栋' % (hotKey, hotN)) : '无',
    hotSamples,
  };
}
"""

if __name__ == '__main__':
    sys.exit(main())