"""
截图回归工具 —— 在多个机位与视口下截图，用于人工复核画面。

关键：本环境的无头 Chrome 只有在 **xvfb-run + headful 模式** 下才能拿到
WebGL2；纯 headless（headless_shell）无论何种flag 都失败。

【为什么等待时间这么长】
相机阻尼是指数收敛，setPlayerPos 是瞬移。实测 2s / 10s / 14s 三次采样
位置仍在漂移 —— 之前大量「画面不对」的判断其实是在相机尚未到位时
拍的照片。SETTLE_MS 必须给到阻尼真正收敛。

用法:
  npm run shoot                              # 默认机位，桌面视口
  npm run shoot -- --out docs/screenshots    # 指定输出目录
  npm run shoot -- --viewports               # 追加手机/平板视口
  npm run shoot -- --url http://localhost:4173/
"""
import argparse
import os
import sys

from playwright.sync_api import sync_playwright

# 相机阻尼收敛时间。见上方说明。
SETTLE_MS = 15000

# 机位：(标识, x, z)
# 选取原则：覆盖出生点、主街、横街、城区内部、港区边界 ——
# 每一类都对应一种「相机与建筑的空间关系」。
POSITIONS = [
    ("spawn",      6, 14),
    ("plaza",      2, 20),
    ("main-st",    40, 120),
    ("cross-w",    12, 140),
    ("cross-e",    98, 140),
    ("block",      -30, 120),
    ("harbor-e",   110, 30),
]

VIEWPORTS = {
    "desktop": (1280, 720),
    "tablet":  (834, 1112),
    "phone":   (390, 844),
}

JS_STATE = """() => {
  if (!window.__HD2D__) return {ready:false};
  const s = window.__HD2D__.getState();
  return {ready:true, ...s, pixelSize: window.__HD2D__.pixelSize};
}"""

JS_GL = """() => {
  const c = document.getElementById('scene');
  const g = c.getContext('webgl2') || c.getContext('webgl');
  if (!g) return 'none';
  const d = g.getExtension('WEBGL_debug_renderer_info');
  return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.VERSION);
}"""

ARGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-gpu-sandbox",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:4173/")
    ap.add_argument("--out", default="/tmp/shots")
    ap.add_argument("--viewports", action="store_true", help="追加平板/手机视口")
    ap.add_argument("--positions", action="store_true", help="截全部机位")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    shots = POSITIONS if args.positions else [POSITIONS[0]]
    views = list(VIEWPORTS.items()) if args.viewports else [("desktop", VIEWPORTS["desktop"])]

    with sync_playwright() as p:
        browser = p.chromium.launch(args=ARGS, headless=False, chromium_sandbox=False)
        errors = []

        for vname, (w, h) in views:
            page = browser.new_page(viewport={"width": w, "height": h})
            page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
            page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}")
                    if m.type == "error" else None)

            page.goto(args.url, wait_until="load", timeout=60000)
            try:
                page.wait_for_function(
                    "() => window.__HD2D__ && window.__HD2D__.ready === true",
                    timeout=30000)
            except Exception as e:
                print(f"!! [{vname}] 渲染未就绪:", str(e)[:200])
                page.close()
                continue

            page.wait_for_timeout(3000)
            gl = page.evaluate(JS_GL)
            print(f"[{vname}] {w}x{h}  gl={gl}")

            for label, x, z in shots:
                page.evaluate("([x, z]) => window.__HD2D__.setPlayerPos(x, z)", [x, z])
                page.wait_for_timeout(SETTLE_MS)
                st = page.evaluate(JS_STATE)
                suffix = "" if vname == "desktop" else f"-{vname}"
                path = os.path.join(args.out, f"{label}{suffix}.png")
                page.screenshot(path=path)
                flag = " [穿模!]" if st.get("stuck") else ""
                print(f"   {label:10s} ({st['x']:.0f},{st['z']:.0f}){flag}  -> {path}")

            page.close()

        if errors:
            print("\n--- console ---")
            for e in errors[:25]:
                print(e)
        else:
            print("\n无 JS 错误")

        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
