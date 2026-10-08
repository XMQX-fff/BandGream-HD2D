"""动态碰撞实测 —— 静态数据说「都有盒子」，玩家说「能穿墙」

【为什么静态校验不够】
triage.py 确认 686/689 栋有 solid 盒、盒子与房子位置一致。
但那只证明「数据在」，证不了「碰撞逻辑生效」——
玩家反馈的是运行时行为，两者之间隔着：
  · resolveCollisions 每帧只推一次，贴墙时会不会漏
  · 角色半径 RADIUS=1.1 与盒子尺寸的关系
    （进深只有 2.0 的 shed，扣除登记余量后有效厚度可能小于直径 → 穿过去了）
  · 相邻两栋的盒子之间有没有缝

【测法：真的走进去撞】
不读内部状态，直接模拟玩家从各个方向走向房子中心，
看最终停在哪。若停点仍在盒内 → 那个方向可以直接穿过去。

运行：python3.11 tools/collide_walk.py
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
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('http://127.0.0.1:4173/', wait_until='load')
        pg.wait_for_function('window.__HD2D__ && window.__HD2D__.buildingTags', timeout=180000)
        pg.wait_for_timeout(2500)

        r = pg.evaluate(JS)
        b.close()

    print('=== 动态碰撞实测 ===')
    print('JS 错误 %d 条' % len(errs))
    print('测试样本 %d 栋（按进深分档抽样）' % r['tested'])
    print('')
    print('--- 四个方向撞墙结果 ---')
    print('  可穿过的方向总数%d' % r['totalPass'])
    print('  按建筑进深分档:')
    for k in ['0-2.5', '2.5-4', '4-6', '6+']:
        if k not in r['byDepth']:
            continue
        v = r['byDepth'][k]
        print('    进深 %-6s 样本 %-5d 穿墙 %-5d (%.0f%%)'
              % (k, v['n'], v['p'], 100.0 * v['p'] / v['n']))
    if r['passSamples']:
        print('')
        print('  穿墙样本:')
        for s in r['passSamples'][:12]:
            print('    %-14s @(%7.1f,%7.1f) 盒 %.1f×%.1f top=%.1f  方向 %s 最终(%6.1f,%6.1f) 仍在盒内=%s'
                  % (s['key'], s['x'], s['z'], s['w'], s['d'], s['top'],
                     s['dir'], s['fx'], s['fz'], s['stillIn']))
    print('')
    print('--- 最薄的盒子（穿墙高风险）---')
    for s in r['thinBoxes'][:10]:
        print('    %-14s @(%7.1f,%7.1f)  盒 %.2f × %.2f' % (s['key'], s['x'], s['z'], s['w'], s['d']))
    print('')
    print('--- 盒子重叠（两栋共用一片空间 → 互相顶开）---')
    print('  重叠对数 %d' % r['overlapPairs'])
    for s in r['overlapSamples'][:6]:
        print('    %-14s(%7.1f,%7.1f) 与 %-14s(%7.1f,%7.1f) 重叠 %.1f×%.1f'
              % (s['k1'], s['x1'], s['z1'], s['k2'], s['x2'], s['z2'], s['ow'], s['od']))

    bad = []
    if r['totalPass']:
        bad.append('可穿墙方向 %d 个' % r['totalPass'])
    if errs:
        bad.append('JS 错误 %d' % len(errs))
    print('')
    if bad:
        for x in bad:
            print('  x ' + x)
        return 1
    print('  全部房子四面都撞得住。')
    return 0


JS = r"""
() => {
  const H = window.__HD2D__;
  const T = H.buildingTags || [];
  const B = H.blockers || [];

  const STEP = 0.25;   // 模拟步长
  const MAX_T = 40;    // 最多走 40 步 = 10 单位

  // 为每栋建筑找到它的 solid 盒
  const boxOf = new Map();
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    for (let k = 0; k < B.length; k++) {
      const b = B[k];
      if (!b.solid) continue;
      if (t.x > b.minX - 1.5 && t.x < b.maxX + 1.5 &&
          t.z > b.minZ - 1.5 && t.z < b.maxZ + 1.5) {
        if (!boxOf.has(i)) boxOf.set(i, b);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------
  //  【直接调用真实的 resolveCollisions，不在脚本里复刻】
  // ---------------------------------------------------------------------
  // 旧版本在这里手抄了一份 resolveCollisions，注释还写着
  // 「必须一模一样，否则测出来的不是线上行为」。
  //
  // 但「一模一样」靠人眼维持：本轮给实现加了「迭代 3 轮」之后，
  // 脚本里那份仍是旧的单轮版 —— 于是**实现里修好的东西，测试测不出来**。
  //
  // 症状极具欺骗性：代码改了、构建成功、测试仍报「穿墙 1」，
  // 于是合理地怀疑「迭代没用」，又去调一个已经调对的东西。
  //
  // 教训与「诊断脚本复算生成参数」完全相同，只是方向相反：
  //   脚本比实现新 → 测的是没实现的逻辑
  //   脚本比实现旧 → 测不出已实现的修复
  // 两种都会报出「看着像真实数据的假结论」。
  //
  // 现在改为调用 character.js 暴露的 probeCollide：
  // 它跑的就是线上那份 solve，脚本只负责摆放与判定。
  const hero = H.hero;
  const R = hero.RADIUS;
  const probe = (s) => hero.probeCollide(s);

  const solids = B.filter(b => b.solid);

  // 分档抽样：进深决定盒子厚度，是穿墙的主要风险因子
  const buckets = { '0-2.5': [], '2.5-4': [], '4-6': [], '6+': [] };
  for (const [i, t] of T.entries()) {
    if (!boxOf.has(i)) continue;
    const b = boxOf.get(i);
    const d = Math.min(b.maxX - b.minX, b.maxZ - b.minZ);
    const k = d < 2.5 ? '0-2.5' : d < 4 ? '2.5-4' : d < 6 ? '4-6' : '6+';
    buckets[k].push({ t, b, i });
  }

  const DIRS = [['+X', 1, 0], ['-X', -1, 0], ['+Z', 0, 1], ['-Z', 0, -1]];
  const byDepth = {}, passSamples = [];
  let tested = 0, totalPass = 0;

  for (const k of Object.keys(buckets)) {
    const arr = buckets[k];
    // 每档最多测 40 栋，全测太慢
    const stepN = Math.max(1, Math.ceil(arr.length / 40));
    for (let n = 0; n < arr.length; n += stepN) {
      const { t, b } = arr[n];
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      for (const [name, ux, uz] of DIRS) {
        // 从房子外 8 单位处，沿方向走向中心
        const s = { x: cx - ux * 8, z: cz - uz * 8 };
        // 先把起点推出所有碰撞（与 teleport 一致）
        probe(s);
        let steps = 0;
        for (; steps < MAX_T; steps++) {
          const px = s.x, pz = s.z;
          s.x += ux * STEP; s.z += uz * STEP;
          probe(s);
          if (Math.hypot(s.x - px, s.z - pz) < 1e-9) break;   // 卡住 = 撞住了
        }
        // 判定：停点是否仍在盒内（含角色半径容差）
        const stillIn = s.x > b.minX - R * 0.5 && s.x < b.maxX + R * 0.5 &&
                        s.z > b.minZ - R * 0.5 && s.z < b.maxZ + R * 0.5;
        tested++;
        if (!byDepth[k]) byDepth[k] = { n: 0, p: 0 };
        byDepth[k].n++;
        if (stillIn) {
          byDepth[k].p++;
          totalPass++;
          if (passSamples.length < 12) {
            passSamples.push({
              key: t.key, x: t.x, z: t.z,
              w: b.maxX - b.minX, d: b.maxZ - b.minZ, top: b.top,
              dir: name, fx: s.x, fz: s.z, stillIn: true,
            });
          }
        }
      }
    }
  }

  // 最薄的盒子
  const thin = [];
  for (const [i, t] of T.entries()) {
    if (!boxOf.has(i)) continue;
    const b = boxOf.get(i);
    thin.push({ key: t.key, x: t.x, z: t.z, w: b.maxX - b.minX, d: b.maxZ - b.minZ });
  }
  thin.sort((a, c) => Math.min(a.w, a.d) - Math.min(c.w, c.d));

  // 盒子重叠：两栋的盒互相压住 → 碰撞求解时两栋同时推，角色被弹来弹去
  const sb = solids.slice();
  let pairs = 0; const ovSamples = [];
  for (let i = 0; i < sb.length && pairs < 400; i++) {
    for (let j = i + 1; j < sb.length; j++) {
      const a = sb[i], c = sb[j];
      const ow = Math.min(a.maxX, c.maxX) - Math.max(a.minX, c.minX);
      const od = Math.min(a.maxZ, c.maxZ) - Math.max(a.minZ, c.minZ);
      if (ow > 0.5 && od > 0.5) {
        pairs++;
        if (ovSamples.length < 6) {
          const ta = T.find(t => Math.abs(t.x - (a.minX + a.maxX) / 2) < 1.5 &&
                                 Math.abs(t.z - (a.minZ + a.maxZ) / 2) < 1.5);
          const tc = T.find(t => Math.abs(t.x - (c.minX + c.maxX) / 2) < 1.5 &&
                                 Math.abs(t.z - (c.minZ + c.maxZ) / 2) < 1.5);
          ovSamples.push({ k1: ta ? ta.key : '?', x1: (a.minX + a.maxX) / 2, z1: (a.minZ + a.maxZ) / 2,
                           k2: tc ? tc.key : '?', x2: (c.minX + c.maxX) / 2, z2: (c.minZ + c.maxZ) / 2,
                           ow, od });
        }
      }
    }
  }

  return {
    tested, totalPass, byDepth, passSamples,
    thinBoxes: thin.slice(0, 10),
    overlapPairs: pairs, overlapSamples: ovSamples,
  };
}
"""

if __name__ == '__main__':
    sys.exit(main())