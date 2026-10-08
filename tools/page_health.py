"""快速抓页面错误 —— 比等3 分钟的完整诊断快得多

【为什么需要它】
本轮院内填充改动之后，页面 180 秒都没就绪。
完整诊断脚本会一直等 __HD2D__，于是只给一个 TimeoutError，
看不出是「死循环」还是「抛异常」。

定位这类问题必须先看**页面自己报了什么**：
  ·抛异常 → pageerror 有内容，直接能读
  · 死循环 → 没有任何报错，只是永远不ready
两种原因的处理方式完全不同，不能靠等。
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
        pg.on('pageerror', lambda e: errs.append('PAGEERROR: ' + str(e)))
        pg.on('console', lambda m: errs.append('CONSOLE.' + m.type + ': ' + m.text)
              if m.type in ('error', 'warning') else None)
        try:
            pg.goto('http://127.0.0.1:4173/', wait_until='load', timeout=60000)
        except Exception as e:
            errs.append('GOTO: ' + str(e))
        # 只等 20 秒：软渲染本来就慢，但「生成」阶段是同步的，
        # 生成卡住的话20 秒足够暴露。跑满 180 秒只会掩盖问题。
        pg.wait_for_timeout(20000)
        ready = pg.evaluate('!!(window.__HD2D__ && window.__HD2D__.buildingTags)')
        trace = pg.evaluate('window.__GEN_DROP__ ? JSON.stringify(window.__GEN_DROP__) : "null"')
        b.close()

    print('=== 页面健康速查 ===')
    print('  就绪: %s' % ('是' if ready else '否 —— 生成阶段卡住'))
    print('  生成计数: %s' % trace)
    print('  控制台/异常 %d 条' % len(errs))
    for e in errs[:10]:
        print('    ' + e[:400])
    return 0 if ready else 1


if __name__ == '__main__':
    sys.exit(main())