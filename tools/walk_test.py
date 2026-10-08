"""
行走路径回归 —— 模拟玩家真实走动，检查沿途的可见性与穿模。

【为什么需要这个，而不能只测「几个固定机位」】
射线诊断发现城区西北 (-30,120) 仍有7 个遮挡物，一度以为是相机算法
没解够。但几何验算证明那是**几何极限**：
抬到 31.5 /俯角 48° 仍越不过一栋 top=8.17 的房子 ——
因为那栋房子在角色正后方仅 6.4 单位处，是被碰撞挤进建筑夹缝的结果。

而真实玩家是沿街走的，不会主动站进夹缝。
所以「固定机位」这种测法本身有缺陷：测的是玩家到不了的点。

本脚本按真实路径走一段：
  沿主街从南走到北 → 拐入横街 → 沿横街走到东
每个采样点都检查视线通畅性与穿模，并截图。

【别在测试运行期间改 src/】
vite 会热更新重载页面，角色被重置回出生点，之后每个采样点
都测成同一个位置 —— 报告出来是一堆「遮挡」假结论，
很容易被当成 bug 去查。脚本内置位置突变检测会打印明确提示。

用法:
  xvfb-run -a python3.11 tools/walk_test.py [url] [--shots]
"""
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:4173/"
SHOTS = "--shots" in sys.argv
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a

# 采样点：沿主街 + 横街，像真人那样走
# 每项: (标签, x, z)
PATH = [
    ("主街起点",    40, 30),
    ("主街南段",    40, 60),
    ("主街中段",    40, 100),
    ("主街北段",    40, 140),
    ("主街北端",    40, 180),
    ("主街末端",    40, 215),
    ("横街西口",    12, 140),
    ("横街中西",    55, 140),
    ("横街东口",    98, 140),
    ("横街东端",   130, 140),
    ("离街一步",    30, 140),   # 故意靠近建筑，测试最坏情况
    ("城区北侧",    40, 230),
]

JS_DIAG = """() => {
  const H = window.__HD2D__;
  const T = H.THREE;
  const cam = H.camera;
  const scene = H.scene;
  const st = H.getState();

  const from = cam.position.clone();
  const to = new T.Vector3(st.x, 1.0, st.z);
  const dir = to.clone().sub(from);
  const dist = dir.length();
  dir.normalize();

  const meshes = [];
  scene.traverse(o => { if (o.isMesh && o.visible) meshes.push(o); });
  const rc = new T.Raycaster(from, dir, 0.01, dist);
  const hits = rc.intersectObjects(meshes, false);

  const label = (o) => {
    const parts = []; let p = o;
    while (p && p !== scene) { if (p.name) parts.unshift(p.name); p = p.parent; }
    const g = o.geometry && o.geometry.type ? o.geometry.type.replace('Geometry','') : o.type;
    return (parts.join('/') || '(无名)') + ':' + g;
  };
  // 排除角色自己的接地影（平的，在地面高度）
  const blockers = hits
    .filter(h => h.distance < dist - 0.6)
    .filter(h => !(h.object.name || '').includes('shadow'))
    .map(h => ({ what: label(h.object), d: +h.distance.toFixed(1) }));

  // 角色离最近实心建筑有多远
  let near = 999;
  for (const b of H.blockers || []) {
    if (!b.solid) continue;
    const nx = st.x < b.minX ? b.minX : (st.x > b.maxX ? b.maxX : st.x);
    const nz = st.z < b.minZ ? b.minZ : (st.z > b.maxZ ? b.maxZ : st.z);
    near = Math.min(near, Math.hypot(st.x - nx, st.z - nz));
  }

  return {
    state: st, cam: [+from.x.toFixed(1), +from.y.toFixed(1), +from.z.toFixed(1)],
    blocks: blockers.length, first: blockers[0] || null,
    nearWall: +near.toFixed(1),
    pitch: +(Math.atan2(from.y - 1.0, Math.hypot(from.x - st.x, from.z - st.z)) * 180 / Math.PI).toFixed(1)
  };
}"""

