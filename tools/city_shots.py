"""
建筑多样性视觉验证 —— 回答「9 种建筑在画面里真的可辨识吗」
================================================================================
【为什么不能只靠数据】
city_report.py 能证明「9 种类型都出现了 400 栋」，但证明不了「看得出区别」。
如果 9 种建筑的轮廓/高度/色彩几乎一样，数据再漂亮也是「9 个一样的盒子」。
所以必须出图，而且要挑**能同框比较**的机位。

【机位怎么选】
这是斜俯视 HD-2D,玩家的实际视野是 30~60 单位深度。
  · 站主街中间往两侧看 → 一排联排立面,能看高度节奏和山墙连续性
  · 站十字路口斜看    → 一屏内能塞进多种类型,这是最能分辨的机位
  · 贴地平视(低视角)  → 能看清墙面细节(雨棚/烟囱/招牌/院墙)
所以拍 4 个机位,而不是 1 张。

【为什么必须掐起步帧】
setPlayerPos 是瞬移,相机阻尼要 10 秒收敛。
前 60 帧的画面里相机还在高速运动,拍出来是拖影,不是真实观感。

用法:
  xvfb-run -a python3.11 tools/city_shots.py
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a

# (文件名, x, z, 朝向deg, 说明)
# 朝向: 0=+z(南) 90=+x(东) 180=-z(北) 270=-x(西)
#
# 【机位是按真实街网选的，不是随手填的】
# 街网坐标：主街 x=40（南北向），横街 z=104/174/244、x=-18/98。
# 所以要拍「两侧联排」必须站主街上，要拍「一屏多类型」必须站十字路口。
# 每个机位都注释了「这张图要证明什么」，拍完能对照着验收。
SHOTS = [
    # 主街中段，人在街心、面向北 → 左右两侧的联排立面同时入画。
    # 这张验证「山墙贴山墙的连续天际线」+「高度节奏」。
    ("a-main-street", 40, 130, 0, "主街两侧联排立面（连续天际线）"),

    # 主街与横街 z=174 的交点。路口视野最开阔，一屏能塞进多种类型，
    # 是分辨 9 种建筑最有效的机位。
    ("b-crossroads", 40, 174, 315, "十字路口斜看（一屏多类型）"),

    # 地标锚点。侧看能看清尖拱/钟楼/锥顶这类剪影，
    # 这是「玩家能记住位置」的关键。
    ("c-landmark", 40, 200, 340, "主街北段地标侧看（尖顶剪影）"),

    # 街区内部。验证围合布局 —— 建筑沿地块四边排列、中间留院子，
    # 而不是散点撒在荒地上。
    ("d-block-interior", -6, 190, 20, "街区内部围合布局"),
]

# 【关键】瞬移后必须等相机收敛,否则拍到的是阻尼暂态
SETTLE_MS = 11000


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(
            headless=False,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                  "--window-size=1280,720"])
        page = b.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_function("() => window.__HD2D__ && window.__HD2D__.ready",
                               timeout=180000)
        page.wait_for_timeout(4000)

        print("场景就绪，开始拍 %d 个机位" % len(SHOTS))
        for name, x, z, yaw, desc in SHOTS:
            # teleport + 设朝向。放在同一次 evaluate 里,
            # 避免两次 evaluate 之间 rAF 又跑了一帧导致朝向被输入覆盖
            page.evaluate(
                """function (a) {
                  window.__HD2D__.setPlayerPos(a[0], a[1]);
                  window.__HD2D__.faceTo(a[2]);
                }""", [x, z, yaw])
            page.wait_for_timeout(SETTLE_MS)
            page.screenshot(path="docs/screenshots/city_%s.png" % name)
            print("  ✓ %-18s (%d,%d) %s" % (name, x, z, desc))

        if errs:
            print("页面错误 %d 条：%s" % (len(errs), errs[:3]))
        else:
            print("0 个 JS 错误")
        b.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())