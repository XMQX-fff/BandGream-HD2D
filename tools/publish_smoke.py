"""对**发布产物**做冒烟测试 —— 而不是对 dist/
================================================================================
【为什么必须测发布目录，不能拿 dist/ 的测试结果顶】

dist/ 与 .publish-dist/ 内容相同，但**服务根不同**：
前者由 vite preview 从自己的根提供，后者由 .cloudstudio 的
`http.server --directory .publish-dist` 提供。

base 路径算错、hash 文件名对不上、旧文件没清干净 ——
这三类问题**只有在真实服务下才会暴露**。
上一个版本的 .publish-dist 里就躺着 36 个已删除的死文件，
HTTP 200 一切正常，只是白发布 1.5MB 没人要的图。

【所以这个脚本测的是「线上真正会加载的东西」】

断言项与它们的判据：
  · 请求失败   —— 资源路径/404
  · JS 错误    —— 模块加载或运行时异常
  · draw call   —— 合并优化在发布产物里确实生效
  · 角色不卡死  —— 碰撞已修复（盒子曾在 (0,0)，撞不到任何建筑）
  · 淡出系统就位—— fadeStats 能返回

用法:
  python3 -m http.server 3000 --directory .publish-dist &
  xvfb-run -a python3.11 tools/publish_smoke.py
"""
import sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:3000/"
with sync_playwright() as p:
    b = p.chromium.launch(headless=False,
        args=["--use-angle=swiftshader","--enable-unsafe-swiftshader",
              "--no-sandbox","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width":1280,"height":720})
    errs=[]; reqfail=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("requestfailed", lambda r: reqfail.append(r.url))
    pg.goto(URL, timeout=120000)
    pg.wait_for_function("window.__HD2D__ && window.__HD2D__.ready", timeout=120000)
    pg.wait_for_timeout(6000)
    r = pg.evaluate("""()=>{
      const H=window.__HD2D__;
      const s=H.getState();
      const f=H.fadeStats();
      return {
        hero:[+s.x.toFixed(1), +s.z.toFixed(1)],
        stuck: s.stuck,
        before: H.mergeStats.before, after: H.mergeStats.after,
        blockers: H.blockerCount(),
        mergeOk: H.mergeStats.after < H.mergeStats.before/10,
        fadeFading: f ? f.fading.length : null,
      };
    }""")
    pg.screenshot(path="/workspace/docs/screenshots/published_smoke.png")
    b.close()

    print("角色位置:", r["hero"], " 卡死:", r["stuck"])
    print("draw call: %d -> %d  (%s)"
          % (r["before"], r["after"], "压缩达标" if r["mergeOk"] else "未达标"))
    print("遮挡物:", r["blockers"], " 当前淡出:", r["fadeFading"])
    print("JS 错误:", len(errs), errs[:2])
    print("请求失败:", len(reqfail), reqfail[:3])

    # 必须有断言退出码 —— 只打印的话，
    # 这个脚本在 CI/脚本里永远「成功」，等于没有守门
    bad = []
    if errs:
        bad.append("有 JS 错误 %d 条" % len(errs))
    if reqfail:
        bad.append("有请求失败 %d 个" % len(reqfail))
    if not r["mergeOk"]:
        bad.append("draw call 未压缩（%d -> %d）" % (r["before"], r["after"]))
    if r["stuck"]:
        bad.append("角色卡在实心体内 —— 碰撞失效")
    if r["fadeFading"] is None:
        bad.append("fadeStats 没返回 —— 淡出系统未挂载")
    if bad:
        print("\n失败：")
        for x in bad:
            print("  x " + x)
        sys.exit(1)
    print("\n全部通过。")
