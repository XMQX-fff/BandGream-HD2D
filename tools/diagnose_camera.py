"""
相机遮挡诊断 —— 用真实 Raycaster 从相机射向角色。

为什么必须用射线而不是看截图：
  之前「角色 inView: true 但截图里看不到」的排查卡了很久，
  因为包围盒的数学判定和真实渲染结果对不上。
  包围盒只登记了「房屋主体」，而实际挡住画面的是
  合并后的 Mesh（mergeStatics 把上千构件并成几十个 mesh，
  它的几何范围远大于单栋房子）。射线打的是真实几何，结论唯一。

【为什么要加 ?debug=nomerge】
  合并后整座城被并成几十个巨型 mesh，射线只能报告
  「被 statics_merged 里的某个 mesh 挡住」—— 无法定位是哪一个物体。
  nomerge 模式下每个构件独立，命中对象才有可读的 name/父级，
  才能得出「是树挡住了」还是「是房子挡住了」这种可行动的结论。

用法:
  xvfb-run -a python3.11 tools/diagnose_camera.py [url] [--shots]

【改完代码必须重启 dev server，否则测的是旧代码】
诊断默认打http://localhost:5173/（vite dev）。
Vite 会热更新模块，但本脚本每次都重新 goto 页面，
所以只要 dev server 还在跑就会拿到新代码 ——
**前提是 dev server 是在你改代码之后启动/仍在运行**。
改完 camera.js 却看到诊断数值一字未变时，
先确认 dev server 是否还活着（pkill 掉再起），
不要立刻怀疑自己的逻辑写错了。
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/?debug=nomerge"
SHOTS = "--shots" in sys.argv
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a if "debug=" in a else a + ("&" if "?" in a else "?") + "debug=nomerge"

# 相机阻尼是指数收敛，setPlayerPos 是瞬移。
# 实测 2s / 10s / 14s 三次采样位置仍在漂移，必须等到稳定。
SETTLE_MS = 15000

POINTS = [
    ("主街中段", 40, 120),
    ("城区西北", -30, 120),
    ("横街西口", 12, 140),
    ("横街东口", 98, 140),
    ("出生点", 6, 14),
]

# 从相机指向角色。角色 sprite 锚点在底部，胸口大约在 y=1.0。
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

  // 【必须只打 Mesh】Sprite.raycast 依赖渲染时注入的内部相机
  // （three 源码里读 _camera.matrixWorld），在渲染循环之外手动调用
  // 会抛 "Cannot read properties of null (reading 'matrixWorld')"。
  // 而且我们要查的本来就是「建筑挡住了没有」，角色精灵自己不算遮挡物。
  const meshes = [];
  scene.traverse(o => { if (o.isMesh && o.visible) meshes.push(o); });

  const rc = new T.Raycaster(from, dir, 0.01, dist);
  const hits = rc.intersectObjects(meshes, false);

  // 命名：合并前每个构件的 name 是空的，用父级 Group 的名字 + 几何类型辨认
  const label = (o) => {
    const parts = [];
    let p = o;
    while (p && p !== scene) {
      if (p.name) parts.unshift(p.name);
      p = p.parent;
    }
    const g = o.geometry && o.geometry.type ? o.geometry.type.replace('Geometry', '') : o.type;
    return (parts.join('/') || '(无名)') + ':' + g;
  };

  // 视线被挡住的那些命中（排除角色自己的接地影 —— 影子是平的，在地面高度）
  const blockers = hits
    .filter(h => h.distance < dist - 0.6)
    .filter(h => !(h.object.name || '').includes('shadow'))
    .map(h => ({
      d: +h.distance.toFixed(2),
      y: +h.point.y.toFixed(2),
      what: label(h.object),
      // 命中点离角色多远 —— 最近的那个才是真正挡脸的
      toHero: +Math.hypot(h.point.x - st.x, h.point.z - st.z).toFixed(2)
    }));

  const p = to.clone().project(cam);
  const W = window.innerWidth, Hh = window.innerHeight;

  return {
    state: st,
    cam: [+from.x.toFixed(1), +from.y.toFixed(1), +from.z.toFixed(1)],
    rayDist: +dist.toFixed(1),
    blockCount: blockers.length,
    blockers: blockers.slice(0, 4),
    ndc: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
    screen: [Math.round((p.x * 0.5 + 0.5) * W), Math.round((-p.y * 0.5 + 0.5) * Hh)],
    vp: [W, Hh],
    pitchDeg: +(Math.atan2(from.y - 1.0, Math.hypot(from.x - st.x, from.z - st.z)) * 180 / Math.PI).toFixed(1)
  };
}"""
ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
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

    counts = page.evaluate("""() => ({
      blockers: window.__HD2D__.blockerCount(),
      solids: window.__HD2D__.solidCount()
    })""")
    print(f"遮挡物 {counts['blockers']} 个（其中实心 {counts['solids']} 个）\n")

    report = []
    for label, x, z in POINTS:
        page.evaluate("([x, z]) => window.__HD2D__.setPlayerPos(x, z)", [x, z])
        page.wait_for_timeout(SETTLE_MS)
        d = page.evaluate(JS_DIAG)
        d["label"] = label
        report.append(d)
        stuck = d["state"].get("stuck")
        flag = "OK   " if d["blockCount"] == 0 else "BLOCK"
        if stuck:
            flag = "穿模!"
        print(f"{flag} {label:8s} cam={d['cam']} pitch={d['pitchDeg']}° blocks={d['blockCount']}"
              + ("  [角色卡在实心体内]" if stuck else ""))
        for b in d["blockers"]:
            print(f"         └ d={b['d']:>5} y={b['y']:>5} 距角色{b['toHero']:>5}  {b['what']}")
        if SHOTS:
            page.screenshot(path=f"/tmp/diag_{label}.png")

    print("\n=== 汇总 ===")
    bad = [d for d in report if d["blockCount"] > 0]
    stuck = [d for d in report if d["state"].get("stuck")]
    print(f"视线通畅{len(report) - len(bad)}/{len(report)}  "
          f"穿模 {len(stuck)}/{len(report)}")
    if errors:
        print("\n--- console errors ---")
        for e in errors[:20]:
            print(e)

    with open("/tmp/diag_report.json", "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    browser.close()
