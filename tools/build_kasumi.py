#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
户山香澄（Kasumi Toyama / Poppin'Party 主唱·吉他手）像素精灵
=================================================================
【TILE=32 的垂直预算 —— 这是本文件最容易出错的地方】
前一版用 `y0 + 22` / `y0 + 28` 这种相对偏移累加，结果：
  y0=8 时裙子画在 y=30（画布只有 0..31）→ 只剩 2 行
  腿画在 y=36 → 完全在画布外，什么都没画出来
于是每个 tile 只到腰就断了，下半身是全透明的，角色读作「漂浮的上半身」。

**现在改成绝对坐标，每个区块的行号写死在布局表里：**

  y  0      留空 1 行（发髻尖的安全边距）
  y  1.. 6  发髻   6 行   ← 最强识别符号，锥形，顶尖
  y  7..16  头部  10 行   ← 头发顶 3 + 脸 6 + 下颌 1
  y 17      脖子   1 行
  y 18..23  躯干   6 行   ← 白衬衫 + 橙连帽衫（袖子同高）
  y 24..27  裙子   4 行   ← 杏色格纹，梯形外扩
  y 28..31  腿+鞋  4 行   ← 白袜 2 行 + 红白高帮 2 行
  ------------------------------------
  合计 32 行，正好铺满，改任何一块都必须重算这张表

【比例是刻意的】头高 10 / 全身 32 ≈ 1:3.2 的Q版比例。
HD-2D 在这个分辨率下，写实比例会让脸只剩 3 个像素格，五官全部消失；
Q版头身比是把有限像素全押在「脸」和「轮廓」上的唯一办法。

【裙色为什么必须比肤色深 —— 这是实测出来的】
初版裙子用官方描述的「杏色」#F0B87C，肤色 #FBD2B0。
两个色的明度只差 4%，在游戏内观感图（96px + 3px 粒度）下**完全分不开**，
裙子读作「裸露的腿」—— 这是比画错细节严重得多的辨识度事故。
像素画里「浅色紧贴浅色」必然糊成一团，所以裙子整体压深压橙，
和肤色拉开足够明度差，格纹用同族深色而不用白。

【形象规格的来源】
沙箱网络无法访问境外立绘图源（bandori.com / fandom / moegirl 全部超时
或被 Cloudflare 拦截）。规格来自多个独立来源交叉验证的公开设定描述：
  · 代表色 #FF5522（橙红）—— 萌娘百科 / fandom 双源一致
  · 茶发、紫瞳 —— 多源一致
  · 「头发在头顶扎成两个锥形发髻，本人自称星形，一眼看去总被
    认为是猫耳；中文圈亦俗称粽子」—— 多源一致
  · 「短刘海被两侧长鬓夹住，长鬓上有红色星星发饰」—— 多源一致
  · 第三季服装：白色衬衫外穿橙色连帽衫（帽绳系成蝴蝶结、右袖两道
    白条纹、左胸红星 logo）、杏色格纹短裙、白袜、红白高帮运动鞋
    —— fandom + 百度百科双源一致

【本文件是原创像素画，非官方素材】仅还原上述可识别的视觉特征。

【输出规格：与 character.js 的图集契约严格一致】
  tile 32 / dirs 4 / rows[down,up,left,right] / frames 4
  整图 1024x128，hero 占最左 4 列。TILE 不变 → 前端零改动。
