"""
俯角探针 —— 独立于游戏代码注入，测任何版本（包括改动前的基线）
================================================================================
【为什么不直接用 window.__HD2D__.pitchSeries】
那个接口是本轮改动才加的。要测「改动前」的基线就必须先跑旧代码，
而旧代码没有这个接口 —— 于是基线和新版用了两套测量逻辑，
两者不可比。测量方式必须完全一致才有意义。

所以这里改成从外部注入一个探针，对任意版本的 src/ 都成立。

【踩过两个坑，两个都写在这里】

坑 1：不能用「Python 逐次 evaluate」当帧驱动
  第一版写的是「Python 循环 260 次 evaluate，每次把角色挪 0.9」，
  结果测出来全是「俯角恒定= 角色没动」。
  原因：**一次 evaluate 不等于一个渲染帧**。evaluate 是 CDP 往返，
  耗时几毫秒到几十毫秒不等（软件渲染下更慢），
  而 rAF 按真实时钟走 —— 34 秒里页面可能只渲染了几十帧，
  evaluate 却调了 260 次。两者节奏完全对不上。
  更糟的是相机阻尼要 10 秒才收敛，位置被反复重置后俯角根本来不及变化。

  正确做法：把「推进角色 + 记录俯角」放进**同一个 rAF 回调**里，
  由页面按自己的帧节奏走完 N 帧，Python 只负责等它结束。

坑 2：evaluate 的 JS 必须用带花括号 + 显式 return
  箭头函数简写 `() => ({a, b})` 返回对象时，
  Playwright 会把它当成「多个 return 值」，对象被展开成数组。

【测量原理】
俯角 = atan2(camY - 1.2, camZ - playerZ)，与 camera.js 的 SIGHT_END_Y 一致。
必须自己算，不能读相机的 rotation —— 那是 lookAt 出来的朝向，
不等于「从角色看向相机」的俯角。

用法:
  xvfb-run -a python3.11 tools/pitch_probe.py [url] [--frames N]
"""
import math
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"
FRAMES = 200
if "--frames" in sys.argv:
    FRAMES = int(sys.argv[sys.argv.index("--frames") + 1])
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a

# 行走路径。
#
# 【起点必须在 z=20 附近，且每段只有 60~90 帧】
# 第一版每段走 200 帧、每帧 0.55 单位 = 110 单位行程，
# 6 段全部从 z=30 出发 → 终���落在 z=-80，已越过地图北界（B.minZ≈-40）。
# 越界后 setPlayerPos 被 clamp，角色不再移动，
# 于是俯角恒定、报出一份「完美平滑」的假数据
# （实测基线就是这样得出了 0.1° 摆幅的结论 —— 完全无效）。
#
# 现在每段 70 帧 × 0.5 = 35 单位，起点错开分布，
# 始终留在城区内（z ∈ [-30, 200]）。
PATH = [
    (40, 20), (40, 60), (40, 100), (40, 140), (40, 180),
    (12, 140), (-20, 140),
]
FRAMES = 70
STEP = 0.5

JUMP_DEG = 2.0
SINGLE_FRAME_MAX = 1.2
# 与 camera.js 的 RISE / FALL保持一致（用于按帧率归一化单帧阈值）
RISE = 7.0
# 滤波自身允许的「跨 6°」幅度，用于推算帧率归一化阈值
SPAN = 6.0

