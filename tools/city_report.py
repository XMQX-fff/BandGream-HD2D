"""
城区分布诊断 —— 回答「建筑分布协调了吗、类型够多样吗」
================================================================================
【为什么需要这个工具】
「建筑多样化」和「分布协调」都是**视觉印象**，很容易变成自我感觉良好。
必须能给出可量化的答案：

  1. 每种建筑类型实际出现了多少栋、占比多少
     —— 9 种类型如果有一种是 0，另一种占 80%，那「多样化」是假的
  2. 沿街天际线的连续性
     —— 相邻建筑之间有没有大空隙（联排是否成立）
  3. 高度分布
     —— 全部等高读作「一堵平顶的墙」；要有起伏
  4. 建筑是否压到路面上
     —— 偏移算错的话宽房子会骑在马路上

【为什么用标签而不是量几何 —— 这是第一版的教训】
第一版用「登记盒进深」反推类型，报出：
    cottage 79.2%、warehouse 17.9%，另有 5 种类型为 0。
看着像「新建筑没生效」，其实是反推规则本身错了：
  · 带院独栋主体进深 4.0，但登记盒含院墙是 5.92 → 被误判成 warehouse(5.0)
  · 杂物棚进深 2.0，落在 cottage 的容差范围内 → 被吞掉
几何反推在有出挑/院墙时**永远**不可靠。类型必须由工厂自己报出来。

用法:
  xvfb-run -a python3.11 tools/city_report.py http://localhost:8099/
"""
import sys
from collections import Counter

from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a

MAIN_STREET_X = 40
STREET_HALF = 9

JS = """
function () {
  const api = window.__HD2D__;
  return {
    total: api.blockers.length,
    solids: api.blockers.filter(b => b.solid).length,
    tags: api.buildingTags
  };
}
"""

LABEL = {
    "cottage": "民居", "townhouse": "联排民居", "workshop": "工坊",
    "warehouse": "仓库", "tower": "塔楼", "chapel": "教堂",
    "marketStall": "市集棚", "houseWithGarden": "带院独栋", "shed": "杂物棚",
}
ZONE_LABEL = {"main": "主街", "cross": "横街", "perimeter": "街区围合"}


