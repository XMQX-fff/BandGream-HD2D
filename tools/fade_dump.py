"""单点诊断：把某个坐标上「被判定为该淡出」的盒子逐个摊开看
================================================================================
【为什么需要单独一个「摊开看」的工具】

fade_scan.py 报出 (0.3, -14) 处会淡出 **777 栋**（共 1170 栋）。
这在物理上不可能：角色站在一个点，
画面上能盖住它的房子最多两三栋。

「淡出 777 栋」意味着两类可能，排查方向完全相反：
  ① 判定几何算错了（盒子的尺寸/坐标不对）
  ② 盒子本身 gigantic（某个注册调用塞进了一个覆盖全城的盒子）

只看计数区分不了，必须**把盒子逐个打印出来**：
看它们的 minX/maxX/minZ/maxZ/top 到底是什么。
若真有几栋盒子横跨 250 单位，那就是注册端的尺寸 bug；
若盒子都很小却仍被判中，那是判定端的问题。

用法:
  xvfb-run -a python3.11 tools/fade_dump.py <x> <z> [url]
"""
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:5173/"
args = [a for a in sys.argv[1:]]
if args and not args[0].startswith("http"):
    X = float(args[0]); Z = float(args[1])
    URL = args[2] if len(args) > 2 and args[2].startswith("http") else URL
else:
    X, Z = 0.3, -14.0

