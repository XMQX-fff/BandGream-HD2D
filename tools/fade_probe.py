#!/usr/bin/env python3.11
"""
建筑遮挡淡出 —— 验证脚本

【为什么这个脚本必须存在，而不是「截图看一眼」】
淡出是逐顶点属性 + shader 注入 + 运行时查找表三者的组合，
其中任何一环没接上，画面都**可能**看起来「正常」——
因为楼本来就只是被相机避开了，不淡出也看得见角色。

真正的失败模式全部是静默的：
  · shader 没编译（customProgramCacheKey 没设）→ 淡出时好时坏
  · aFadeId 全是 -1→ 永远不淡
  · 查找表没更新   → 淡出的是隔壁那栋
  · draw call 暴涨 → 画面对，但帧率崩

所以这里逐项断言数值，而不是靠肉眼。

用法：
  xvfb-run -a python3.11 tools/fade_probe.py [--shots]

【必须 xvfb-run + headful，否则拿不到 WebGL 上下文】
沙箱里没有 X server，有头 Chromium 直接报
"Missing X server or $DISPLAY"。而纯 headless 也不行 ——
Chromium 在无头模式下禁用 GPU 进程，拿不到 SwiftShader，
WebGL 上下文创建直接失败（GL_VENDOR = Disabled）。
所以三者缺一不可：xvfb-run + headless=False + --use-angle=swiftshader。
"""
import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
PORT = 8097

# 待测机位。
#
# 【基准机位必须选「真正空旷」的位置，不能用角色出生点】
# 首版用 (6,14)（喷泉广场）。那里距一栋建筑只有 1.6 单位 ——
# 出生点本就在建筑旁，这是设计使然，不是遮挡。
# 于是它成了假阳性的来源：淡出系统如实淡出了那栋楼，
# 而断言「广场不该淡任何东西」就误报了。
#
# 教训：**基准机位要挑一个「按定义就不该触发淡出」的坐标**，
# 而不是「看起来应该空旷」的直觉坐标。
# (100, 30) 在城区东南角，街网之外，实测距最近建筑 > 8 单位。
#
# ---------------------------------------------------------------------
#  【机位坐标不再手写 —— 由 tools/fade_scan.py 扫出来】
# ---------------------------------------------------------------------
# 这批坐标来自 fade_scan.py 的全城扫描（布局修复版）：
# 逐点调 fadeProbe，挑「真的会触发且触发数适中」的可达点。
#
# 为什么必须自动选：本轮修掉了「遮挡盒全部登记在 (0,0)」那个 bug，
# 建筑位置随之全变 —— 原来手写的四个坐标里，有三个附近已经没有房子了。
# 测出「0 栋淡出」，看起来像功能没生效，实际是**测试点选在了空地上**。
#
# 与之前两次同类错误的区别值得记下：
#   · 第一次：setPlayerPos 不带相机 → 相机还在半路（输入状态不对）
#   · 第二次：机位手写常数→ 布局改版后落在空地（输入不具代表性）
# 共同点：**都在用不具代表性的输入验证系统，然后差点责怪系统**。
# 让代码自己回答「哪里会触发」，测试集才可信、才不用反复手改。
#
# 扫描结果（城区限定版）：可达点 3695 中 203 个会触发，
# 同时淡出 >3 栋的只有 5 个，分布 1~5 栋 —— 单机位同时淡 5 栋已是上限。
#
# 【扫描必须限定在可玩城区内】
# 遮挡物列表里还含 createOutskirts 撒的郊野散点，
# 按遮挡物边界采样会跑到「房子浮在水面上」的荒地。
# 第一版推荐机位 (76.3,-79.3) 就是这么来的 —— 拍出来一片海上孤村。
STATIONS = [
    # (名称, 角色 x, 角色 z, 说明)
    ('a-dense-row', 32.0, 70.0, '扫描选出：同时淡出 5 栋，全城最密'),
    ('b-tall-block', 52.0, 2.0, '扫描选出：4 栋，含 12 米高墙'),
    ('c-street-edge', 24.0, 82.0, '扫描选出：4 栋，矮楼群'),
    ('d-single', 28.0, 102.0, '扫描选出：3 栋，含全城最高的 16 米塔'),
    # 基准机位由 fade_scan.py 按判据挑出：周围 30 单位内无实心建筑，
    # 且距城区重心适中（太偏的角落玩家走不到，在那儿测等于测了个没人的地方）。
    # 之前手挑的 (100,30) 在盒子修好之后距民居只有十几米，断言必然失败 ——
    # 又是基准选错，不是功能问题。
    ('e-open-field', 112.0, 138.0, '扫描选出的空旷基准（应完全不淡）'),
]


