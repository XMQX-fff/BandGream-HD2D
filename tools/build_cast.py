#!/usr/bin/env python3.11
"""
从 Kenney Roguelike Characters（CC0）源图烘焙成 NPC 用的16x16 精灵表。

帧合成逻辑已抽到 cast_source.py，与 import_kasumi_pet.py 共用 ——
原先两边各写一份常量，改一处动画节奏就会跑偏。

用法:
  python3.11 tools/build_cast.py
"""
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cast_source import TILE, DIRS, FRAMES, build_sheet

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---- 输入 / 输出严格分离 ------------------------------------------------
# SRC 是「手工挑出来的源素材」，属于可复现构建的输入，进版本库。
# OUT_DIR 是构建产物，随游戏一起发布。
#
# 【之前这里踩过的坑】OUT_PNG 曾经直接写成 os.path.join(SRC, "cast.png")，
# 于是目录迁移后产物被写回源素材目录 —— 源素材和产物混在一处，
# 下次跑构建会把上一轮的产物当成"输入素材"一起提交。
SRC = os.path.join(ROOT, "assets-source", "cast")
OUT_DIR = os.path.join(ROOT, "public", "assets", "chars")
OUT_PNG = os.path.join(OUT_DIR, "cast.png")
# cast.meta.json 是构建元数据（图集规格 + 授权信息），**运行时并不加载它**
# （src/ 下没有任何 fetch / load 引用），所以不能放在 public/ 里 ——
# 放进去等于每个访问者都白下载一份用不到的文件。
OUT_JSON = os.path.join(ROOT, "assets-source", "cast.meta.json")

# 12 个源角色里挑 8 个：够场景用，且控制图集体积。
# 与 import_kasumi_pet.py 的 NPC 列表保持同源（那边是 7 个 + 香橙主角）。
CAST = ["ch_00", "ch_01", "ch_02", "ch_04", "ch_05", "ch_07", "ch_09", "ch_10"]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    sheet, used = build_sheet(CAST, SRC)
    for name in used:
        print(f"  + {name}")

    sheet.save(OUT_PNG, optimize=True)

    meta = {
        "tile": TILE,
        "dirs": DIRS,
        "frames": FRAMES,
        "cast": used,
        "rows": ["down", "up", "left", "right"],
        "license": "Kenney Roguelike Characters (CC0) - kenney.nl",
    }
    with open(OUT_JSON, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    size = os.path.getsize(OUT_PNG)
    print(f"cast.png {sheet.size[0]}x{sheet.size[1]}  "
          f"{DIRS}dir x {FRAMES}frame x {len(used)}cast  {size / 1024:.1f}KB")
    print(f"  -> {os.path.relpath(OUT_PNG, ROOT)}")
    print(f"  -> {os.path.relpath(OUT_JSON, ROOT)}  (元数据，不发布)")


if __name__ == "__main__":
    main()
