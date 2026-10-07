#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
户山香橙（codex-pet 宠物包）精灵集成
=================================================================
【来源】
codex-pet.org 宠物包 kasumi-orange
  https://codex-pet.org/zh/pets/kasumi-orange/
  作者 lincoco · sourceId: kasumi-orange
  素材：assets.codex-pet.org/76e82e60-.../codex-pets-net/kasumi-orange/spritesheet.webp
用户已明确授权直接使用该素材。

【原图规格】
  1536 x 1872 RGBA，网格 8 列 x 9 行，格子 192 x 208
  = 72 帧，9 个动画状态，每帧内容顶部对齐在 y=5（基线统一）

  行 0 待机    行 1 向左走   行 2 向右走   行 3 挥手   行 4 跳跃
  行 5 失败    行 6 等待     行 7 奔跑     行 8 审阅

【输出规格：与 character.js 的图集契约严格一致】
  tile 32 / dirs 4 / rows[down,up,left,right] / frames 4
  整图 1024x128，hero 占最左 4 列 → 前端零改动

【关键处理：背面（up）方向】
原素材 72 帧**全是正面或侧面，没有背面**。这是硬缺口，
不能靠「猜」补上。方案：
  取正面待机帧 →水平镜像（吉他从右腰换到左腰，产生新的左右关系）
  → 整体压暗 22%（后脑勺在场景光照里处于背光面）
  → 用镜像帧补足4 帧循环