JS_INJECT = """
function () {
  if (window.__PITCH__) return { ok: true };
  const CAP = 4096;
  const buf = new Float32Array(CAP);
  const m = { idx: 0, n: 0, frames: 0, running: false, done: true,
              dx: 0, dz: 0, target: 0, last: 0, dtSum: 0 };
  const api = window.__HD2D__;

  function tick() {
    const s = api.getState();
    const cam = api.camera;
    buf[m.idx] = Math.atan2(cam.position.y - 1.2,
      Math.max(0.001, cam.position.z - s.z)) * 180 / Math.PI;
    m.idx = (m.idx + 1) % CAP;
    if (m.n < CAP) m.n++;
    // 【同时记录帧间隔】单帧跳变阈值必须按 dt 归一化：
    // 一阶低通 prev + (t-prev)*(1-e^(-rate*dt)) 在 dt=200ms 时
    // 单帧就能走 3~4.5°，那是滤波的正常行为，不是 bug。
    // 用固定阈值会把软渲染的低帧率误判成跳变。
    const now = performance.now();
    if (m.last) m.dtSum += now - m.last;
    m.last = now;
    m.frames++;
    if (m.running) {
      api.setPlayerPos(s.x + m.dx, s.z + m.dz);
      if (m.frames >= m.target) { m.running = false; m.done = true; }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__PITCH__ = {
    run: function (frames, dx, dz) {
      m.frames = 0; m.idx = 0; m.n = 0;
      m.dx = dx; m.dz = dz; m.target = frames;
      m.running = true; m.done = false;
      m.last = 0; m.dtSum = 0;
      return { started: true };
    },
    read: function () {
      const take = Math.min(m.n, CAP);
      const out = [];
      for (let i = 0; i < take; i++) {
        out.push(buf[(m.idx - take + i + CAP * 2) % CAP]);
      }
      return { frames: m.frames, done: m.done, samples: out,
               avgDt: m.frames > 1 ? m.dtSum / (m.frames - 1) : 0 };
    }
  };
  return { ok: true };
}
"""

JS_SETTLE = """
function () { window.__HD2D__.setPlayerPos(40, 30); return { ok: true }; }
"""

