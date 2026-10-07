#!/usr/bin/env python3.11
"""
从 Kenney Roguelike Characters（CC0）源图烘焙成16x16 精灵表。

【重要 —— 本脚本不产出发布产物】
真正的运行时图集由 import_kasumi_pet.py 生成：香橙主角 + 7 个 NPC，
tile=32、1024x128。本脚本只用来「单独看看这批 Kenney 素材长什么样」，
输出到 assets-source/ 下的预览图，不进public/。

【为什么不能让它写进 public/】
两个脚本曾都写public/assets/chars/cast.png，谁后跑谁赢 ——
于是清理资源时顺手跑了一次本脚本，就把香橙主图整个覆盖成了
纯 Kenney 角色图（图集 41KB -> 11KB，主角当场变回路人）。
「发布产物有且只有一个生成者」是硬约束：
public/assets/chars/cast.png 只由 import_kasumi_pet.py 写。

用法:
  python3.11 tools/build_cast.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cast_source import TILE, DIRS, FRAMES, build_sheet

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---- 输入 / 输出严格分离 ------------------------------------------------
# SRC 是「手工挑出来的源素材」，属于可复现构建的输入，进版本库。
# OUT_PNG 是**开发期预览**，给人不给游戏。
#
# 【之前这里踩过的坑】OUT_PNG 曾经直接写成 os.path.join(SRC, "cast.png")，
# 于是目录迁移后产物被写回源素材目录 —— 源素材和产物混在一处，
# 下次跑构建会把上一轮的产物当成"输入素材"一起提交。
# 后来它又改写 public/assets/chars/cast.png，结果覆盖掉了香橙主图。
# 一个文件只能有一个生成者，否则谁后跑谁赢，且没有任何报错。
SRC = os.path.join(ROOT, "assets-source", "cast")
OUT_DIR = os.path.join(ROOT, "assets-source", "preview")
OUT_PNG = os.path.join(OUT_DIR, "kenney-cast.png")
# cast.meta.json 是构建元数据（图集规格 + 授权信息），**运行时并不加载它**
# （src/ 下没有任何 fetch / load 引用），所以不能放在 public/ 里 ——
# 放进去等于每个访问者都白下载一份用不到的文件。


# 12 个源角色里挑 8 个：够场景用，且控制图集体积。
# 注意这比import_kasumi_pet.py 的 NPC 列表多一个 ch_10 ——
# 那个脚本是「香橙 + 7 NPC」共8 格，这里的第 8 格没有运行时消费者。
# 本脚本只出预览，多一个少一个都无所谓。
CAST = ["ch_00", "ch_01", "ch_02", "ch_04", "ch_05", "ch_07", "ch_09", "ch_10"]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    sheet, used = build_sheet(CAST, SRC)
    for name in used:
        print(f"  + {name}")

    sheet.save(OUT_PNG, optimize=True)

    meta = {
        "note": "Kenney 素材单独预览，非运行时图集。"
                "运行时规格见 import_kasumi_pet.py 生成的记录。",
        "tile": TILE,
        "dirs": DIRS,
        "frames": FRAMES,
        "cast": used,
        "rows": ["down", "up", "left", "right"],
        "license": "Kenney Roguelike Characters (CC0) - kenney.nl",
    }
    with open(os.path.join(OUT_DIR, "kenney-cast.meta.json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    size = os.path.getsize(OUT_PNG)
    print(f"kenney-cast.png {sheet.size[0]}x{sheet.size[1]}  "
          f"{DIRS}dir x {FRAMES}frame x {len(used)}cast  {size / 1024:.1f}KB")
    print(f"  -> {os.path.relpath(OUT_PNG, ROOT)}")
    print("  (开发期预览，不发布；运行时图集由 import_kasumi_pet.py 生成)")


if __name__ == "__main__":
    main()