压暗是关键：同样的剪影，明的读作「正面」，暗的读作「背面」。
观众读的是光影，不是五官有没有露出来。
"""
from PIL import Image
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cast_source import build_sheet

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---- 目录契约（与 build_cast.py 保持一致）--------------------------
# 源素材：香橙的 spritesheet 由下载步骤放到 assets-source/hero/，
# 之前写死在 /tmp/pet_dl —— /tmp 会被清理，等于这条管线不可复现。
SRC_DIR = os.environ.get(
    'KASUMI_SHEET',
    os.path.join(ROOT, 'assets-source', 'hero', 'sheet.png')
)
SHEET = SRC_DIR

# 产物：图集进public（运行时真正要加载的只有它），
# 元数据进 assets-source（运行时没有任何 fetch 引用，放public 只是白下载）。
OUT_DIR = os.path.join(ROOT, 'public', 'assets', 'chars')
OUT_PNG = os.path.join(OUT_DIR, 'cast.png')
OUT_JSON = os.path.join(ROOT, 'assets-source', 'cast.meta.json')

# NPC 用的 Kenney 16x16 源图（与 build_cast.py 同一份素材）
NPC_SRC_DIR = os.path.join(ROOT, 'assets-source', 'cast')

# 验证图输出到构建目录下的 preview/，不污染源码树
PREVIEW_DIR = os.path.join(ROOT, 'preview')

TILE = 32
DIRS, FRAMES = 4, 4
SRC_CW, SRC_CH = 192, 208# 原格子
COLS, ROWS = 8, 9

if not os.path.exists(SHEET):
    raise SystemExit(
        '找不到香橙源图：%s\n'
        '该文件来自 codex-pet.org 的 kasumi-orange spritesheet，\n'
        '请放到 assets-source/hero/sheet.png，或用 KASUMI_SHEET 指定路径。' % SHEET
    )

sheet = Image.open(SHEET).convert('RGBA')


def src_frame(row, col):
    """取原图某一帧（192x208 格子）"""
    return sheet.crop((col * SRC_CW, row * SRC_CH,
                       (col + 1) * SRC_CW, (row + 1) * SRC_CH))


# ==================================================================
#  帧选择
# ==================================================================
# 待机行（第 0 行）是正面朝向，取其中 4 帧做 down 的待机/行走循环。
# 该行 6 帧有内容（后 2 帧为空）：c0/c1/c4/c5 是睁眼，c2/c3 是眨眼。
# 眨眼帧穿插在循环里会显得「眨眼」，所以 4 帧全部取睁眼帧。
DOWN_COLS = [0, 1, 4, 5]

# 【左右方向：行号和实际朝向必须逐帧核对，不能照页面标签想当然】
# 页面把行 1 标为「向右跑」、行 2 标为「向左跑」，但实测放大对比后：
#   行 1（208..416）→ 琴头指向右上、身体重心偏右 = **朝右走**
#   行 2（416..624）→ 琴头指向左上、身体重心偏左 = **朝左走**
# 两者与直觉一致，但和「吉他琴头在左边= 朝左」的简化判断相反 ——
# 因为琴头朝向由抱琴姿势决定，不能单独用它判断行走方向，
# 必须看头部朝向和迈步腿。这一条记下来，避免以后再搞反。
LEFT_COLS  = [0, 2, 5, 7]           # 行 2 = 朝左
RIGHT_COLS = [0, 2, 5, 7]           # 行 1 = 朝右

# 背面：镜像 + 压暗（见文件头说明）
BACK_COLS  = DOWN_COLS
BACK_DARK  = 0.78                   # 亮度系数：22% 压暗


def darken(img, k):
    """RGB 乘k，A 通道不变"""
    r, g, b, a = img.split()
    from PIL import ImageEnhance
    return Image.merge('RGBA', (
        r.point(lambda v: min(255, int(v * k))),
        g.point(lambda v: min(255, int(v * k))),
        b.point(lambda v: min(255, int(v * k))),
        a,
    ))


# ==================================================================
#  归一化：把 192x208 的原帧缩到 32x32 tile 并对齐
# ==================================================================
# 【为什么必须先裁到内容 bbox 再缩放】
# 原帧 192x208，但角色内容只有约 157x198，且在格子里左右浮动
# （各帧内容起点 x 从 5 到 26 不等）。
# 直接整格缩放会让每个帧的水平中心不一致 → 走路时角色「左右抖」。
# 正确做法：每帧各自裁到 alpha bbox，再缩放，再按**全局统一的内容框**
# 贴到 tile 里的同一位置。这样 4 帧的站位完全对齐。
#
# 先统计所有要用的帧，取并集 bbox 作为「全局内容框」。
srcs = []
srcs += [(0, c) for c in DOWN_COLS]
srcs += [(1, c) for c in LEFT_COLS]
srcs += [(2, c) for c in RIGHT_COLS]

gminx = gmaxx = gminy = gmaxy = None
for r, c in srcs:
    bb = src_frame(r, c).split()[3].getbbox()
    x0, y0, x1, y1 = bb
    gminx = x0 if gminx is None else min(gminx, x0)
    gmaxx = x1 if gmaxx is None else max(gmaxx, x1)
    gminy = y0 if gminy is None else min(gminy, y0)
    gmaxy = y1 if gmaxy is None else max(gmaxy, y1)
GW, GH = gmaxx - gminx, gmaxy - gminy
print('全局内容框 %dx%d  (行 %d..%d 列 %d..%d)' % (GW, GH, gminy, gmaxy, gminx, gmaxx))


def normalize(frame_img):
    """
    裁到全局内容框 → 等比缩放 → 居中放进 TILE。

    【缩放算法：用 LANCZOS 而非 NEAREST】
    源帧 157px 宽缩到 32px 是 4.9 倍降采样。NEAREST 会直接丢像素，
    细腰、发型丝、五官全部断裂。LANCZOS 是带抗锯齿的降采样，
    能保住细结构的形状，再用 alpha 阈值二值化把边缘做硬 ——
    这样既保住了细节，又维持了像素画的硬边。
    """
    inner = frame_img.crop((gminx, gminy, gmaxx, gmaxy))
    scale = TILE / max(GW, GH)
    nw, nh = max(1, round(GW * scale)), max(1, round(GH * scale))
    small = inner.resize((nw, nh), Image.LANCZOS)
    # alpha 二值化：抗锯齿只用于形状，边缘恢复成硬像素
    r, g, b, a = small.split()
    a = a.point(lambda v: 255 if v > 128 else 0)
    small = Image.merge('RGBA', (r, g, b, a))
    tile = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
    tile.alpha_composite(small, ((TILE - nw) // 2, TILE - nh))
    return tile


def flip_h(img):
    return img.transpose(Image.FLIP_LEFT_RIGHT)


# ==================================================================
#  组装图集
# ==================================================================
atlas16 = Image.open('/tmp/cast_backup.png').convert('RGBA')
atlas = Image.new('RGBA', (TILE * 8 * FRAMES, TILE * DIRS), (0, 0, 0, 0))

# row 0 = down（正面待机）
for i, c in enumerate(DOWN_COLS):
    atlas.paste(normalize(src_frame(0, c)), (i * TILE, 0 * TILE))

# row 1 = up（镜像 + 压暗）
for i, c in enumerate(BACK_COLS):
    t = normalize(darken(src_frame(0, c), BACK_DARK))
    atlas.paste(flip_h(t), (i * TILE, 1 * TILE))

# row 2 = left（朝画面左 = 原图行 2）
for i, c in enumerate(LEFT_COLS):
    atlas.paste(normalize(src_frame(2, c)), (i * TILE, 2 * TILE))

# row 3 = right（朝画面右 = 原图行 1）
for i, c in enumerate(RIGHT_COLS):
    atlas.paste(normalize(src_frame(1, c)), (i * TILE, 3 * TILE))

# NPC（Kenney CC0）排在香橙之后，占第 1~7 个角色的位置。
#
# 【原来这里读/tmp/cast_backup.png —— 那是 build_cast.py 的一次性产物】
# /tmp 会被清理，一旦清掉整条 NPC 管线就断了，而且图集规格一旦调整，
# 两边会静默错位。现在直接从 assets-source/cast/ 现场合成，规格由
# cast_source.py 单一来源保证。
NPC_CAST = ['ch_00', 'ch_01', 'ch_02', 'ch_04', 'ch_05', 'ch_07', 'ch_09']
atlas16, _ = build_sheet(NPC_CAST, NPC_SRC_DIR)
for ci in range(len(NPC_CAST)):
    base_x = (ci + 1) * 4 * TILE
    for f in range(4):
        for row in range(DIRS):
            src = atlas16.crop(((ci * 4 + f) * 16, row * 16,
                                (ci * 4 + f + 1) * 16, (row + 1) * 16))
            atlas.paste(src.resize((TILE, TILE), Image.NEAREST),
                        (base_x + f * TILE, row * TILE))

os.makedirs(OUT_DIR, exist_ok=True)
atlas.save(OUT_PNG)

meta = {
    'tile': TILE, 'dirs': DIRS, 'frames': FRAMES,
    'cast': ['kasumi_toyama'] + NPC_CAST,
    'rows': ['down', 'up', 'left', 'right'],
    'license': ('hero: "kasumi-orange" sprite sheet from codex-pet.org '
                '(author lincoco), used with permission; '
                'NPC: Kenney Roguelike Characters (CC0) - kenney.nl'),
    'note': ('hero = 户山香橙 (Kasumi Toyama, BanG Dream!) — '
             'codex-pet.org 素材；up 方向由 down 镜像压暗合成（原素材无背面帧）')
}
# 元数据不进 public/：运行时没有任何 fetch/load 引用它
with open(OUT_JSON, 'w', encoding='utf-8') as fp:
    json.dump(meta, fp, ensure_ascii=False, indent=2)

# ---- 验证图1：上色预览 8x -----------------------------------------
S = 8
prev = Image.new('RGBA', (TILE * 4 * S, TILE * 4 * S), (0x2a, 0x33, 0x40, 255))
sil = Image.new('RGBA', (TILE * 4 * S, TILE * 4 * S), (0xf2, 0xf2, 0xf2, 255))
# ---- 验证图 2：游戏内观感模拟（96px + 3px 粒度）-------------------
SIM_H = 96
sim = Image.new('RGBA', (4 * SIM_H, 4 * SIM_H), (0x2a, 0x33, 0x40, 255))

for row in range(4):
    for col in range(4):
        t = atlas.crop((col * TILE, row * TILE,
                        (col + 1) * TILE, (row + 1) * TILE)).resize(
            (TILE * S, TILE * S), Image.NEAREST)
        prev.alpha_composite(t, (col * TILE * S, row * TILE * S))
        black = Image.new('RGBA', t.size, (0, 0, 0, 255))
        black.putalpha(t.split()[3])
        sil.alpha_composite(black, (col * TILE * S, row * TILE * S))

        small = t.resize((SIM_H, SIM_H), Image.LANCZOS)
        q = Image.new('RGBA', (SIM_H, SIM_H))
        for yy in range(0, SIM_H, 3):
            for xx in range(0, SIM_H, 3):
                q.paste(small.crop((xx, yy, xx + 3, yy + 3)), (xx, yy))
        sim.alpha_composite(q, (col * SIM_H, row * SIM_H))

os.makedirs(PREVIEW_DIR, exist_ok=True)
prev.convert('RGB').save(os.path.join(PREVIEW_DIR, 'kasumi_v2.png'))
sil.convert('RGB').save(os.path.join(PREVIEW_DIR, 'kasumi_sil.png'))
sim.convert('RGB').save(os.path.join(PREVIEW_DIR, 'kasumi_game.png'))

# ---- 自检---------------------------------------------------------
ok = True
for row in range(4):
    for col in range(4):
        box = atlas.crop((col * TILE, row * TILE,
                          (col + 1) * TILE, (row + 1) * TILE)).split()[3].getbbox()
        if box is None:
            print('  !! 空 tile r%d c%d' % (row, col)); ok = False
            continue
        bottom = box[3] - 1
        if bottom != TILE - 1:
            print('  r%d c%d 内容底 %d != 31（未贴底→ 走路会浮空/沉地）'
                  % (row, col, bottom)); ok = False
print('done', '' if ok else '(有告警)')