JS_RUN = "function (a) { return window.__PITCH__.run(a[0], a[1], a[2]); }"
JS_READ = "function () { return window.__PITCH__.read(); }"
JS_STATE = "function () { return window.__HD2D__.getState(); }"
JS_DONE = "function () { return window.__PITCH__.read().done; }"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(
            headless=False,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                  "--window-size=1280,720"],
        )
        page = b.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(URL, wait_until="load")
        page.wait_for_function("() => window.__HD2D__ && window.__HD2D__.ready", timeout=60000)
        page.wait_for_timeout(2500)
        page.evaluate(JS_INJECT)
        page.wait_for_timeout(500)

        print("=" * 78)
        print("俯角连续性诊断（外部探针，页面内 rAF 自驱动）")
        print("=" * 78)

        total_jumps = 0
        total_frames = 0
        worst_single = 0.0
        worst_span = 0.0
        fail = False

        for (x, z) in PATH:
            page.evaluate("function (a) { window.__HD2D__.setPlayerPos(a[0], a[1]); return { ok: true }; }",
                          [x, z])
            page.wait_for_timeout(1500)
            # 【探针自愈 —— 必须有】
            # 探针是注入到 window 上的普通对象,页面一旦重载(vite HMR、
            # 用户手刷、崩溃重启)就会被清空,而 window.__HD2D__ 也会
            # 短暂消失。此前直接 window.__PITCH__.run(...) 会报
            # "Cannot read properties of undefined" 且看不出真实原因。
            # 每段之前确认一次，消失就重新注入并重新 settle。
            alive = page.evaluate("function () { return !!window.__PITCH__; }")
            if not alive:
                print("       (探针丢失,重新注入)")
                page.wait_for_function("() => window.__HD2D__ && window.__HD2D__.ready",
                                       timeout=180000)
                page.evaluate(JS_INJECT)
                page.evaluate("function (a) { window.__HD2D__.setPlayerPos(a[0], a[1]); return { ok: true }; }",
                              [x, z])
                page.wait_for_timeout(1500)
            # 每帧推进 STEP 单位 —— 慢速行走，接近真人速度。
            # 走太快会让每栋房子的遮挡窗口短到 1~2 帧，
            # 反而测不出「持续遮挡下俯角是否稳定」。
            page.evaluate(JS_RUN, [FRAMES, 0.0, -STEP])
            try:
                page.wait_for_function(JS_DONE, timeout=240000)
            except Exception:
                print("  !! (%3d,%3d) 采样超时" % (x, z))
                fail = True
                continue

            res = page.evaluate(JS_READ)
            st = page.evaluate(JS_STATE)
            pitches = res["samples"]
            nf = res["frames"]

            if nf < 10 or not pitches or (max(pitches) - min(pitches) < 1e-6):
                print("  !! (%3d,%3d) 只采到 %d 帧、俯角恒定 —— 角色没动" % (x, z, nf))
                fail = True
                continue

            # 【掐掉起步 12 帧 —— 少了这一步会得出假结论】
            # setPosition 是瞬移，相机阻尼要 10 秒才收敛。
            # 起步那十几帧的俯角从瞬移值往基准值快速滑动
            # （实测 29.12° → 23.47°，跨度 5.6°），
            # 那是**阻尼收敛的暂态，不是避障跳变**。
            # 不掐掉就会把暂态当成跳变（会误判成 FAIL），
            # 反过来如果行程太短、暂态占了大部分，就会像第一版那样
            # 测出「摆幅 0.1°」的假平滑。
            pitches = pitches[12:]
            span = max(pitches) - min(pitches)
            deltas = [abs(pitches[i] - pitches[i - 1]) for i in range(1, len(pitches))]
            jumps = sum(1 for d in deltas if d > JUMP_DEG)
            single = max(deltas) if deltas else 0.0

            # -----------------------------------------------------------------
            #  单帧阈值必须按帧间隔归一化，否则低帧率下必然误判
            # -----------------------------------------------------------------
            # 相机对 lift/pull 走的是一阶低通：
            #     prev + (target - prev) * (1 - e^(-RISE·dt))
            # 所以「单帧最多能变多少」完全由 dt 决定。实测本机软渲染只有
            # 本机软渲染实测只有 1.2 fps（dt ≈ 863ms），此时该式允许单帧走 6.0°
            # —— 这是滤波的**正常行为**，不是跳变。
            # 若用固定阈值 1.2° 去判，必然 FAIL，而且会诱导人去改
            # 相机的滤波参数 —— 那才是真正的破坏（把画面调卡来迁就测试）。
            #
            # 正确做法：以 60 fps 为基准帧率算出真实门槛，
            # 再按实测 dt 放宽，把「滤波允许的」与「滤波之外的硬切」区分开。
            avg_dt = res.get("avgDt", 0.0) / 1000.0   # ms → s
            fps = 1.0 / avg_dt if avg_dt > 1e-6 else 60.0
            allowed = SPAN * (1.0 - math.exp(-RISE * avg_dt))
            # 门槛 = max(基准门槛, 滤波允许值 × 1.15)
            # 1.15 给一点余量：真实设备 60fps 下滤波只允许 0.66°，
            # 所以基准门槛 1.2° 依然生效，低帧率下不会被放宽成永远 PASS。
            gate = max(SINGLE_FRAME_MAX, allowed * 1.15)

            total_jumps += jumps
            total_frames += len(pitches)
            worst_single = max(worst_single, single)
            worst_span = max(worst_span, span)

            flag = ""
            if span > 6:
                flag += "  <<< 摆幅过大"
            if single > gate:
                flag += "  <<< 单帧硬切"
            print("  起(%3d,%3d) 末(%3d,%3d) %3d帧  俯角 %5.1f°~%5.1f°  摆幅 %5.1f°  "
                  "跳变 %3d  单帧最大 %5.2f° (门槛 %.2f° @%.0ffps)%s"
                  % (x, z, st["x"], st["z"], len(pitches), min(pitches), max(pitches),
                     span, jumps, single, gate, fps, flag))

            # 【越界检测 —— 这一条是必须的】
            # 角色被clamp 到地图边界后不再移动，俯角自然恒定，
            # 报出来的是「摆幅 0.1° 的完美平滑」——
            # 第一版基线就是这样得出了完全虚假的结论。
            # 所以必须验证「确实走起来了」，否则一切指标无意义。
            moved = abs(st["z"] - z) + abs(st["x"] - x)
            if moved < 8:
                print("       <<< 只移动了 %.1f 单位：撞到地图边界或被卡住，本次数据无效"
                      % moved)
                fail = True
                continue

            if flag:
                fail = True

        print("-" * 78)
        print("合计：%d 帧，跳变 %d 次，单帧最大 %.2f°，最大摆幅 %.1f°"
              % (total_frames, total_jumps, worst_single, worst_span))
        # 汇总行必须说明单帧阈值是按帧率归一化后的，否则 1.99° 会被误读成 bug
        print("（单帧阈值按实测帧间隔归一化：软渲染实测仅 1.2fps、dt≈863ms，"
              "一阶低通本身即允许单帧约 6°，故单帧指标在本机无参考价值；"
              "摆幅与跳变次数才是与帧率无关的判据）")
        print("判定：%s" % ("FAIL 俯角仍在跳变" if fail else "PASS 俯角稳定"))
        if errs:
            print("页面错误 %d 条：%s" % (len(errs), errs[:3]))
        b.close()
        return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