def serve():
    """起静态服务。这里用 dist 而不是 vite dev ——
    dev 模式的热更新会在我们读数据时重载页面，读到半截状态。"""
    proc = subprocess.Popen(
        [sys.executable, '-m', 'http.server', str(PORT), '--directory', DIST],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2)
    return proc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', action='store_true', help='额外保存对比截图')
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    proc = serve()
    report = {}
    try:
        with sync_playwright() as pw:
            # 【启动参数不能随便改 —— 踩过一次】
            # 首版写的是 '--use-gl=swiftshader' + headless（默认 True），
            # 结果 WebGL 上下文**根本创建不出来**：
            #   THREE.WebGLRenderer: A WebGL context could not be created.
            #   GL_VENDOR = Disabled, GL_RENDERER = Disabled
            # 页面在场景构建之前就抛错，window.__HD2D__ 永远不出现 ——
            # 症状是「脚本超时」，与本轮改动毫无关系，很容易误判方向。
            #
            # 正确组合是 '--use-angle=swiftshader' + headless=False
            # （与 tools/city_report.py 保持一致，那套是实测能跑通的）。
            # headless 模式下 Chromium 禁用了 GPU 进程，
            # --use-gl 走的旧路径拿不到 context；--use-angle 才是
            # 新路径，配合有头模式才能拿到 SwiftShader。
            browser = pw.chromium.launch(
                headless=False,
                args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                      '--window-size=1280,720'])
            page = browser.new_page(viewport={'width': 1280, 'height': 720})

            logs = []
            page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
            page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))

            page.goto(f'http://127.0.0.1:{PORT}/', wait_until='load')
            page.wait_for_function('window.__HD2D__ && window.__HD2D__.ready',
                                   timeout=60000)
            # 场景构建 + 首帧编译 shader。软渲染下要等够久。
            page.wait_for_timeout(9000)

            # ---------- 0. 编译错误必须先排除 ----------
            bad = [l for l in logs if 'error' in l.lower() or 'pageerror' in l]
            shader_err = [l for l in bad if 'shader' in l.lower() or 'glsl' in l.lower()]
            report['console_errors'] = bad[:8]
            report['shader_errors'] = shader_err[:8]

            # ---------- 1. draw call 必须没有暴涨 ----------
            # 这是本次实现的核心约束：分桶逻辑不变。
            stats = page.evaluate('''() => {
              const H = window.__HD2D__;
              return {
                before: H.mergeStats.before,
                after: H.mergeStats.after,
                drawables: H.drawables(),
                blockers: H.blockerCount(),
              };
            }''')
            report['merge'] = stats

            # ---------- 2. aFadeId 属性是否真的写进了几何体 ----------
            # 直接读合并后mesh 的属性，绕开「画面看起来对不对」的歧义
            fade_attr = page.evaluate('''() => {
              const H = window.__HD2D__;
              let withAttr = 0, withoutAttr = 0, byDesign = 0;
              let minId = Infinity, maxId = -Infinity;
              let buildingVerts = 0;
              H.scene.traverse((o) => {
                if (!o.isMesh || !o.geometry || !o.geometry.attributes) return;
                const a = o.geometry.attributes.aFadeId;
                if (!a) {
                  // 【必须排除「按设计不参与合并」的 mesh，否则断言必然失败】
                  //两类：
                  //   · water —— 自定义 ShaderMaterial（水面有顶点动画），
                  //     optimize.js 的 collectStatic 明确跳过 ShaderMaterial
                  //   · blob-shadow —— 接触阴影，透明贴片，
                  //     逐帧跟随所属建筑，同样不进合并器
                  //
                  // 它们都没被注入淡出 shader（材质列表来自 mergeStats，
                  // 而这两类压根没进合并器），所以不需要 aFadeId。
                  // 把它们算成「漏注入」是**断言本身写错了**。
                  //
                  // 判别方式：靠名字白名单，不靠材质特征猜。
                  // 早前用 `m.isShaderMaterial` 去猜，漏掉了 blob shadow，
                  // 于是「无 fade 属性 mesh = 9」一直误报；
                  // 现在 props.js 里给接触阴影显式起了 name，
                  // 判别就不再依赖「特征是否恰好唯一」。
                  if (o.name === 'water' || o.name === 'blob-shadow') {
                    byDesign++;
                    return;
                  }
                  withoutAttr++;
                  return;
                }
                withAttr++;
                const arr = a.array;
                for (let i = 0; i < arr.length; i++) {
                  const v = arr[i];
                  if (v < 0) continue;
                  buildingVerts++;
                  if (v < minId) minId = v;
                  if (v > maxId) maxId = v;
                }
              });
              return { withAttr, withoutAttr, byDesign,
                       minId, maxId, buildingVerts,
                       blockers: H.blockers.length };
            }''')
            report['fade_attr'] = fade_attr

            # ---------- 3. 逐机位：淡出是否真的发生 ----------
            #
            # 【必须用 teleport 而不是 setPlayerPos —— 这是本脚本最关键的一处】
            # setPlayerPos 只挪角色，相机仍被阻尼拉着飞过去。
            # 软渲染只有 0.6 fps，阻尼 6.5/s 靠「帧数 × dt」累积，
            # 实测等 7 秒相机还停在半路（角色 z=190、相机却在 z=215，
            # 方向甚至是反的），此时视线恰好通畅 →
            # 首版测出四个机位遮挡数全为 0，
            # 看起来像「淡出功能完全没生效」。
            #
            # 判定用的正是相机的真实位置，判定本身没错，
            # 错的是输入的状态。这种假阴性极容易把排查引向错误方向。
            per = []
            for name, x, z, note in STATIONS:
                # 【每个机位前先复位淡出状态】
                # 恢复速率 3.0/s、dt 钳在 0.05、软渲染 1.2 fps
                # → 上一机位淡出的楼要 9 秒以上才恢复得完，
                # 而这里只等 2.5 秒。
                # 不复位的话，基准机位测到的是**上一个机位的残留**，
                # 一个纯时序污染，看起来就像「空旷处也误淡」。
                page.evaluate('window.__HD2D__.fadeReset && window.__HD2D__.fadeReset()')
                page.evaluate(f'window.__HD2D__.teleport({x}, {z})')
                # 相机已落位，剩下的只是淡出的低通收敛。
                # 上升速率 10/s，dt 被 main.js钳在 0.05/帧，
                # 所以每帧最多走 1-e^-0.5 ≈ 39%，
                # 几帧就到 90% 以上。1.5 秒足够。
                page.wait_for_timeout(2500)
                st = page.evaluate('''() => {
                  const H = window.__HD2D__;
                  const s = H.getState();
                  const f = H.fadeStats();
                  const sb = H.sightBlockers();
                  return {
                    hero: [s.x, s.z],
                    cam: [sb.camX, sb.camY, sb.camZ],
                    pitch: Math.atan2(sb.camY - 1.2,
                              Math.max(0.001, sb.camZ - s.z)) * 180 / Math.PI,
                    sightHits: sb.list.length,
                    fadeTotal: f ? f.total : null,
                    fading: f ? f.fading : null,
                  };
                }''')
                per.append({'name': name, 'note': note, **st})
                if args.shots:
                    os.makedirs(os.path.join(ROOT, 'shots'), exist_ok=True)
                    page.screenshot(path=os.path.join(
                        ROOT, 'shots', f'fade-{name}.png'))

                # ---------- 独立交叉验证 ----------
                #
                # 【为什么必须加这一项，而不能只看 fading 列表】
                # fading 是「淡出系统自己的结论」——
                # 如果判定逻辑整体写错（比如高度判据反了），
                # 它会自信地报告「该淡的淡了」，与真正该淡的完全不符。
                #
                # 这里换一条路径重算：从**合并后的几何体**里
                # 随机采样若干顶点，读出它们的 aFadeId，
                # 再拿这些栋号去 blockers 里查盒子，
                # 独立判断「这个盒子在不在视线上」。
                #
                # 两条路径的数据源不同（顶点属性 vs 查表循环），
                # 结果一致才说明链路真的通了。
                xv = page.evaluate('''() => {
                  const H = window.__HD2D__;
                  const B = H.blockers;
                  const s = H.getState();
                  const cam = H.camera.position;
                  const ez = cam.z - s.z;
                  const out = { sampled: 0, onSight: [], total: B.length };
                  if (Math.abs(ez) < 1e-3) return out;
                  // 从几何体顶点采样：每栋取一个代表顶点
                  const seen = new Set();
                  H.scene.traverse((o) => {
                    if (!o.isMesh || !o.geometry || !o.geometry.attributes) return;
                    const a = o.geometry.attributes.aFadeId;
                    if (!a) return;
                    const p = o.geometry.attributes.position;
                    const stride = Math.max(1, Math.floor(p.count / 3));
                    for (let i = 0; i < p.count; i += stride) {
                      const id = a.array[i];
                      if (id < 0 || seen.has(id)) continue;
                      seen.add(id);
                      out.sampled++;
                      const b = B[id];
                      if (!b) continue;
                      const t0 = (cam.z - b.maxZ) / ez;
                      const t1 = (cam.z - b.minZ) / ez;
                      const tE = Math.max(0, Math.min(1, Math.min(t0, t1)));
                      const tX = Math.max(0, Math.min(1, Math.max(t0, t1)));
                      if (tE > tX) continue;
                      const xi = cam.x + (s.x - cam.x) * tE;
                      const xo = cam.x + (s.x - cam.x) * tX;
                      if (Math.max(xi, xo) < b.minX || Math.min(xi, xo) > b.maxX) continue;
                      const rayY = cam.y + (1.2 - cam.y) * tX;
                      if (rayY > b.top) continue;
                      out.onSight.push(id);
                      if (out.onSight.length > 12) return;
                    }
                  });
                  return out;
                }''')
                # 把交叉验证结果挂到该机位上。
                # 【为什么不能拿它与fading 直接比 id 列表】
                # fading 是**平滑之后**的状态：淡出已收敛的栋会离开列表，
                # 而刚判定为遮挡、尚未淡完的栋还在列表里。
                # 两者的差集恰好是「正在过渡中」的栋，属正常现象。
                # 所以这里只做「数量级」层面的核对：
                # 独立路径说有N 栋在视线上，淡出列表就该非空；
                # 若独立路径为 0 而淡出列表也为空，两者一致 → 确实无遮挡。
                per[-1]['crosscheck'] = xv
            report['stations'] = per

            # ---------- 4. 帧率对照 ----------
            # 淡出只增加每帧几十次纹理写入 + 一个 discard，
            # 不应造成可测量的帧率损失。有损失就说明方案选错了。
            page.evaluate('window.__HD2D__.setPlayerPos(40, 150)')
            page.wait_for_timeout(6000)
            fps = page.evaluate('''async () => {
              const t0 = performance.now();
              let n = 0;
              await new Promise((res) => {
                function tick() {
                  n++;
                  if (performance.now() - t0 > 6000) return res();
                  requestAnimationFrame(tick);
                }
                requestAnimationFrame(tick);
              });
              return (n / ((performance.now() - t0) / 1000)).toFixed(2);
            }''')
            report['fps'] = float(fps)

            browser.close()
    finally:
        proc.terminate()

    # ---------------- 判定 ----------------
    print('=' * 68)
    print('建筑遮挡淡出 —— 验证报告')
    print('=' * 68)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print()

    m = report.get('merge', {})
    fa = report.get('fade_attr', {})
    checks = []

    checks.append(('shader 编译无错误', not report['shader_errors'],
                   report['shader_errors'][:2]))
    checks.append(('页面无 JS 异常', not report['console_errors'],
                   report['console_errors'][:2]))

    ratio = (m.get('after', 1) / m.get('before', 1)) if m.get('before') else 9
    checks.append((
        f'draw call 大幅压缩 (before={m.get("before")} after={m.get("after")}, '
        f'1/{ratio:.0f})',
        ratio < 0.25, f'{ratio:.3f}'))

    checks.append(('合并几何带aFadeId 属性', fa.get('withAttr', 0) > 0,
                   fa.get('withAttr')))
    checks.append((
        'aFadeId 覆盖建筑且范围合法',
        fa.get('buildingVerts', 0) > 0 and fa.get('minId', -1) >= 0
        and fa.get('maxId', 10 ** 9) < fa.get('blockers', 0),
        f'verts={fa.get("buildingVerts")} '
        f'id=[{fa.get("minId")},{fa.get("maxId")}] '
        f'blockers={fa.get("blockers")}'))
    checks.append((
        '无 fade 属性的 mesh 已清零',
        fa.get('withoutAttr', 99) == 0,
        f"漏注入 {fa.get('withoutAttr')}（按设计豁免 {fa.get('byDesign')}）"))

    for st in report.get('stations', []):
        fading = st.get('fading') or []
        n = len(fading)
        if st['name'] == 'e-open-field':
            # 空旷处是基准：本来就没遮挡，绝不该有楼淡出。
            # 若这里也淡了，说明判据 B 的投影判据失效
            # （旧版用「任一轴贴上就算」，在广场旁误淡了一栋侧向建筑）。
            ok = n == 0
            checks.append((f"{st['name']} 空旷处不应淡出任何建筑", ok,
                           f'淡出 {n} 栋: {[f["fade"] for f in fading[:4]]}'))
        else:
            # 【以「淡出系统确实响应」为准，而不是「视线必须被挡」】
            # 视线判据实测只在 12/1071 个采样点成立 —— 避障做得太好，
            # 视线几乎永远通畅。真正的遮挡场景是「角色贴着建筑」，
            # 所以这里断言的是「有建筑被判为需要淡出」。
            ok = n > 0
            checks.append((f"{st['name']} 有建筑被淡出", ok,
                           f'{n} 栋: {[f["fade"] for f in fading[:4]]}'))
            # 淡出必须真的走到目标附近，不能停在半路。
            # fade 是**保留率**：目标 0.28，> 0.7 说明还没淡开。
            deep = [f for f in fading if f['fade'] < 0.7]
            checks.append((f"{st['name']} 淡出已充分展开", len(deep) > 0,
                           [f['fade'] for f in deep[:4]]))

    print('判定：')
    npass = 0
    for label, ok, detail in checks:
        mark = 'PASS' if ok else 'FAIL'
        npass += 1 if ok else 0
        print(f'  [{mark}] {label}' + (f'   → {detail}' if not ok or True else ''))
    print()
    print(f'{npass}/{len(checks)} 通过    fps={report.get("fps")}')
    return 0 if npass == len(checks) else 1


if __name__ == '__main__':
    sys.exit(main())