# 连续行走时的采样。
#
# 【必须用带花括号 + 显式 return 的形式，不能用箭头函数简写】
# 写成 `() => ({ a: ..., b: ... })` 时，Playwright 会把返回值
# 当作「多个 return 值」处理，对象被展开成数组 ——
# 于是 getState().x 拿到的是 [10] 而不是 10，
# 报错 "x.toFixed is not a function"。
# 上面的 JS_DIAG 之所以正常，正是因为它用了带花括号的形式。
# 这里再套一层 JSON.parse(JSON.stringify(...))：
# 无论 Playwright 怎么序列化，返回值一定是纯 JSON 结构。
# 这个坑出现过三次（拿到 [10]、拿到 undefined、拿到 None），
# 一次转换彻底消除歧义，比逐个试[0] / .x 可靠。
JS_SHIFT = """function () {
  const H = window.__HD2D__;
  return JSON.parse(JSON.stringify({
    camX: H.camera.position.x,
    hx: H.getState().x,
    shiftX: H.camera.userData._shiftX
  }));
}"""

ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--disable-gpu-sandbox",
]

with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS, headless=False, chromium_sandbox=False)
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    errors = []
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)

    page.goto(URL, wait_until="load", timeout=60000)
    page.wait_for_function("() => window.__HD2D__ && window.__HD2D__.ready === true", timeout=30000)
    page.wait_for_timeout(3000)

    bad = []
    print(f"{'机位':<12}{'角色位置':<16}{'相机':<22}{'俯角':>7}{'贴墙':>7}{'遮挡':>6}")
    print("-" * 74)
    for label, x, z in PATH:
        # setPlayerPos 与随后的诊断必须绑在同一次页面生命周期里。
        # 中途热更新重载页面会让 evaluate抛 "Execution context was destroyed"，
        # 整个测试脚本带栈退出、后面几个点根本没测 —— 看起来像崩了，
        # 实际只是第一次踩到坑。重新加载后重试这一轮。
        try:
            page.evaluate("([x, z]) => window.__HD2D__.setPlayerPos(x, z)", [x, z])
            page.wait_for_timeout(15000)      # 等阻尼收敛
            d = page.evaluate(JS_DIAG)
        except Exception as exc:
            if "Execution context" not in str(exc):
                raise
            print(f"~~ {label:<10} 页面被热更新重载，重新加载后重试")
            page.goto(URL, wait_until="load", timeout=60000)
            page.wait_for_function(
                "() => window.__HD2D__ && window.__HD2D__.ready === true", timeout=30000)
            page.wait_for_timeout(2000)
            page.evaluate("([x, z]) => window.__HD2D__.setPlayerPos(x, z)", [x, z])
            page.wait_for_timeout(15000)
            d = page.evaluate(JS_DIAG)
        st = d["state"]

        # 【防串扰】角色没落在请求的位置上，说明页面被重载过（热更新）
        # 或 setPosition 出了问题。前者会静默地把后续采样点全测成出生点，
        # 报告出一堆「遮挡」的假结论 —— 遇到过，必须在这里挡住。
        if abs(st["x"] - x) > 6 or abs(st["z"] - z) > 6:
            print(f"!! {label:<10} 位置异常：请求({x},{z}) 实际({st['x']:.0f},{st['z']:.0f})")
            print("     页面很可能被热更新重载了。别在测试运行期间改 src/。")
            bad.append((label, d))
            continue
        # 俯角超限要和遮挡同等对待：画面退化成俯视平面地图，
        # 比被任何东西遮挡都更糟。这条断言是实测补的——
        # 联合搜索曾在缩短到下限后把俯角推到 54.7°（上限 48°），
        # 而当时只看「遮挡数」，报告里显示的是「1 个遮挡」，
        # 真正的问题（俯角失控）被藏在了这行字后面。
        pitch_ok = d["pitch"] <= 48.5
        ok = d["blocks"] == 0 and not st.get("stuck") and pitch_ok
        if not ok:
            bad.append((label, d))
        mark = "OK" if ok else "!!"
        if not pitch_ok:
            print(f"    !!俯角 {d['pitch']}° 超出48° 上限 —— 画面会退化成俯视平面地图")
        print(f"{mark} {label:<10}({st['x']:>5.0f},{st['z']:>5.0f})  "
              f"({d['cam'][0]:>6.1f},{d['cam'][1]:>5.1f},{d['cam'][2]:>6.1f})  "
              f"{d['pitch']:>5.1f}°{d['nearWall']:>7.1f}{d['blocks']:>6}")
        if d["first"]:
            print(f"{'':14}└ 挡住: {d['first']['what']} @{d['first']['d']}")
        if SHOTS:
            page.screenshot(path=f"/tmp/walk_{label}.png")

    print(f"\n{len(PATH) - len(bad)}/{len(PATH)} 个采样点视线通畅")
    if bad:
        print("问题点：")
        for label, d in bad:
            why = []
            if d["blocks"]:
                why.append(f"遮挡{d['blocks']}")
            if d["pitch"] > 48.5:
                why.append(f"俯角{d['pitch']}°超限")
            if not why:
                why.append("位置异常")
            print(f"  {label}: {' '.join(why)}  贴墙{d['nearWall']} 俯角{d['pitch']}°")
    # ------------------------------------------------------------------
    #  连续行走：唯一能测出「相机抖动」的方式
    # ------------------------------------------------------------------
    # 静态机位每个点都等 15 秒才采样，抖动早衰减完了 —— 测不出来。
    # 玩家实际沿街走时，街边树不断进出视野，
    # 求解出的横移量会在 0 与 16.3 之间反复跳。
    # 这里让角色连续穿过树阵，密集采样相机的 x，
    # 看它到底是平滑移动还是每半秒抽搐一次。
    # 【采样点必须选在真正需要横移的区域】
    # 第一版沿主街 x=40 走，结果相机 x 全程恒为 40 —— 主街是笔直的，
    # 求解出的横移量始终为 0，测了个寂寞。
    # 横移只在「房子正好在角色正后方」的夹缝里才非零，
    # 所以要沿横街 y=140 走（那一带实测有横移需求）。
    print("\n连续行走（沿横街，看相机是否抽搐）")
    print("-" * 74)
    page.evaluate("() => window.__HD2D__.setPlayerPos(10, 140)")
    page.wait_for_timeout(15000)

    samples = []
    for i in range(40):
        # 【必须用 teleport 而不是 setPlayerPos】
        # setPlayerPos 只挪角色，相机被阻尼拉着飞。软渲染只有 1 fps，
        # 300 ms 连一帧都跑不满 —— 采样到的全是「相机还没到」的中间态，
        # 横移量读数会像随机数。之前 fade_probe 也在同一个坑里栽过。
        # teleport 会连带把相机瞬移到位，读数才是真实的横移量。
        page.evaluate(f"window.__HD2D__.teleport({10 + i * 3}, 140)")
        page.wait_for_timeout(300)
        d = page.evaluate(JS_SHIFT)
        samples.append(d)

    # 相邻两帧的相机横移速率：正常跟随应该在 1~3 单位/秒，
    # 抽搐表现为某一帧跳十几单位
    # 相机 x 减去角色 x = 实际横移量（去掉玩家自身移动带来的变化）
    rel = [round(d["camX"] - d["hx"], 2) for d in samples]
    deltas = [round(rel[i + 1] - rel[i], 2) for i in range(len(rel) - 1)]
    biggest = max(deltas, key=abs) if deltas else 0.0
    zigzag = sum(1 for i in range(1, len(deltas))
                 if deltas[i] * deltas[i - 1] < 0 and abs(deltas[i]) > 1.0)
    maxShift = max(abs(r) for r in rel)
    print("  相机相对角色的横移量（每 400ms 采样）:")
    print("   " + " ".join(f"{r:+.1f}" for r in rel))
    print(f"  最大横移: {maxShift:.1f}   （> 1说明这一带真的需要横移）")
    print(f"  单次跳变最大: {biggest:+.2f}   （持续移动中应 < 2）")
    print(f"  反向大跳变: {zigzag} 次   （> 3 视为抽搐）")
    if abs(biggest) > 2.0 or zigzag > 3:
        print("  !! 相机在抽搐 —— 需要加大 SHIFT_RATE 或给 shiftX 加惯性")
    elif maxShift <= 1.0:
        print("  -- 这一带不需要横移，本段没测到东西")
    else:
        print("  OK 相机横移平滑")

    if errors:
        print("\n--- console errors ---")
        for e in errors[:15]:
            print(e)
    browser.close()
