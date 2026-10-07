#!/usr/bin/env python3.11
"""
从 Kenney Roguelike Characters（CC0）切出的 16x16 正面角色，
程序化烘焙成 4 方向 x 4 帧 的行走精灵表。

为什么不用现成动画帧：
  Kenney 这套是「分层部件包」（身体/上衣/头发/装备分离）且只有正面，没有行走帧。
  与其去找另一个包（itch.io / GitHub 在本环境均不可达），不如用像素角色标准的做法 ——
  帧间做 1px 上下位移 + 底部 1px 折叠（压扁），在 16px 尺度下
  这正是手工逐帧动画的等效结果。

方向映射（HD-2D 俯视斜角）：
  down  = 原图（正面朝向相机）
  up    = 原图压暗 + 往冷蓝偏（读作「背对我们」，且与海雾一致）
  left  = 水平镜像
  right = 原图
  水平镜像即可覆盖左右，省掉一套美术。

行顺序固定为 down / up / left / right，与运行时 DIRS 常量一致。
"""
import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "public", "assets", "chars")
OUT_PNG = os.path.join(SRC, "cast.png")
OUT_JSON = os.path.join(SRC, "cast.json")

TILE = 16
DIRS = 4
FRAMES = 4

# 12 个源角色里挑 8 个：够场景用，且控制图集体积
CAST = ["ch_00", "ch_01", "ch_02", "ch_04", "ch_05", "ch_07", "ch_09", "ch_10"]

# 行走帧：站立 / 抬起 / 站立 / 落脚（压扁）
FRAME_BOB = [0, -1, 0, 0]
FRAME_SQUASH = [0, 0, 0, 1]


def shift_bright(px, dim=1.0, cool=0.0):
    """调色：dim 整体明度，cool 往冷蓝偏（背面观感 + 空气透视"""
    r, g, b, a = px
    if cool > 0:
        return (
            int(r * dim * (1 - cool * 0.16)),
            int(g * dim * (1 - cool * 0.04)),
            int(b * dim * (1 + cool * 0.14)),
            a,
        )
    return (int(r * dim), int(g * dim), int(b * dim), a)


def frame_image(src, bob=0, squash=0, flip=False, dim=1.0, cool=0.0):
    """把 16x16 源图变成一帧：位移 / 镜像 / 底部折叠 / 调色"""
    out = Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0))

    # 源像素列表，flip 时先水平翻转
    px = src.load()
    for y in range(TILE):
        for x in range(TILE):
            sx = (TILE - 1 - x) if flip else x
            p = px[sx, y]
            if p[3] == 0:
                continue

            ty = y + bob
            if squash and y / (TILE - 1) > 0.72:
                # 底部约 4 行折叠 72% -> 视觉上「踩地」
                rel = y / (TILE - 1)
                ty = int(round((0.72 + (rel - 0.72) * 0.28) * (TILE - 1))) + bob
            if not (0 <= ty < TILE):
                continue

            out.putpixel((x, ty), shift_bright(p, dim, cool))
    return out


def main():
    os.makedirs(SRC, exist_ok=True)

    sheet = Image.new("RGBA", (TILE * FRAMES * len(CAST), TILE * DIRS), (0, 0, 0, 0))

    for ci, name in enumerate(CAST):
        path = os.path.join(SRC, f"{name}.png")
        src = Image.open(path).convert("RGBA")
        if src.size != (TILE, TILE):
            raise SystemExit(f"{name} 是 {src.size}，应为 {(TILE, TILE)}")

        col_base = ci * TILE * FRAMES
        for f in range(FRAMES):
            bob = FRAME_BOB[f]
            sq = FRAME_SQUASH[f]
            dx = col_base + f * TILE
            # 0 down / 1 up / 2 left / 3 right
            sheet.paste(frame_image(src, bob, sq), (dx, 0))
            sheet.paste(frame_image(src, bob, sq, dim=0.78, cool=1.0), (dx, TILE))
            sheet.paste(frame_image(src, bob, sq, flip=True), (dx, TILE * 2))
            sheet.paste(frame_image(src, bob, sq), (dx, TILE * 3))
        print(f"  + {name}")

    sheet.save(OUT_PNG, optimize=True)

    meta = {
        "tile": TILE,
        "dirs": DIRS,
        "frames": FRAMES,
        "cast": CAST,
        "rows": ["down", "up", "left", "right"],
        "license": "Kenney Roguelike Characters (CC0) - kenney.nl",
    }
    with open(OUT_JSON, "w") as f:
        json.dump(meta, f, indent=2)

    size = os.path.getsize(OUT_PNG)
    print(f"cast.png {sheet.size[0]}x{sheet.size[1]}  {DIRS}dir x {FRAMES}frame x {len(CAST)}cast  {size / 1024:.1f}KB")
    print("cast.json written")


if __name__ == "__main__":
    main()
