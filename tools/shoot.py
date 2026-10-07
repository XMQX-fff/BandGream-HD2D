"""
截图自测脚本 —— 用 xvfb + Playwright 截取 WebGL 画面。

关键：本环境的无头 Chrome 只有在 **xvfb-run + headful 模式** 下才能拿到
WebGL2；纯 headless（headless_shell）无论何种 flag 都失败。

用法:
  xvfb-run -a python3.11 tools/shoot.py [url] [out.png]
"""
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shot.png"

JS_STATE = """() => {
  if (!window.__HD2D__) return {ready:false};
  const s = window.__HD2D__.getState();
  return {ready:true, ...s, pixelSize: window.__HD2D__.pixelSize};
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
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    page.goto(URL, wait_until="load", timeout=60000)

    # 等待渲染就绪
    try:
        page.wait_for_function("() => window.__HD2D__ && window.__HD2D__.ready === true", timeout=30000)
    except Exception as e:
        print("!! 渲染未就绪:", str(e)[:200])

    # 给几帧时间渲染纹理与动画
    page.wait_for_timeout(4000)

    state = page.evaluate(JS_STATE)
    print("state:", state)

    # WebGL 确认
    gl = page.evaluate("""() => {
      const c = document.getElementById('scene');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      if (!g) return 'none';
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.VERSION);
    }""")
    print("gl:", gl)

    page.screenshot(path=OUT)
    print("saved:", OUT)

    if errors:
        print("\n--- console ---")
        for e in errors[:25]:
            print(e)

    browser.close()