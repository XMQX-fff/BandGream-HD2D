"""
发布：把dist/ 同步到 .publish-dist/
================================================================================
【为什么要有这个脚本，而不是手工 cp】

上一轮的 .publish-dist 里还留着 36 个文件：
cobblestone_01_nor_gl_512.jpg、assets/retro/*.png、ch_00~ch_11.png……
这些都在「删除未使用资源」那一轮被删了 —— 游戏现在用程序化 Canvas 贴图，
一张外部贴图都不加载。

但 .publish-dist 没有跟着重建，于是它等于把一堆死文件又发布了一遍。
手工 `cp -r dist/* .publish-dist/` 有两个坑：
  · **不会删除**旧文件（cp 只覆盖同名项）
  · 漏掉时没有任何提示 —— 页面照常运行，只是白挂了 1.5MB 没人要的图

「每次发布文件只能有一个生成者」（见 README）这条约定，
在发布目录上同样成立：这里必须**整目录替换**，不能增量拷贝。

【同步规则】

  保留：package.json —— .cloudstudio 的启动命令需要它声明 start 脚本
  删除：其余全部 —— 包括 sprite-check.html
        它是开发期调试页（tools/sprite-check.html 的副本），
        按项目约定「游戏运行时不会请求 → 不发布」，留着只是白给外人看

用法:
  python3.11 tools/publish.py            # 构建 + 同步
  python3.11 tools/publish.py --no-build # 只同步（已构建过）
"""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
PUBLISH = os.path.join(ROOT, ".publish-dist")

# .cloudstudio 用这个文件声明启动命令，必须原样保留
KEEP = {"package.json"}


def build():
    print("构建...")
    # 走 npm run build 而不是 npx vite build ——
    # 前者会先跑 verify_assets.py（发布产物守卫）。
    # 直接调vite build 就跳过了守卫，
    # 而「图集规格不对时构建失败」正是它存在的意义。
    r = subprocess.run(["npm", "run", "build"], cwd=ROOT,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-3000:])
        print(r.stderr[-3000:])
        sys.exit("构建失败（守卫未通过？）")
    print(r.stdout.strip().splitlines()[-1])


def sync():
    if not os.path.isdir(DIST):
        sys.exit("dist/ 不存在，先构建")

    old = set()
    if os.path.isdir(PUBLISH):
        old = {f for f in os.listdir(PUBLISH)}

    # 整目录替换：先清掉不在 dist 里的顶层项
    for name in old:
        if name in KEEP:
            continue
        p = os.path.join(PUBLISH, name)
        print("  删除 %s" % name)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)

    # 再拷进来
    for name in sorted(os.listdir(DIST)):
        src = os.path.join(DIST, name)
        dst = os.path.join(PUBLISH, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        print("  复制 %s" % name)

    # package.json：只补不改（它的内容属于部署配置，不属于构建产物）
    pj = os.path.join(PUBLISH, "package.json")
    if not os.path.exists(pj):
        with open(pj, "w", encoding="utf-8") as f:
            json.dump({
                "name": "ot2-hd2d-harbor",
                "version": "1.0.0",
                "private": True,
                "scripts": {
                    "start": "python3 -m http.server $PORT --bind 0.0.0.0"
                },
            }, f, indent=2, ensure_ascii=False)
            print("  生成 package.json")

    # ---- 核对：两边必须完全一致（package.json 除外）----
    def listing(base):
        out = set()
        for dirpath, _, files in os.walk(base):
            for f in files:
                rel = os.path.relpath(os.path.join(dirpath, f), base)
                out.add(rel)
        return out

    a, b = listing(DIST), listing(PUBLISH)
    only_pub = b - a - KEEP
    if only_pub:
        sys.exit("发布目录有多余文件未被清掉：%s" % sorted(only_pub))
    if a - b:
        sys.exit("发布目录缺文件：%s" % sorted(a - b))

    total = sum(os.path.getsize(os.path.join(DIST, f))
                for f in a if os.path.isfile(os.path.join(DIST, f)))
    print("\n✓ 已同步 %d 个文件，%.1f KB" % (len(a), total / 1024))


def main():
    if "--no-build" not in sys.argv:
        build()
    print("同步到 .publish-dist/")
    sync()


if __name__ == "__main__":
    main()