CAM_Y = 22.0
CAM_DIST = 30.0


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                  "--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 640, "height": 480})
        page.goto(URL, timeout=120000)
        page.wait_for_function("window.__HD2D__ && window.__HD2D__.ready",
                               timeout=120000)
        page.wait_for_timeout(2500)

        rep = page.evaluate(
            """({X, Z, camY, camDist}) => {
          const H = window.__HD2D__;
          const B = H.blockers;
          const ids = H.fadeProbe(X, camY, Z + camDist, X, Z);

          // ---- 全城盒子的尺寸分布 ----
          // 「有没有巨型盒子」是首要怀疑对象，先独立回答它。
          const w = (b) => b.maxX - b.minX;
          const d = (b) => b.maxZ - b.minZ;
          const diag = (b) => Math.max(w(b), d(b));
          let giant = 0, over20 = 0, over60 = 0;
          const giantList = [];
          for (let i = 0; i < B.length; i++) {
            if (diag(B[i]) > 60) { over60++; giantList.push(i); }
            else if (diag(B[i]) > 20) over20++;
            if (diag(B[i]) > 40) giant++;
          }
          giantList.sort((a, b) => diag(B[b]) - diag(B[a]));

          // ---- 命中盒子的明细 ----
          const rows = ids.slice(0, 20).map((i) => {
            const b = B[i];
            return {
              id: i,
              cx: +((b.minX + b.maxX) / 2).toFixed(1),
              cz: +((b.minZ + b.maxZ) / 2).toFixed(1),
              w: +w(b).toFixed(2), d: +d(b).toFixed(2),
              top: +b.top.toFixed(2), solid: b.solid,
              // 盒子中心到角色的距离
              dist: +Math.hypot((b.minX + b.maxX) / 2 - X,
                                (b.minZ + b.maxZ) / 2 - Z).toFixed(2),
            };
          });
          // 命中盒子的距离分布 —— 若大量盒子离角色极远，
          // 说明查询范围把整个街区的盒子都捞进来了。
          const dists = ids.map((i) => Math.hypot(
            (B[i].minX + B[i].maxX) / 2 - X, (B[i].minZ + B[i].maxZ) / 2 - Z));
          dists.sort((a, b) => a - b);

          // ==================================================================
          //  【核心交叉校验：盒子位置 == 建筑位置吗】
          // ==================================================================
          // 这是本轮抓到的那个大bug 的检测点。
          // 之前所有诊断只统计「数量」，而数量是对的 ——
          // 777 个盒子确实存在，只是全部位于 (0,0)。
          // 只有把盒子坐标与 buildingTags 的建筑坐标逐一对照，
          // 才能发现「数量对、位置全错」这类错误。
          //
          // 做法：按 sort key 配对（同 key 的房子成排出现），
          // 找到每个建筑 3 单位内最近的盒子，看距离分布。
          const T = H.buildingTags;
          let matched = 0, far = 0, worst = 0;
          const farSamples = [];
          for (const t of T) {
            let best = Infinity, bestI = -1;
            for (let i = 0; i < B.length; i++) {
              const b = B[i];
              const d = Math.hypot((b.minX + b.maxX) / 2 - t.x,
                (b.minZ + b.maxZ) / 2 - t.z);
              if (d < best) { best = d; bestI = i; }
            }
            if (best < 3) matched++;
            else {
              far++;
              if (best > worst) worst = best;
              if (farSamples.length < 8) {
                farSamples.push({ key: t.key, x: +t.x.toFixed(1), z: +t.z.toFixed(1),
                                  nearest: +best.toFixed(1), id: bestI });
              }
            }
          }

          // ---- solid 字段健康度 ----
          let solidTrue = 0, solidFalse = 0, solidUndef = 0;
          for (const b of B) {
            if (b.solid === true) solidTrue++;
            else if (b.solid === false) solidFalse++;
            else solidUndef++;
          }

          return {
            total: B.length, hitCount: ids.length, rows,
            giant, over20, over60,
            giantSample: giantList.slice(0, 8).map((i) => ({
              id: i, w: +w(B[i]).toFixed(1), d: +d(B[i]).toFixed(1),
              top: +B[i].top.toFixed(1), solid: B[i].solid,
              cx: +((B[i].minX + B[i].maxX) / 2).toFixed(1),
              cz: +((B[i].minZ + B[i].maxZ) / 2).toFixed(1),
            })),
            distMin: dists.length ? +dists[0].toFixed(2) : null,
            distMed: dists.length ? +dists[Math.floor(dists.length / 2)].toFixed(2) : null,
            distMax: dists.length ? +dists[dists.length - 1].toFixed(2) : null,
            nearCount: dists.filter((v) => v < 12).length,
            solidTrue, solidFalse, solidUndef,
            tagCount: T.length, matched, far,
            worst: +worst.toFixed(1), farSamples,
          };
        }""",
            {"X": X, "Z": Z, "camY": CAM_Y, "camDist": CAM_DIST},
        )

        print(f"=== 机位 ({X}, {Z}) 相机 ({X}, {CAM_Y}, {Z + CAM_DIST}) ===")
        print(f"blockers 总数 {rep['total']}   该点判定命中 {rep['hitCount']}")
        print(f"命中盒子到角色的距离: min={rep['distMin']} "
              f"中位={rep['distMed']} max={rep['distMax']}")
        print(f"命中盒子里距离 < 12 的: {rep['nearCount']}")
        print()
        print(f"--- 盒子尺寸分布 ---")
        print(f"最长边 > 20: {rep['over20']}    > 40: {rep['giant']}    > 60: {rep['over60']}")
        for g in rep["giantSample"]:
            print("   巨型盒:", g)
        print()
        print()
        print(f"--- 盒子/建筑 位置交叉校验 ---")
        print(f"建筑标签 {rep['tagCount']}  匹配(最近盒子<3) {rep['matched']}  "
              f"不匹配 {rep['far']}  最大偏差 {rep['worst']}")
        for f in rep["farSamples"]:
            print("   不匹配:", f)
        print()
        print(f"--- solid 字段 ---  true={rep['solidTrue']} "
              f"false={rep['solidFalse']} undefined={rep['solidUndef']}")
        print()
        print("--- 命中盒子明细（前 20）---")
        for r in rep["rows"]:
            print(f"  id={r['id']:<5} 中心({r['cx']:>8},{r['cz']:>8})  "
                  f"{r['w']:>6}x{r['d']:<6} top={r['top']:<6} "
                  f"solid={str(r['solid']):<5} 距角色={r['dist']}")

        browser.close()


if __name__ == "__main__":
    main()