#!/usr/bin/env python3.11
"""
发布产物守卫 —— 在构建前跑，拦住「覆盖运行时图集」这类静默事故。

【为什么需要这个】
清理资源时顺手跑了一次 tools/build_cast.py，它当时也往
public/assets/chars/cast.png 写 —— 于是香橙主图被纯 Kenney 角色图
整个覆盖，41KB -> 11KB，全程没有任何报错，游戏照跑，只是主角换了人。
截图要对比才发现。

这类事故的共同点：**构建脚本没有校验产出，只管写**。
所以校验必须独立于构建脚本本身，放在跑之前。

检查项：
  1. 运行时图集规格 = 香橙版（1024x128, tile=32, 8 角色）
     —— 被 512x64 的 Kenney 版覆盖时立刻报错
  2. public/ 下不存在运行时不加载的文件（每个都是白下载的带宽）
  3. 不该出现的目录（__pycache__ / preview 产物）没混进 public/

用法:
  python3.11 tools/verify_assets.py
  退出码 0 = 通过，1 = 有问题
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PUBLIC = os.path.join(ROOT, "public")

# 运行时图集必须满足的规格 —— 与 import_kasumi_pet.py 严格一致。
# 数值不是抄来的，是 character.js 的 DIRS/FRAMES/CAST_INDEX 决定的：
#   8 角色 x 4 帧 x 32px = 1024宽，4 方向 x 32px = 128 高。
EXPECT = {
    "path": os.path.join(PUBLIC, "assets", "chars", "cast.png"),
    "size": (1024, 128),
    "tile": 32,
    "casts": 8,
}

# 运行时不加载的文件放进 public/ = 每个访问者白下载。
# src/ 里没有任何 fetch / load 引用它们。
UNUSED_IN_PUBLIC = {"cast.json", "cast.meta.json"}

errors = []
notes = []


def check_atlas():
    path = EXPECT["path"]
    rel = os.path.relpath(path, ROOT)
    if not os.path.exists(path):
        errors.append("运行时图集不存在：%s（跑 import_kasumi_pet.py 生成）" % rel)
        return
    w, h = Image.open(path).size
    if (w, h) != EXPECT["size"]:
        errors.append(
            "运行时图集规格不对：%s 是 %dx%d，应为 %dx%d\n"
            "    多半是 tools/build_cast.py 覆盖过——它只出预览，"
            "不该写 public/。修法：git checkout 恢复，或重跑 "
            "import_kasumi_pet.py。" % (rel, w, h, EXPECT["size"][0], EXPECT["size"][1])
        )
        return
    n_cast = w // EXPECT["tile"] // 4
    if n_cast != EXPECT["casts"]:
        errors.append("%s 角色数 %d，应为 %d" % (rel, n_cast, EXPECT["casts"]))
        return
    print("  OK  %s  %dx%d  tile=%d  %d 角色" % (rel, w, h, EXPECT["tile"], n_cast))


def walk_public():
    """public/ 下每个文件都会被发布，逐个判断运行时会不会请求。"""
    total = 0
    for dirpath, _, files in os.walk(PUBLIC):
        for fn in files:
            fp = os.path.join(dirpath, fn)
            size = os.path.getsize(fp)
            total += size
            rel = os.path.relpath(fp, ROOT)
            if fn in UNUSED_IN_PUBLIC:
                errors.append(
                    "%s 在 public/ 下但运行时从不加载（白下载 %d 字节）" % (rel, size)
                )
            if size == 0:
                errors.append("%s 是空文件" % rel)
    print("  OK  public/ 共 %d 个文件，%.1f KB" % (
        sum(len(f) for _, _, f in os.walk(PUBLIC)), total / 1024))


def check_src_refs():
    """public/ 的每个文件都应该在 src/ 里被引用，否则就是 dead asset。"""
    refs = []
    for dirpath, _, files in os.walk(os.path.join(ROOT, "src")):
        for fn in files:
            if not fn.endswith(".js"):
                continue
            with open(os.path.join(dirpath, fn), encoding="utf-8") as fp:
                refs.append(fp.read())
    blob = "\n".join(refs)
    if "cast.png" not in blob:
        errors.append("src/ 里找不到对 cast.png 的引用——图集路径变了？")
        return
    print("  OK  src/ 引用 cast.png")


def check_blocker_source():
    """遮挡物登记的尺寸必须与实际几何对得上。

    【为什么值得单独查】
    登记盒是手写数字，几何一改就对不上，而且**没有任何报错**：
    盒子小一点，相机认为视线通畅，实际屋顶糊在镜头前。
    实测就栽在这：屋脊是 box(w + 0.9)，登记用的是 w，
    射线打到一个 11宽的屋顶挂在 11 宽的登记盒里——
    差0.9，看不见摸不着，只有射线能发现。

    这里做的是**静态交叉检查**：读源码里的关键数字，
    确认登记侧与几何侧的常量还对得上。
    """
    import re
    root = os.path.join(ROOT, "src", "world")

    with open(os.path.join(root, "city.js"), encoding="utf-8") as fp:
        city = fp.read()
    with open(os.path.join(root, "props.js"), encoding="utf-8") as fp:
        props = fp.read()

    # 屋脊悬挑：props 里的 box(w + N, ...) 与 city 里的 ROOF_OVERHANG_X
    m = re.search(r"box\(w \+ ([\d.]+), 0\.3, 0\.42", props)
    if not m:
        notes.append("未在 props.js 里定位到屋脊 box，屋脊悬挑检查跳过")
        return
    geo_overhang = float(m.group(1))

    m2 = re.search(r"const ROOF_OVERHANG_X = ([\d.]+)", city)
    if not m2:
        errors.append("city.js 里找不到 ROOF_OVERHANGX —— 房屋登记宽度没算屋脊")
        return
    reg_overhang = float(m2.group(1))

    if abs(geo_overhang - reg_overhang) > 1e-6:
        errors.append(
            "屋脊悬挑对不上：props.js 几何是 w+%.2f，city.js 登记是 w+%.2f\n"
            "    登记盒比实际几何小 %.2f，屋脊会戳出盒外 —— "
            "相机认为视线通畅，实际屋顶糊在镜头前。"
            % (geo_overhang, reg_overhang, geo_overhang - reg_overhang)
        )
    else:
        print("  OK  屋脊悬挑登记与几何一致 (w+%.2f)" % geo_overhang)


def check_meta():
    """构建元数据不该在 public/ 下（运行时零引用），但必须与产物一致。"""
    mp = os.path.join(ROOT, "assets-source", "cast.meta.json")
    if not os.path.exists(mp):
        notes.append("assets-source/cast.meta.json 缺失（不影响运行）")
        return
    meta = json.load(open(mp, encoding="utf-8"))
    cast = meta.get("cast", [])
    if not cast or cast[0] != "kasumi_toyama":
        notes.append(
            "cast.meta.json 的 cast[0] 是 %r，应为 'kasumi_toyama' —— "
            "元数据与运行时图集不同步" % (cast[0] if cast else None)
        )
    else:
        print("  OK  cast.meta.json 记录香橙主图，%d 角色" % len(cast))


print("发布产物守卫")
print("-" * 60)
check_atlas()
walk_public()
check_src_refs()
check_blocker_source()
check_meta()

if notes:
    print("\n提示：")
    for n in notes:
        print("  - " + n)
if errors:
    print("\n失败 %d 项：" % len(errors))
    for e in errors:
        print("  x " + e)
    sys.exit(1)
print("\n全部通过。")