def main():
    with sync_playwright() as p:
        # 【只启动一个浏览器】软渲染下多开一个 Chromium 会把 CPU 抢光
        b = p.chromium.launch(
            headless=False,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                  "--window-size=1280,720"])
        page = b.new_page(viewport={"width": 1280, "height": 720})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_function("() => window.__HD2D__ && window.__HD2D__.ready",
                               timeout=180000)
        page.wait_for_timeout(2500)

        r = page.evaluate(JS)
        tags = r["tags"]
        total = len(tags)

        print("=" * 74)
        print("城区分布诊断")
        print("=" * 74)
        print("遮挡物 %d（实心 %d），建筑 %d 栋"
              % (r["total"], r["solids"], total))
        print()

        # ---- 1. 类型分布 ----
        print("【类型分布】9 种是否都出现")
        cnt = Counter(t["key"] for t in tags)
        for k in ["cottage", "townhouse", "workshop", "warehouse", "tower",
                  "chapel", "marketStall", "houseWithGarden", "shed"]:
            n = cnt.get(k, 0)
            pct = 100.0 * n / total if total else 0
            bar = "#" * int(pct / 2)
            mark = "" if n else "   <<< 未出现"
            print("  %-16s %4d 栋 %5.1f%%  %-28s%s"
                  % (LABEL[k], n, pct, bar, mark))
        missing = [LABEL[k] for k in LABEL if cnt.get(k, 0) == 0]
        # 单一类型超过 55% 读作「换皮」
        top = cnt.most_common(1)[0] if cnt else ("", 0)
        dom = 100.0 * top[1] / total if total else 0
        print()
        print("  最主导：%s %.1f%%%s"
              % (LABEL.get(top[0], top[0]), dom,
                 "   <<< 过于单一，读作换皮" if dom > 55 else ""))
        if missing:
            print("  !! 未出现：%s" % ", ".join(missing))

        # 有效类型数：低于 6 种就谈不上「多样」
        alive = sum(1 for k in LABEL if cnt.get(k, 0) > 0)
        print("  实际生效类型：%d / 9%s"
              % (alive, "" if alive >= 6 else "   <<< 不够多样"))
        print()

        # ---- 2. 分区分布 ----
        print("【分区分布】沿街 vs 街区内部")
        zc = Counter(t["zone"] for t in tags)
        for z, n in zc.most_common():
            print("  %-10s %4d 栋  %5.1f%%" % (ZONE_LABEL.get(z, z), n,
                                              100.0 * n / total if total else 0))
        print()

        # ---- 3. 沿街（主街 / 横街）的类型构成 ----
        # 沿街是玩家主要看到的立面，围合只影响纵深
        for zone in ("main", "cross"):
            sub = [t for t in tags if t["zone"] == zone]
            if not sub:
                print("【%s类型构成】无建筑" % ZONE_LABEL[zone])
                continue
            c = Counter(t["key"] for t in sub)
            parts = ", ".join("%s %d" % (LABEL[k], v)
                              for k, v in c.most_common())
            print("【%s 类型构成】%d 栋" % (ZONE_LABEL[zone], len(sub)))
            print("  %s" % parts)
        print()

        # ---- 4. 沿街天际线连续性（用真实进深算间隙）----
        #
        # 【这里踩过两个坑，都必须避开】
        # 坑1：把横街（zone='cross'）混进来算间隙。
        #   横街是 axis='x'，整排的** z 恒定**、只有 x 在变，
        #   混进按 z 排序的主街序列后，相邻项的 z 差会被算成巨大负值
        #   （实测中位数 -1.90、最大 42.6，看着像联排全重叠）。
        #   所以天际线连续性**只取 zone='main'**。
        # 坑2：阈值用 3.0。
        #   巷口是设计出来的，宽 4 单位，所以 3~5 的间隙都属正常。
        #   用 6 做阈值才能区分「有意留巷」和「排布真的断了」。
        print("【沿街天际线连续性】主街 x=%d 两侧（只取 main，排除横街）"
              % MAIN_STREET_X)
        for side in (-1, 1):
            col = sorted(
                [t for t in tags
                 if t["zone"] == "main"
                 and 3.0 < abs(t["x"] - MAIN_STREET_X) < 26
                 and (t["x"] - MAIN_STREET_X) * side > 0],
                key=lambda t: t["z"])
            if len(col) < 2:
                print("  侧 %+d: 仅 %d 栋，不足以判断联排" % (side, len(col)))
                continue
            gaps = []
            for i in range(1, len(col)):
                g = col[i]["z"] - col[i - 1]["z"] \
                    - col[i - 1]["depth"] / 2 - col[i]["depth"] / 2
                gaps.append(g)
            gaps_sorted = sorted(gaps)
            med = gaps_sorted[len(gaps_sorted) // 2]
            big = [g for g in gaps if g > 6.0]
            # 联排立面的关键指标：贴住的占比。
            # 间隙 < 1.5 视为「山墙贴山墙」，这是联排读作联排的前提。
            #中位 0.6 表示墙缝 0.6 —— 正是 streetRow 里 `cursor += depth + 0.6` 的结果。
            tight = sum(1 for g in gaps if g < 1.5)
            print("  侧 %+d: %3d 栋  间隙 中位 %5.2f 最大 %6.2f  "
                  "断口(>6) %d 处 %s"
                  % (side, len(col), med, max(gaps), len(big),
                     "" if not big else "  <<< 有排布断口"))
            print("       贴住(<1.5) %d/%d = %.0f%%%s"
                  % (tight, len(gaps), 100.0 * tight / len(gaps),
                     "  <<< 联排太松，读作独立房子" if tight / len(gaps) < 0.5
                     else ""))
        print()

        # ---- 4b. 街区密度分布（本轮新增，度量「太密集」）----
        #
        # 【为什么必须新增这一项，而不是继续调「贴住率」】
        # 上一轮的贴住率 66~68%、断口 0 看着完美，
        # 但玩家仍然反馈「摆放太过密集、没有逻辑」——
        # 说明**贴住率根本不是「密集」的正确度量**。
        #
        # 贴住率只沿主街量（zone='main'），
        # 而「太密集」发生在**街区内部**（zone='perimeter'）：
        # 那里每块 20×20 的地四边都塞满房子、墙缝仅 0.8、
        # 地块之间只内缩 3.4 —— 整座城读作一堵连续的墙。
        #
        # 正确的度量是**单位面积内的建筑数**及其分布：
        #   · 平均值高→ 确实太密
        #   · 分布方差小 → 每块地都一样，读作「重复纹理」而非城市
        # 只有同时看这两个，才能区分「密」与「单调」。
        #
        # 【为什么按 BLOCK 分桶而不是逐栋统计】
        # 逐栋会淹掉空间信息 —— 我们要回答的是
        # 「这个位置的地块挤不挤」，不是「这栋房子占多大」。
        block = 20.0
        cells = {}
        for t in tags:
            if t["zone"] != "perimeter":
                continue
            key = (int(t["x"] // block), int(t["z"] // block))
            cells.setdefault(key, []).append(t)
        if cells:
            counts = sorted(len(v) for v in cells.values())
            n_cells = len(counts)
            mean = sum(counts) / n_cells
            med = counts[n_cells // 2]
            var = sum((c - mean) ** 2 for c in counts) / n_cells
            # 变异系数：1.0 表示各街区密度完全一致（单调）
            cv = (var ** 0.5) / mean if mean else 0
            # 每 400 平米（20x20）的栋数换算成「每百平米」
            dens = [c * 100.0 / (block * block) for c in counts]
            print("【街区密度分布】%d 个街区内部地块（不含沿街）" % n_cells)
            print("  每地块栋数：均 %.1f  中位 %d  最小 %d  最大 %d"
                  % (mean, med, counts[0], counts[-1]))
            print("  密度（栋/百平米）：p10 %.2f  中位 %.2f  p90 %.2f"
                  % (dens[n_cells // 10], dens[n_cells // 2],
                     dens[n_cells * 9 // 10]))
            print("  变异系数 %.2f%s"
                  % (cv, "  <<< 密度过于均匀，读作重复纹理而非城市"
                     if cv < 0.25 else ""))
            # 空地块（0 栋）意味着「地图长洞」
            empty = sum(1 for c in counts if c == 0)
            print("  空地块 %d 个%s"
                  % (empty, "  <<< 街区内部有空洞" if empty > n_cells * 0.15
                     else ""))
            # 最高的 5% 算「过密」
            p90 = dens[n_cells * 9 // 10]
            over = sum(1 for d in dens if d > p90 * 1.6)
            print("  过密地块（> p90×1.6）%d 个 = %.0f%%%s"
                  % (over, 100.0 * over / n_cells,
                     "  <<< 局部过密" if over > n_cells * 0.1 else ""))
            print()

        # ---- 5. 高度分布 ----
        tops = sorted(t["top"] for t in tags)
        print("【高度分布】最低 %.1f 最高 %.1f 中位 %.1f"
              % (tops[0], tops[-1], tops[len(tops) // 2]))
        for lo, hi in [(0, 4), (4, 6), (6, 9), (9, 13), (13, 99)]:
            n = sum(1 for t in tops if lo <= t < hi)
            print("    %2d~%-3d : %4d 栋  %s"
                  % (lo, hi, n, "#" * min(40, n // 8)))
        tall = sum(1 for t in tops if t >= 9)
        print("  9 单位以上（塔楼/教堂级）共 %d 栋%s"
              % (tall, "" if tall >= 20 else "   <<< 高地标太少，天际线平"))
        print()

        # ---- 6. 建筑是否压到路面 ----
        print("【建筑与路面的冲突】")
        bad = []
        for t in tags:
            if t["zone"] == "perimeter":
                continue          # 围合不在街上，不适用
            dx = abs(t["x"] - MAIN_STREET_X)
            # 出檐余量：登记盒比墙宽 EAVE*2=1.0（见 buildingTypes.js）。
            # 标签里的 depth 是**墙的进深**，不含出挑，
            # 所以判定要加上出挑，否则会把「正好贴路缘」误报成压路。
            half = t["depth"] / 2 + 0.5
            if dx - half < STREET_HALF:
                bad.append(t)
        print("  压在主街路面上的沿街建筑：%d 栋%s"
              % (len(bad), "  ✓" if not bad else "  <<< 偏移算错"))
        for t in bad[:5]:
            print("     %s @ (%.1f, %.1f) 距街心 %.1f 半宽(含出檐) %.1f"
                  % (LABEL[t["key"]], t["x"], t["z"],
                     abs(t["x"] - MAIN_STREET_X), t["depth"] / 2 + 0.5))
        print()

        if errs:
            print("页面错误 %d 条：%s" % (len(errs), errs[:3]))
        else:
            print("0 个JS 错误")
        b.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())