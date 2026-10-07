#!/usr/bin/env python3.11
"""
Kenney Roguelike Characters（CC0）16x16 源图 -> 4方向 x 4帧 精灵表。

【为什么抽成共享模块】
原先 build_cast.py 和 import_kasumi_pet.py 各写一份帧合成逻辑，
后者还从 /tmp/cast_backup.png 读前者的一次性产物。后果：
  - /tmp 被清理后，整条 NPC 素材管线不可复现；
  - 两份 FRAME_BOB / FRAME_SQUASH 常量各改一处就会跑偏，
    NPC 与备用角色的动画节奏对不上。
现在两者共用本模块，源素材只有一份、动画参数只有一处。

【为什么不用现成动画帧】
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
import os

from PIL import Image

TILE = 16
DIRS = 4
FRAMES = 4

# 行走帧：站立 / 抬起 / 站立 / 落脚（压扁）
FRAME_BOB = [0, -1, 0, 0]
FRAME_SQUASH = [0, 0, 0, 1]

#: assets-source/cast 下实际存在的源角色。
#: 刻意只列这8 个 —— 目录里就只放这 8 个文件，不留「备选素材」。
#: 素材库里多放几个没被任何脚本引用的PNG 是典型的「僵尸资源」：
#: 它们不会被加载、不会被审查，却让后来者以为「这些都可能有用」，
#: 于是不敢删，目录越积越臃肿。需要新角色时从 Kenney 原包补进来即可。
AVAILABLE = ["ch_00", "ch_01", "ch_02", "ch_04", "ch_05", "ch_07", "ch_09", "ch_10"]

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(ROOT, "assets-source", "cast")


def source_path(name, src_dir=None):
    return os.path.join(src_dir or SRC_DIR, f"{name}.png")


def shift_bright(px, dim=1.0, cool=0.0):
    """调色：dim 整体明度，cool 往冷蓝偏（背面观感 + 空气透视）"""
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


def build_sheet(cast, src_dir=None):
    """
    按 cast 列表合成一张 16px 精灵表。

    返回 (sheet, 实际用到的角色名)。缺素材直接抛错而不是静默跳过 ——
    静默跳过会产出「少一列」的图集，运行时 NPC 直接隐形且毫无报错。
    """
    src_dir = src_dir or SRC_DIR
    sheet = Image.new("RGBA", (TILE * FRAMES * len(cast), TILE * DIRS), (0, 0, 0, 0))
    used = []

    for ci, name in enumerate(cast):
        path = source_path(name, src_dir)
        if not os.path.exists(path):
            raise SystemExit(
                f"缺少源素材：{path}\n"
                f"可用角色：{', '.join(AVAILABLE)}\n"
                f"若确实要精简，先把不用的 ch_XX.png 从 assets-source/cast 删掉，"
                f"并同步更新本文件与调用方的角色列表。"
            )
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
        used.append(name)

    return sheet, used
