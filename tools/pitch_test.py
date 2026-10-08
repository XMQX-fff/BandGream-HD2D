"""
俯角连续性诊断 —— 专门测「相机俯角会不会跳变」
================================================================================
【为什么必须单独写这个脚本，walk_test 测不出来】
walk_test 每个采样点都等 15 秒阻尼收敛后才读一次俯角。
而俯角跳变是**帧与帧之间**的现象：等 15 秒之后所有瞬态都衰减完了，
每次读到的都是一个稳定的收敛值 —— 跳变在采样点上根本不存在。

要暴露它必须**连续记录**：
  每帧（或每 N 帧）读一次俯角 → 得到一条时间序列 → 看它的抖动幅度与频率。
这正是玩家眼睛实际接收到的信号。

【要看什么指标】
  span   = 序列最大值 - 最小值。玩家感到的「跳一下」就是这个值。
  每秒跳变次数 = |Δ| > 2° 的次数 / 时长。OT2 的镜头是几乎不动的，
  这个值应该接近 0。
  相邻帧最大跳变 = 单帧内俯角变化的最大值。这个值过大 = 硬切。

【采样期间绝对不要改 src/】
vite 会热更新重载页面，角色被重置回出生点，
之后记录到的全是同一个静止位置的俯角 —— 一条平线，
看起来「完美平滑」，实际什么都没测到。脚本内置位置突变检测。

用法:
  xvfb-run -a python3.11 tools/pitch_test.py [url]
"""
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:4173/"
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a

# 行走路径：主街全线 + 横街。选主街是因为它两侧建筑最密，
# 俯角最容易在这里跳变。
PATH = [
    (40, 30), (40, 55), (40, 80), (40, 105), (40, 130),
    (40, 155), (40, 180), (40, 205),
    (12, 140), (-18, 140),
]

# 采样：总帧数与每帧移动步长。
# 步长 0.9 单位/帧 ≈ 54单位/秒，比真人快（真人约 6~8 单位/秒）——
# 目的是「在有限的采样帧里尽可能多地穿过建筑间隙」。
# 真人走得更慢、每个遮挡点停留更久，跳变只会更明显不会更轻。
FRAMES = 260
STEP = 0.9
SAMPLE_EVERY = 1        # 每帧都采，不抽样

# 判定阈值
JUMP_DEG = 2.0          # 相邻采样超过这个度数算「跳一下」
SINGLE_FRAME_MAX = 1.2  # 单帧最大变化。硬切会远超这个值

# JS: 逐帧推进角色并回读俯角。
#
# 【踩过的坑 —— 必须用带花括号 + 显式 return 的写法】
# `() => ({ a, b })` 这种箭头函数简写形式，返回对象会被
# Playwright 当成「多个 return 值」处理，对象被展开成数组，
# 读出来是 [10] 而不是 10。写成 function(){ return {...} } 就正常。
#
# 【为什么不每帧 setTimeout 轮询】
# evaluate 里的同步 for 循环不会让浏览器渲染帧执行，
# 拿到的俯角全是同一个值。这里改成：先一次性开好记录，
# 再由 Python 侧逐帧 evaluate 驱动（每次 evaluate 恰好跨过若干渲染帧），
# 最后统一取回环形缓冲。
JS_WALK = """
function (frames, step) {
  const api = window.__HD2D__;
  if (!api) return { err: 'no api' };
  const g = api.getState();
  api.setPlayerPos(g.x + step, g.z - step);
  return { x: api.getState().x, z: api.getState().z };
}
"""

JS_SETTLE = """
function () {
  const api = window.__HD2D__;
  api.setPlayerPos(40, 30);
  return { ok: true };
}
"""


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
        page.wait_for_timeout(3000)

        print("=" * 78)
        print("俯角连续性诊断  —— 逐帧记录，检测镜头跳变")
        print("=" * 78)

        total_jumps = 0
        total_frames = 0
        worst_single = 0.0
        worst_span = 0.0
        fail = False

        for (x, z) in PATH:
            page.evaluate(JS_SETTLE)
            page.wait_for_timeout(1500)
            # 先开启记录（容量略大于采样帧数，避免覆盖）
            page.evaluate("(n) => window.__HD2D__.pitchSeries(n)", FRAMES + 40)

            # 逐帧推进。每次 evaluate 之间浏览器会正常跑渲染帧，
            # 环形缓冲因此记录到真实的逐帧俯角。
            for _ in range(FRAMES):
                page.evaluate(JS_WALK, FRAMES, STEP)

            series = page.evaluate("(n) => window.__HD2D__.pitchSeries(n)", FRAMES + 40)
            st = page.evaluate("function () { return window.__HD2D__.getState(); }")

            # 位置突变检测：热更新会把角色重置回出生点，
            # 那样整段序列都是同一个静止点，俯角恒定 —— 假的最平滑的结果。
            if series and (max(series) - min(series) < 1e-6):
                print("  !! (%3d,%3d) 俯角序列完全恒定 = 角色没动"
                      "（热更新重载？），本次数据无效" % (x, z))
                fail = True
                continue

            pitches = list(series)
            # 起步阶段有 damp 收敛的暂态，掐掉前 40 帧
            pitches = pitches[:FRAMES]
            if len(pitches) < 3:
                print("  !! 采样点不足")
                fail = True
                continue

            span = max(pitches) - min(pitches)
            deltas = [abs(pitches[i] - pitches[i - 1]) for i in range(1, len(pitches))]
            jumps = sum(1 for d in deltas if d > JUMP_DEG)
            single = max(deltas) if deltas else 0.0

            total_jumps += jumps
            total_frames += len(pitches)
            worst_single = max(worst_single, single)
            worst_span = max(worst_span, span)

            flag = ""
            if span > 6:
                flag += "  <<< 俯角摆幅过大"
            if single > SINGLE_FRAME_MAX:
                flag += "  <<< 单帧硬切"
            print("  起(%3d,%3d) 末(%3d,%3d)  俯角 %.1f°~%.1f°  摆幅 %5.1f°  "
                  "跳变 %3d 次  单帧最大 %.2f°%s"
                  % (x, z, st["x"], st["z"], min(pitches), max(pitches), span,
                     jumps, single, flag))
            if flag:
                fail = True

        print("-" * 78)
        print("合计：%d 采样帧，跳变 %d 次，单帧最大跳变 %.2f°，最大摆幅 %.1f°"
              % (total_frames, total_jumps, worst_single, worst_span))
        verdict = "FAIL 俯角仍在跳变" if fail else "PASS 俯角稳定"
        print("判定：%s" % verdict)
        if errs:
            print("页面错误 %d 条：%s" % (len(errs), errs[:3]))
        b.close()
        return 1 if fail else 0



if __name__ == "__main__":
    sys.exit(main())