"""
from PIL import Image
import json

TILE = 32
DIRS, FRAMES = 4, 4

# ---- 垂直布局表（唯一事实来源，所有绘制函数都引用这里的常量）--------
Y_BUN_TOP  = 1# 发髻尖所在行
Y_BUN_BASE = 7      # 发髻底（= 头顶行）
Y_HEAD_TOP = 7      # 头部顶
Y_HEAD_BOT = 16     # 头部底（inclusive）
Y_NECK     = 17
Y_TORSO_TOP= 18
Y_TORSO_BOT= 23
Y_SKIRT_TOP= 24
Y_SKIRT_BOT= 27
Y_LEG_TOP  = 28
Y_LEG_BOT  = 31     # == TILE-1，脚正好踩在画布底

# ---- 水平布局（正面）----------------------------------------------
#【头部宽度从 14 收到 12 —— 剪影实测的结论】
# 初版头是 x9..22（14 列）× 10 行的**方块**，剪影预览里读作「一块砖」，
# 完全看不出是人。原因是：头顶的头发 + 两侧长鬓 + 下面的脸，
# 三者在剪影上是**连通的一整块矩形**，没有任何收窄。
# 现在头顶只占 11 列（x10..20），两颊长鬓向外各探 1 列但**中间断开**，
# 于是剪影上头部是「上窄下宽 + 顶部两个尖」的葫芦形，
# 再叠上两个锥形髻 —— 这才读得出「有头发的人」。
HEAD_X0, HEAD_X1 = 10, 20     # 脸 11 列
HAIR_X0, HAIR_X1 = 9, 21# 头发轮廓 13 列（比脸各宽 1）
SHIRT_X0, SHIRT_X1 = 11, 20     # 衬衫 10
ARM_L, ARM_R = 8, 21            # 袖子外沿（→ x8..10 / x21..23）
SKIRT_X0, SKIRT_X1 = 10, 21     # 裙宽 12

# ------------------------------------------------------------ 调色板
HOOD      = (0xf4, 0x7a, 0x33)   # 橙连帽衫（官方代表色偏橙红）
HOOD_LT   = (0xff, 0x9d, 0x5c)
HOOD_DK   = (0xc4, 0x5c, 0x1e)
SHIRT     = (0xf7, 0xf2, 0xe7)   # 白衬衫
SHIRT_DK  = (0xd8, 0xcf, 0xbe)

HAIR_DK   = (0x5e, 0x36, 0x1d)   # 茶发
HAIR_MD   = (0x8c, 0x58, 0x33)
HAIR_LT   = (0xb8, 0x86, 0x58)

SKIN      = (0xfb, 0xd2, 0xb0)
SKIN_DK   = (0xdd, 0xa5, 0x81)
EYE       = (0x6e, 0x46, 0x8e)   # 紫瞳
EYE_HI    = (0xff, 0xff, 0xff)

STAR      = (0xe8, 0x32, 0x42)   # 星星发饰 / 胸前 logo
STAR_HI   = (0xff, 0x8a, 0x92)

SKIRT     = (0xe0, 0x9a, 0x4e)   # 杏色压深版（见文件头：必须与肤色拉开明度）
SKIRT_DK  = (0xb8, 0x74, 0x30)
SKIRT_CHK = (0xcc, 0x86, 0x3c)   # 格纹深色格（同族深色，不用白）

SOCK      = (0xf4, 0xf1, 0xe8)
SHOE_R    = (0xd8, 0x3c, 0x42)   # 红白高帮
SHOE_W    = (0xf8, 0xf4, 0xea)
SHOE_DK   = (0xa2, 0x26, 0x2c)

GUITAR    = (0xd4, 0x35, 0x40)   # Random Star 红
GUITAR_LT = (0xf2, 0x6c, 0x74)
GUITAR_DK = (0x9e, 0x22, 0x2c)
GUITAR_BR = (0xc0, 0x86, 0x4c)
WHITE     = (0xff, 0xfd, 0xf8)

C = None


def blank():
    return [[C] * TILE for _ in range(TILE)]


def px(g, x, y, c):
    if 0 <= x < TILE and 0 <= y < TILE and c is not None:
        g[y][x] = c


def rect(g, x, y, w, h, c):
    for j in range(y, y + h):
        for i in range(x, x + w):
            px(g, i, j, c)


def hline(g, x, y, w, c):
    for i in range(x, x + w):
        px(g, i, y, c)


def vline(g, x, y, h, c):
    for j in range(y, y + h):
        px(g, x, j, c)


def line(g, x0, y0, x1, y1, c):
    """Bresenham 直线—— 画斜刘海、斜琴颈"""
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        px(g, x0, y0, c)
        if x0 == x1 and y0 == y1:
            break
        e2 = err * 2
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy


# ==================================================================
#  锥形发髻 —— 全角色最强的识别符号，剪影的主角
# ==================================================================
def draw_buns(g, cx_l, cx_r, width=6, height=7):
    """
    两个锥形发髻（俗称猫耳 / 粽子）—— 立在头顶，**绝不能向两侧横伸**。

    【前一版的致命 bug】
    原来按「离底越远越宽」计算半宽，结果髻从头顶向左右横着伸出，
    剪影上完全读作「牛头人」。锥形的定义是**越往上越窄**，底宽顶尖窄。
    正确写法：iu 从 height（底）递减到 1（尖），half = width/2 * iu/height。

    【定位】cx 参数是髻的**中心线**，不是左边缘。

    【本版尺寸】width=6 height=7
      高度 7 = 头高 10 的 0.7 → 够高，剪影上一眼能认；
      但不能再高，否则头顶出画布（Y_BUN_TOP 只留了 1 行余量）。
    两髻中心 11 / 20，各占 x8..14 与 x17..23 →
      中间留x15..16 共 2 行缺口，这个缺口是「两个髻」而非「一坨」的关键。
    """
    y_base = Y_BUN_BASE
    base_half = width // 2
    for cx, tilt in ((cx_l, -1), (cx_r, 1)):
        for iu in range(height, 0, -1):          # iu: height(底) -> 1(尖)
            y = y_base - (height - iu)
            ox = tilt * (height - iu) // 5        # 顶尖最多外移 1px
            half = int(base_half * iu / height)
            col = HAIR_LT if iu > height * 0.5 else HAIR_MD
            if half <= 0:
                px(g, cx + ox, y, HAIR_LT)
            else:
                rect(g, cx + ox - half, y, half * 2 + 1, 1, col)
        # 暗侧（太阳在左上 → 右侧背光）
        vline(g, cx + base_half + tilt, y_base - height + 2, height - 2, HAIR_DK)


def draw_buns_side(g, cx, width=10, height=7, face_right=True):
    """
    侧面的髻结 —— 画一个**宽厚的大髻结**，不是一只髻。

    【侧面髻的宽度必须是 10，不是 6 也不是 7 —— 这是"单根天线"的真正原因】
    物理事实：侧面视角下两个髻是**前后重叠**的，可见宽度 =
    两髻中心距（正面 x11↔x20，相距 9）+ 单髻宽 6 ≈ 10~11 列。
    初版侧面髻只画 6~7 列且贴在头顶偏一侧，剪影上就成了
    「一根斜插的天线」—— 天线的形状特征恰恰是
    **窄 + 斜 + 与头部脱开 + 只有一根**。
    三条全中，所以无论怎么调色都读作天线。
    修法：宽 10（half=5），底部横跨后脑整个宽度，
    顶尖也保留 2px 宽（重叠的两个髻顶尖是并排的，不是两个尖也不是一个针尖）。

    髻底要与后发**重叠 1~2 行**（y_base = Y_BUN_BASE + 1）——
    重叠是「它长在头上」的唯一视觉证据，脱开就变成插在头上的棍子。
    """
    y_base = Y_BUN_BASE + 1        # 髻底比正面低 1 行 → 与后发重叠
    base_half = width // 2
    lean = -1 if face_right else 1             # 髻尖往脑后偏（最多 1px）
    for iu in range(height, 0, -1):
        y = y_base - (height - iu)
        ox = lean * (height - iu) // 6
        # 顶尖保底 2px 宽，不收到针尖 —— 两个髻重叠后顶尖是并排的两点
        half = max(1, int(base_half * iu / height))
        col = HAIR_LT if iu > height * 0.5 else HAIR_MD
        rect(g, cx + ox - half, y, half * 2 + 1, 1, col)
    vline(g, cx + base_half - lean, y_base - height + 2, height - 2, HAIR_DK)


# ==================================================================
#  星形吉他 Random Star
# ==================================================================
def draw_guitar(g, cx, cy, d=1):
    """
    小型星形吉他，挂在腰侧，**允许部分超出身体轮廓**。

    【五次迭代 —— 每一版错在哪】
      v1 琴身 11x12、放腰线正中央 → 整个上半身被涂红，橙衣白衬衫一点不露，
          角色读作「一块红板」
      v2 琴身 9x8、放腰线中央     → 上半身保住了，但琴身正好压在裙子上，
          格纹裙和白袜全被盖住，读作「抱着红色大木板」
      v3 琴身 6x5 + 琴颈 6px 斜线 → 裙子露出来了，但**琴颈在游戏内观感下
          读作「天线 / 长棍」**，一根从腰间斜插出来的孤立斜线，
          既不像琴颈也不像任何东西，纯属噪声，还把剪影搞脏。
      v4 琴身 6x5 + 短琴颈 → 噪声去掉了，但**红色面积仍然过大**：
          6x5=30px² 的纯红压在只有 10 列宽的躯干上，占了 1/4 画面。
          而整个角色的配色是橙 + 白 + 棕，红色在其中极其扎眼，
          结果角色读作「穿红衣服的人」，而不是
          「穿橙白衣服、抱红吉他的人」—— 主次颠倒。
      v5（当前）琴身 4x4、位置移到**躯干轮廓外缘**（面朝侧）→
          红色面积降到 16px²，且一半露在身体之外，
          在剪影上读作「腰间突出的一小块」—— 这正是抱乐器时
          剪影上唯一可辨的特征。躯干主体完全露出。

    【尺度判据】
    屏幕上一个 sprite 只有约 11 个像素格宽，4px 的琴身只剩 1 格。
    1 格宽的琴身读不出「吉他」，所以**必须放弃形状、只保留色块关系**：
    纯红 + 中央 1px 白点。这是像素画的负空间造型 ——
    少画形状，多用「红 vs 橙白」的对比表意。
    琴颈在这个尺度下 1px 都给不起，直接省略（v3 的教训）。

    d = +1 面朝右（琴身放右侧），-1 面朝左
    """
    w, h = 4, 4
    x0, y0 = cx - w // 2, cy - h // 2
    # 琴身：八角形轮廓（比方块更像吉他琴身，又不增加像素）
    rect(g, x0, y0 + 1, w, h - 2, GUITAR)
    rect(g, x0 + 1, y0, w - 2, h, GUITAR)
    px(g, x0, y0 + 1, GUITAR_LT)                   # 受光侧
    px(g, x0 + w - 1, y0 + h - 2, GUITAR_DK)        # 背光侧
    px(g, cx, cy, WHITE)                            # 中央星（1px）
    px(g, cx + d, cy, WHITE)                # 星的横向一点，让它读成十字


def draw_star_logo(g, x, y):
    """左胸红星 logo（官方设定）。3px 的十字星是像素画里最小的可读星形。"""
    px(g, x, y - 1, STAR)
    hline(g, x - 1, y, 3, STAR)
    px(g, x, y + 1, STAR)
    px(g, x, y, STAR_HI)


# ==================================================================
#  下半身
# ==================================================================
def draw_skirt(g, y=Y_SKIRT_TOP, x0=SKIRT_X0, x1=SKIRT_X1, flare=1):
    """
    杏色格纹短裙。y 为裙顶行。

    梯形外扩：裙摆比腰宽 1px，这是「短裙」的形状关键。
    裙内画竖向褶线（SKIRT_DK）+ 3px 周期格纹，两种纹理叠在一起
    才不会读成一块纯色板。
    """
    h = Y_SKIRT_BOT - y + 1
    w = x1 - x0 + 1
    rect(g, x0, y, w, h, SKIRT)
    # 竖向褶线
    for fx in range(x0 + 2, x1 - 1, 4):
        vline(g, fx, y + 1, h - 1, SKIRT_DK)
    # 格纹
    for k in range(0, w - 1, 3):
        for j in range(1, h - 1, 3):
            px(g, x0 + k, y + j, SKIRT_CHK)
            px(g, x0 + k + 1, y + j, SKIRT_CHK)
    # 裙摆外扩的斜角
    if flare:
        px(g, x0 - 1, y + h - 1, SKIRT)
        px(g, x1 + 1, y + h - 1, SKIRT)
    hline(g, x0, y, w, SKIRT_DK)                # 腰头
    hline(g, x0, y + h - 1, w + 2, SKIRT_DK)    # 裙摆底（加宽以覆盖外扩）


def draw_legs(g, y=Y_LEG_TOP, apart=True, x_l=12, x_r=18):
    """
    白袜 + 红白高帮运动鞋。y = 袜口行。

    4 行分配：袜 2 行(y, y+1) + 鞋 2 行(y+2, y+3)。
    鞋比袜宽 1px 且左右各外扩 1px —— 高帮运动鞋的形状全在这点宽度差上。
    白色鞋头横条让红鞋不至于读作「红方块」。
    """
    if apart:
        lsock, rsock = x_l, x_r
        lshoe, rshoe = x_l - 1, x_r - 1
    else:
        lsock, rsock = x_l + 1, x_r - 1
        lshoe, rshoe = x_l, x_r - 2
    rect(g, lsock, y, 2, 2, SOCK)
    rect(g, rsock, y, 2, 2, SOCK)
    hline(g, lsock, y + 1, 2, SOCK)
    hline(g, rsock, y + 1, 2, SOCK)
    # 鞋
    rect(g, lshoe, y + 2, 4, 2, SHOE_R)
    rect(g, rshoe, y + 2, 4, 2, SHOE_R)
    hline(g, lshoe, y + 2, 4, SHOE_W)
    hline(g, rshoe, y + 2, 4, SHOE_W)
    vline(g, lshoe, y + 2, 2, SHOE_DK)
    vline(g, rshoe + 3, y + 2, 2, SHOE_DK)


def draw_legs_side(g, y=Y_LEG_TOP, face_right=True):
    """
    侧面的腿：前后各一条，靠**横向错位 + 高度差**读出前后关系。
    后腿压暗 1 档（处于阴影中），这是唯一的深度线索。

    【两条腿必须横向错开 ≥3px，否则下半身糊成一块橙】
    初版后腿 x=12、前腿 x=15 看似错开，但侧面裙摆是 x11..20，
    后腿 x12..14 **完全落在裙子投影内**，三条腿叠在同一条橙色带子里，
    游戏观感下整条下半身糊成一块 → 读作「穿长袍」而不是「穿短裙」。
    现在后腿 x=11、前腿 x=16，中间留2 列空隙，两条腿都能数出来。
    """
    bx = 11 if face_right else 17              # 后腿（靠画面外侧）
    fx = 16 if face_right else 13              # 前腿
    rect(g, bx, y, 3, 2, SOCK)
    rect(g, fx, y, 3, 2, SOCK)
    hline(g, bx, y + 1, 3, SHIRT_DK)                 # 后腿在阴影里
    rect(g, bx - 1, y + 2, 4, 2, SHOE_DK)           # 后鞋压暗
    rect(g, fx - 1, y + 2, 4, 2, SHOE_R)            # 前鞋
    hline(g, fx - 1, y + 2, 4, SHOE_W)
    px(g, fx + 2, y + 3, SHOE_R)                    # 前脚鞋尖略探出


# ==================================================================
#  躯干（正面 / 背面共用）
# ==================================================================
def draw_torso(g, star=True):
    """脖子 + 白衬衫 + 橙色连帽衫。返回腰线行号。"""
    rect(g, 14, Y_NECK, 4, 1, SKIN_DK)                    # 脖子
    hline(g, 14, Y_NECK, 4, SKIN)
    # 白衬衫主体
    rect(g, SHIRT_X0, Y_TORSO_TOP, SHIRT_X1 - SHIRT_X0 + 1,
         Y_TORSO_BOT - Y_TORSO_TOP + 1, SHIRT)
    vline(g, SHIRT_X0, Y_TORSO_TOP, 6, SHIRT_DK)          # 衬衫阴影侧
    vline(g, SHIRT_X1, Y_TORSO_TOP, 6, SHIRT_DK)
    px(g, 15, Y_TORSO_TOP, SHIRT_DK)                      # 门襟
    px(g, 16, Y_TORSO_TOP, SHIRT_DK)
    # 橙色连帽衫：两侧袖子 + 帽檐压住衬衫边缘
    rect(g, ARM_L, Y_TORSO_TOP, 3, 6, HOOD)
    rect(g, ARM_R, Y_TORSO_TOP, 3, 6, HOOD)
    hline(g, ARM_L, Y_TORSO_TOP, 3, HOOD_LT)
    hline(g, ARM_R, Y_TORSO_TOP, 3, HOOD_LT)
    vline(g, ARM_L, Y_TORSO_TOP, 6, HOOD_DK)
    vline(g, ARM_R + 2, Y_TORSO_TOP, 6, HOOD_DK)
    px(g, ARM_L + 2, Y_TORSO_TOP, HOOD_DK)                # 帽檐
    px(g, ARM_R, Y_TORSO_TOP, HOOD_DK)
    if star:
        draw_star_logo(g, 18, 19)                          # 左胸红星
    # 右袖两道白条纹（官方设定）
    hline(g, ARM_R, 20, 2, SHIRT)
    hline(g, ARM_R, 22, 2, SHIRT)
    # 袖口露出的手
    rect(g, ARM_L, Y_TORSO_BOT - 1, 3, 2, SKIN)
    rect(g, ARM_R, Y_TORSO_BOT - 1, 3, 2, SKIN)
    hline(g, ARM_L, Y_TORSO_BOT, 3, SKIN_DK)
    hline(g, ARM_R, Y_TORSO_BOT, 3, SKIN_DK)


# ==================================================================
#  朝向
# ==================================================================
def draw_down(f):
    """正面：斜刘海 + 两颊长鬓 + 红色星星发饰 + 腰侧星形吉他"""
    g = blank()
    bob = -1 if f in (1, 3) else 0        # 「并腿」相位身体抬高 1px（标准walk cycle）

    def Y(base):
        return base + bob

    draw_buns(g, 11, 20)

    # ---- 头：先画脸，再画头发（两者的宽度不同，这是剪影收窄的关键）----
    # 【画法顺序不能反】
    # 先铺脸（x10..20）再铺头发（x9..21），头发自然在脸颊两侧探出 1 列，
    # 剪影上就形成了「上宽（头发）→ 下窄（下颌）」的收窄。
    # 反过来先铺头发再挖脸，就会得到一个等宽的方块 —— 这正是初版的形状。
    rect(g, HEAD_X0, Y(Y_HEAD_TOP), HEAD_X1 - HEAD_X0 + 1,
         Y_HEAD_BOT - Y_HEAD_TOP + 1, SKIN)
    hline(g, 13, Y(Y_HEAD_BOT), 5, SKIN_DK)                 # 下颌阴影
    px(g, 12, Y(Y_HEAD_BOT), SKIN)
    px(g, 19, Y(Y_HEAD_BOT), SKIN)

    # 头发主体：比脸宽 1 列，但**只到耳朵高度**（y7..13），下方留出下颌
    rect(g, HAIR_X0, Y(Y_HEAD_TOP), HAIR_X1 - HAIR_X0 + 1, 7, HAIR_MD)
    hline(g, HAIR_X0 + 1, Y(Y_HEAD_TOP) + 1, 11, HAIR_LT)
    # 斜刘海：右上 → 左下侧扫（官方是斜刘海，不是齐刘海）
    line(g, 20, Y(Y_HEAD_TOP) + 1, 11, Y(Y_HEAD_TOP) + 5, HAIR_MD)
    line(g, 19, Y(Y_HEAD_TOP) + 2, 12, Y(Y_HEAD_TOP) + 5, HAIR_LT)
    line(g, 13, Y(Y_HEAD_TOP) + 5, 11, Y(Y_HEAD_TOP) + 6, HAIR_DK)
    # 两颊长鬓：夹住脸垂到下颌，但**与头顶发之间留1px 断开**，
    # 这道断口让剪影上头部不再是一整块
    rect(g, HAIR_X0, Y(Y_HEAD_TOP) + 5, 2, 5, HAIR_MD)
    rect(g, HAIR_X1 - 1, Y(Y_HEAD_TOP) + 5, 2, 5, HAIR_MD)
    vline(g, HAIR_X0, Y(Y_HEAD_TOP) + 7, 3, HAIR_DK)
    vline(g, HAIR_X1, Y(Y_HEAD_TOP) + 7, 3, HAIR_DK)
    # 长鬓上的红色星星发饰（官方设定：长鬓两侧各一）
    for sx in (HAIR_X0, HAIR_X1 - 1):
        px(g, sx, Y(Y_HEAD_TOP) + 4, STAR)
        px(g, sx - 1, Y(Y_HEAD_TOP) + 4, STAR)
        px(g, sx + 1, Y(Y_HEAD_TOP) + 4, STAR)
        px(g, sx, Y(Y_HEAD_TOP) + 3, STAR_HI)
    # 五官：紫瞳 + 白高光（高光让眼睛「有神」，是辨识度的关键细节）
    for ex in (12, 17):
        rect(g, ex, Y(12), 2, 2, EYE)
        px(g, ex, Y(12), EYE_HI)
        hline(g, ex, Y(11), 2, HAIR_DK)                # 眉
    px(g, 15, Y(14), SKIN_DK)                # 嘴
    px(g, 16, Y(14), SKIN_DK)

    draw_torso(g)
    draw_skirt(g, Y(Y_SKIRT_TOP))
    draw_legs(g, Y_LEG_TOP, apart=(f in (0, 2)))
    draw_guitar(g, 22, Y(22), d=1)                       # 挂右腰外缘，露出躯干
    return g


def draw_up(f):
    """背面：后脑分层受光，髻的剪影同样立起；吉他背带 ×2"""
    g = blank()
    bob = -1 if f in (1, 3) else 0

    def Y(base):
        return base + bob

    draw_buns(g, 11, 20)

    # ---- 后脑：整块头发，无五官 ----
    rect(g, HEAD_X0 - 2, Y(Y_HEAD_TOP), 18, Y_HEAD_BOT - Y_HEAD_TOP + 1, HAIR_MD)
    rect(g, HEAD_X0 - 2, Y(Y_HEAD_TOP), 18, 3, HAIR_DK)
    hline(g, HEAD_X0, Y(Y_HEAD_TOP) + 4, 14, HAIR_LT)     # 受光带
    hline(g, HEAD_X0 + 1, Y(Y_HEAD_TOP) + 5, 12, HAIR_LT)
    hline(g, HEAD_X0, Y(Y_HEAD_TOP) + 6, 14, HAIR_MD)
    hline(g, HEAD_X0 + 1, Y(Y_HEAD_BOT) - 1, 12, HAIR_DK)
    for vx in (HEAD_X0 + 2, HEAD_X0 + 6, HEAD_X0 + 10):# 发绺
        vline(g, vx, Y(Y_HEAD_TOP) + 7, 3, HAIR_DK)
    # 长鬓（背面也垂下来）
    rect(g, HEAD_X0 - 2, Y(Y_HEAD_TOP) + 2, 2, 8, HAIR_MD)
    rect(g, HEAD_X1 + 1, Y(Y_HEAD_TOP) + 2, 2, 8, HAIR_MD)
    px(g, HEAD_X0 - 2, Y(Y_HEAD_TOP) + 3, STAR)
    px(g, HEAD_X1 + 2, Y(Y_HEAD_TOP) + 3, STAR)

    draw_torso(g, star=False)
    # 吉他背带：两条从肩到腰的对角线（背面当然看得到背带）
    for k in range(8):
        px(g, 12 + k, Y(18) + k, HOOD_DK)
        px(g, 19 - k, Y(18) + k, HOOD_DK)
    draw_skirt(g, Y(Y_SKIRT_TOP))
    draw_legs(g, Y_LEG_TOP, apart=(f in (0, 2)))
    # 背面只露出琴身下缘的一小块（琴身主体被身体挡住，这是正确的遮挡关系）
    px(g, 10, Y(24), GUITAR)
    px(g, 9, Y(25), GUITAR_DK)
    px(g, 8, Y(23), GUITAR_BR)               # 短琴颈，不再画长斜线
    px(g, 7, Y(22), GUITAR_BR)
    return g


def draw_side(f, face_right=True):
    """侧面：脸偏向面朝方向，单眼 + 单髻 + 身前斜抱的吉他"""
    g = blank()
    bob = -1 if f in (1, 3) else 0

    def Y(base):
        return base + bob

    # 侧面只见一个重叠的宽髻结，中心落在后脑（后发 x10..15，髻宽 10 → x8..18）
    draw_buns_side(g, 13 if face_right else 18, face_right=face_right)

    # ---- 头：脸偏向面朝侧，后发只占脑后 1/3 ----
    # 【后发不能盖到眼睛 —— 这是侧面辨识度的关键】
    # 初版后发从 x10 一直铺到 x17，把整张脸挤成 x18..22 的 5px 窄条，
    # 加上刘海斜扫正好压在眼睛上 → 侧面帧读作「一块棕色的方块」，
    # 完全看不出人在往哪看。
    # 现在后发只占 x10..15（脑后 6 列），脸保留 x16..22 的 7 列，
    # 眼睛落在 x19，有2 列表层空间，侧面朝向一眼可读。
    rect(g, 12, Y(Y_HEAD_TOP), 11, Y_HEAD_BOT - Y_HEAD_TOP + 1, SKIN)
    rect(g, 10, Y(Y_HEAD_TOP), 6, Y_HEAD_BOT - Y_HEAD_TOP + 1, HAIR_MD)   # 后发仅 6 列
    rect(g, 10, Y(Y_HEAD_TOP), 13, 3, HAIR_MD)
    hline(g, 11, Y(Y_HEAD_TOP) + 1, 11, HAIR_LT)
    # 刘海：从额前斜扫向后，只压头顶 3 行，不遮眼睛
    if face_right:
        line(g, 21, Y(Y_HEAD_TOP) + 1, 17, Y(Y_HEAD_TOP) + 3, HAIR_MD)
        line(g, 20, Y(Y_HEAD_TOP) + 2, 18, Y(Y_HEAD_TOP) + 3, HAIR_LT)
    else:
        line(g, 12, Y(Y_HEAD_TOP) + 1, 16, Y(Y_HEAD_TOP) + 3, HAIR_MD)
        line(g, 13, Y(Y_HEAD_TOP) + 2, 15, Y(Y_HEAD_TOP) + 3, HAIR_LT)
    # 近侧长鬓+ 星星发饰（在脸与后发交界处）
    lx = 16 if face_right else 17
    rect(g, lx, Y(Y_HEAD_TOP) + 3, 2, 5, HAIR_MD)
    vline(g, lx, Y(Y_HEAD_TOP) + 5, 3, HAIR_DK)
    px(g, lx, Y(Y_HEAD_TOP) + 3, STAR)
    px(g, lx - 1, Y(Y_HEAD_TOP) + 3, STAR)
    px(g, lx + 1, Y(Y_HEAD_TOP) + 3, STAR)
    # 下颌
    if face_right:
        hline(g, 18, Y(Y_HEAD_BOT), 4, SKIN_DK)
    else:
        hline(g, 11, Y(Y_HEAD_BOT), 4, SKIN_DK)
    # 单眼：贴在脸的前缘，朝向才读得出来
    ex = 19 if face_right else 13
    rect(g, ex, Y(12), 2, 2, EYE)
    px(g, ex, Y(12), EYE_HI)
    hline(g, ex, Y(11), 2, HAIR_DK)
    px(g, ex + 1, Y(14), SKIN_DK)                # 嘴

    # ---- 躯干（侧面窄一截）----
    rect(g, 15, Y(Y_NECK), 3, 1, SKIN_DK)
    hline(g, 15, Y(Y_NECK), 3, SKIN)
    rect(g, 12, Y(Y_TORSO_TOP), 8, 6, SHIRT)
    vline(g, 19, Y(Y_TORSO_TOP), 6, SHIRT_DK)
    rect(g, 9, Y(Y_TORSO_TOP), 3, 6, HOOD)               # 远侧手臂（摆到身后）
    rect(g, 20, Y(Y_TORSO_TOP), 3, 6, HOOD)              # 近侧手臂
    hline(g, 9, Y(Y_TORSO_TOP), 3, HOOD_LT)
    hline(g, 20, Y(Y_TORSO_TOP), 3, HOOD_LT)
    vline(g, 9, Y(Y_TORSO_TOP), 6, HOOD_DK)
    vline(g, 22, Y(Y_TORSO_TOP), 6, HOOD_DK)
    px(g, 12, Y(Y_TORSO_TOP), HOOD_DK)
    draw_star_logo(g, 17, 19)
    rect(g, 9, Y(Y_TORSO_BOT) - 1, 3, 2, SKIN)
    rect(g, 20, Y(Y_TORSO_BOT) - 1, 3, 2, SKIN)

    # 侧面裙摆收窄到 x13..18（正面是 x10..21 的 12列）：
    # 侧面视角下裙子的投影宽度约为正面的 60%，这是透视的正确表现；
    # 也让 x11..12 与 x19..20 两条腿露在裙外，剪影上能数出两条腿。
    draw_skirt(g, Y(Y_SKIRT_TOP), x0=13, x1=18, flare=0)
    draw_legs_side(g, Y_LEG_TOP, face_right)
    draw_guitar(g, 21 if face_right else 10, Y(22), d=1 if face_right else -1)

    if not face_right:
        g = [list(reversed(row)) for row in g]
    return g


# ==================================================================
#  组装
# ==================================================================
atlas16 = Image.open('/tmp/cast_backup.png').convert('RGBA')
atlas32 = Image.new('RGBA', (TILE * 8 * FRAMES, TILE * DIRS), (0, 0, 0, 0))

drawers = [
    [draw_down(0), draw_down(1), draw_down(2), draw_down(3)],
    [draw_up(0), draw_up(1), draw_up(2), draw_up(3)],
    [draw_side(0, False), draw_side(1, False), draw_side(2, False), draw_side(3, False)],
    [draw_side(0, True), draw_side(1, True), draw_side(2, True), draw_side(3, True)],
]
for row, frames in enumerate(drawers):
    for col, grid in enumerate(frames):
        tile = Image.new('RGBA', (TILE, TILE), (0, 0, 0, 0))
        tp = tile.load()
        for y in range(TILE):
            for x in range(TILE):
                c = grid[y][x]
                if c is not None:
                    tp[x, y] = (c[0], c[1], c[2], 255)
        atlas32.paste(tile, (col * TILE, row * TILE))

npc_src = [0, 1, 2, 4, 5, 7, 9]
for ci, sc in enumerate(npc_src):
    base_x = (ci + 1) * 4 * TILE
    for f in range(4):
        for row in range(DIRS):
            src = atlas16.crop(((sc * 4 + f) * 16, row * 16,
                                (sc * 4 + f + 1) * 16, (row + 1) * 16))
            atlas32.paste(src.resize((TILE, TILE), Image.NEAREST),
                          (base_x + f * TILE, row * TILE))

atlas32.save('public/assets/chars/cast.png')

meta = {
    'tile': TILE, 'dirs': DIRS, 'frames': FRAMES,
    'cast': ['kasumi_toyama'] + ['ch_%02d' % c for c in npc_src],
    'rows': ['down', 'up', 'left', 'right'],
    'license': 'hero: original pixel art, hand-coded in tools/build_kasumi.py; '
               'NPC: Kenney Roguelike Characters (CC0) - kenney.nl',
    'note': 'hero = 户山香澄 (Kasumi Toyama, BanG Dream!) — 依公开设定重绘，非官方素材'
}
with open('public/assets/chars/cast.json', 'w', encoding='utf-8') as fp:
    json.dump(meta, fp, ensure_ascii=False, indent=2)

# ---- 验证图1：上色预览（放大 8 倍）--------------------------------
S = 8
prev = Image.new('RGBA', (TILE * 4 * S, TILE * 4 * S), (0x2a, 0x33, 0x40, 255))
# ---- 验证图 2：剪影预览（专看轮廓能否认出角色）--------------------
sil = Image.new('RGBA', (TILE * 4 * S, TILE * 4 * S), (0xf2, 0xf2, 0xf2, 255))
# ---- 验证图 3：游戏内实际观感模拟（缩到 ~100px 再按 PIXEL_SIZE=3 像素化）----
SIM_H = 96
sim_cell = 3
sim = Image.new('RGBA', (4 * SIM_H, 4 * SIM_H), (0x2a, 0x33, 0x40, 255))

for row in range(4):
    for col in range(4):
        t = atlas32.crop((col * TILE, row * TILE,
                          (col + 1) * TILE, (row + 1) * TILE)).resize(
            (TILE * S, TILE * S), Image.NEAREST)
        prev.alpha_composite(t, (col * TILE * S, row * TILE * S))
        black = Image.new('RGBA', t.size, (0, 0, 0, 255))
        black.putalpha(t.split()[3])
        sil.alpha_composite(black, (col * TILE * S, row * TILE * S))

        # 游戏内观感：等比缩到 SIM_H 高 → 按 3px 粒度量化
        small = t.resize((SIM_H, SIM_H), Image.LANCZOS)
        q = Image.new('RGBA', (SIM_H, SIM_H))
        for yy in range(0, SIM_H, sim_cell):
            for xx in range(0, SIM_H, sim_cell):
                q.paste(small.crop((xx, yy, xx + sim_cell, yy + sim_cell)),
                        (xx, yy))
        sim.alpha_composite(q, (col * SIM_H, row * SIM_H))

prev.convert('RGB').save('/tmp/kasumi_v2.png')
sil.convert('RGB').save('/tmp/kasumi_sil.png')
sim.convert('RGB').save('/tmp/kasumi_game.png')

# ---- 自检：确认每个 tile 都有内容且没有纵向溢出 ---------------------
ok = True
for row in range(4):
    for col in range(4):
        box = atlas32.crop((col * TILE, row * TILE,
                            (col + 1) * TILE, (row + 1) * TILE)).split()[3].getbbox()
        if box is None:
            print('  !! 空 tile row=%d col=%d' % (row, col)); ok = False
            continue
        top, bot = box[1], box[3] - 1
        flag = '' if (top <= 2 and bot >= 29) else '  <== 纵向未占满!'
        if flag:
            ok = False
        print('  row=%d col=%d  内容行 %2d..%2d%s' % (row, col, top, bot, flag))
print('done: /tmp/kasumi_v2.png /tmp/kasumi_sil.png /tmp/kasumi_game.png',
      '' if ok else '(有告警)')
