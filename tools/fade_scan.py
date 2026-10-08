"""
全城扫描：找出「淡出真的会触发」的坐标
================================================================================
【为什么必须有这个工具 —— 一个假阴性陷阱】

fade_probe.py 里的测试机位原本是四个手写常数。
本轮把街区布局改了（civic 地块只排一边、sparse 缺一边），
建筑总数从 1516 掉到 1170 —— 原来那些坐标周围**已经没有房子了**。

于是测试报出「0 栋淡出」，四机位全FAIL。
看起来像「淡出功能彻底没生效」，差点把排查引向
shader 注入、LUT 容量、aFadeId 写入这些完全正确的方向。

真相是：**测试点选在了空地上**。
判定逻辑没错，输入的状态不对 —— 与之前
「setPlayerPos 不带相机、软渲染 0.6fps 下相机还在半路」
是同一类错误的另一个变种：
  用「一个不具代表性的输入」去验证系统，然后责怪系统。

【解法：让代码自己回答】

不猜坐标，直接调 fade.probe()扫全城 ——
它返回「在这个机位下该淡出哪些盒」，
是纯几何事实、不写任何状态（扫一遍不会把游戏里的楼都变透明）。

扫完按「触发数」排序，取最高的几个作为测试机位。
这样测试集是**由被测系统自己筛出来的**，
布局再改版也不用重挑坐标 —— 重跑一次扫描即可。

【为什么扫描时要带上真实的相机高度与距离】

淡出判据 A 里有高度判据（视线在 tExit 处是否低于盒顶），
判据 B 里有投影重叠 —— 两者都依赖相机的**实际位置**。
所以不能只扫角色坐标：必须用真实机位参数
（相机高度 ≈ 22、俯视距离 ≈ 30，与 camera.js 的配置同量级），
否则扫出来的点与实际游玩时的触发条件不一致。

用法:
  xvfb-run -a python3.11 tools/fade_scan.py http://127.0.0.1:4173/
"""
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:4173/"
for a in sys.argv[1:]:
    if a.startswith("http"):
        URL = a

# 采样步长（世界单位）。城区 280×260，
# 步长 4 → 70×65 = 4550 个点，与之前统计「贴墙点」用的口径一致。
STEP = 4.0

# 机位参数：与 camera.js 的 CAMERA_CONFIG 同量级。
# 相机在角色正南偏上，俯视。
CAM_Y = 22.0
CAM_DIST = 30.0

# 判定「空旷处」用的最远距离：跑这么远还没东西挡，才叫空旷。
OPEN_DIST = 30.0


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        page = browser.new_page(viewport={"width": 800, "height": 600})
        page.goto(URL, timeout=120000)
        page.wait_for_function("window.__HD2D__ && window.__HD2D__.ready",
                               timeout=120000)
        page.wait_for_timeout(3000)

        report = page.evaluate(
            """({step, camY, camDist, openDist}) => {
          const H = window.__HD2D__;
          if (!H.fadeProbe) return { error: 'fadeProbe 未挂载' };
          const B = H.blockers;
          // 城区范围：从遮挡物反推，比硬编码可靠
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const b of B) {
            if (b.minX < minX) minX = b.minX;
            if (b.maxX > maxX) maxX = b.maxX;
            if (b.minZ < minZ) minZ = b.minZ;
            if (b.maxZ > maxZ) maxZ = b.maxZ;
          }

          // -----------------------------------------------------------------
          //  【只能采样「玩家站得到」的点 —— 这是本工具最关键的一处约束】
          // -----------------------------------------------------------------
          // 第一版直接对全城网格逐点调fadeProbe，结果报出
          // 31% 的地图会触发淡出、最多同时淡出 17 栋 —— 数字很难看，
          // 但它们全是**假警报**。
          //
          // 原因：采样点落在建筑内部。
          // fade_dump.py 摊开看 (52.3, 64.7) 的 17 个命中盒，
          // 角色点被三栋房子同时包住 —— 而主街路面只有 |x-40| <= 9，
          // x=52.3 已经在东侧那排民居的肚子里了。
          // 玩家碰撞体积根本进不去，现实中不会发生。
          //
          // 更要紧的是：修复了「盒子全登记在 (0,0)」那个 bug 之后，
          // 碰撞才**第一次真正生效**（此前所有建筑都撞不到）。
          // 于是「站进房子里」这个状态从「能走进去」变成了「走不进去」，
          // 采样却还按能走进去算 —— 判据没错，输入不可达。
          //
          // 与之前两次假阴性/假阳性是同一条教训：
          //   「用不具代表性的输入验证系统，然后责怪系统」。
          // 必须显式过滤掉不可达点，否则这个指标无法解释。
          const reach = (x, z) => {
            for (const b of B) {
              if (!b.solid || b.top < 1.6) continue;
              if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return false;
            }
            return true;
          };

          // -----------------------------------------------------------------
          //  【只在「可玩城区」内采样 —— 不能用遮挡物反推的边界】
          // -----------------------------------------------------------------
          // 遮挡物里含createOutskirts 撒的郊野散点，
          // 所以按 blockers 的min/max 扫出来的范围
          // （z从 -131 到 263）**远大于城区**。
          // 第一版推荐机位 (76.3, -79.3) 就落在南边的郊野里 ——
          // 那里房子是直接撒在水面上的荒地，
          // 拍出来一片「房子浮在海上」，跟城区布局毫无关系。
          //
          // 所以必须显式限定在scene.js 的 WORLD.bounds 内采样。
          // 城区常量的唯一数据源就是 WORLD.bounds（见 scene.js 的说明），
          // 这里通过 main.js 暴露的 debug 钩子取，不另写一份数字 ——
          // 另写一份就是又一个会与实际不符的平行常量。
          const BB = H.worldBounds;
          const cx0 = BB.minX, cx1 = BB.maxX, cz0 = BB.minZ, cz1 = BB.maxZ;

          const hits = [];
          let sampled = 0, reachable = 0, unreachable = 0;
          for (let z = cz0 + 4; z < cz1 - 4; z += step) {
            for (let x = cx0 + 4; x < cx1 - 4; x += step) {
              sampled++;
              if (!reach(x, z)) { unreachable++; continue; }
              reachable++;
              const ids = H.fadeProbe(x, camY, z + camDist, x, z);
              if (ids.length > 0) {
                // 记录被淡出的盒子高度，用于判断这是不是「一堵高墙」
                let topMax = 0, solidAll = true;
                for (const i of ids) {
                  if (B[i].top > topMax) topMax = B[i].top;
                  if (!B[i].solid) solidAll = false;
                }
                hits.push({ x: +x.toFixed(1), z: +z.toFixed(1),
                            n: ids.length, ids: ids.slice(0, 6),
                            topMax: +topMax.toFixed(1), solidAll });
              }
            }
          }

          // ---- 推荐一个「基准机位」：真正空旷、且离城适中 ----
          //
          // 【为什么要专门找，而不是手挑一个「看起来空旷」的坐标】
          // fade_probe 早前用 (100,30) 当基准（城区东南角，直觉上很空）。
          // 但修复了「遮挡盒全登记在 (0,0)」那个 bug 之后，
          // 房子落到了真实位置 —— (100,30) 距一栋 6 米民居只有十几米，
          // 于是「空旷处不该淡出任何建筑」这条断言必然失败。
          //
          // 又一次是**基准选错**，不是功能有问题。
          // 所以基准机位也必须由代码按明确判据挑：
          //   ① 周围 openDist 内没有任何 solid 且 top>=2.2 的盒子
          //   ② 且距城区重心不远（太偏的角落玩家根本走不到，
          //     在那儿做基准等于测了一个没人去的地方）
          let baseline = null;
          let bestScore = -Infinity;
          for (let z = cz0 + 20; z < cz1 - 20; z += step * 2) {
            for (let x = cx0 + 20; x < cx1 - 20; x += step * 2) {
              let clear = true;
              for (const b of B) {
                if (!b.solid || b.top < 2.2) continue;
                const cx = Math.max(b.minX, Math.min(x, b.maxX));
                const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
                if (Math.hypot(cx - x, cz - z) < openDist) { clear = false; break; }
              }
              if (!clear) continue;
              if (H.fadeProbe(x, camY, z + camDist, x, z).length > 0) continue;
              // 偏好靠近重心、且偏好开阔（周围盒子更少）的点
              let n = 0;
              for (const b of B) {
                const cx = Math.max(b.minX, Math.min(x, b.maxX));
                const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
                if (Math.hypot(cx - x, cz - z) < openDist * 2) n++;
              }
              const score = -Math.hypot(x - 40, z - 120) - n * 0.5;
              if (score > bestScore) {
                bestScore = score;
                baseline = { x: +x.toFixed(1), z: +z.toFixed(1), near: n };
              }
            }
          }

          // ---- 反向验证：空旷处确实不该触发 ----
          // 「该淡出」的正例好找，「不该淡出」的反例才是防误淡的关键。
          // 做法：找一个周围 openDist 内没有任何实心盒子的点，
          // 断言它fadeProbe 返回空 —— 否则说明淡出会蔓延到空地。
          let openChecked = 0, openViolations = [];
          for (let z = cz0 + 10; z < cz1 - 10; z += step * 3) {
            for (let x = cx0 + 10; x < cx1 - 10; x += step * 3) {
              let clear = true;
              for (const b of B) {
                if (!b.solid) continue;
                if (b.top < 2.2) continue;
                const cx = Math.max(b.minX, Math.min(x, b.maxX));
                const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
                if (Math.hypot(cx - x, cz - z) < openDist) { clear = false; break; }
              }
              if (!clear) continue;
              openChecked++;
              const ids = H.fadeProbe(x, camY, z + camDist, x, z);
              if (ids.length > 0) {
                openViolations.push({ x: +x.toFixed(1), z: +z.toFixed(1), n: ids.length });
              }
            }
          }

          // ---- 触发点的空间分布 ----
          // 全城集中在少数角落 = 淡出只在个别区域生效 = 覆盖不足。
          const grid = {};
          const CELL = 40;
          for (const h of hits) {
            const k = Math.floor(h.x / CELL) + ',' + Math.floor(h.z / CELL);
            grid[k] = (grid[k] || 0) + 1;
          }

          hits.sort((a, b) => b.n - a.n);
          // 同时淡出超过 3 栋 = 画面会碎成筛子，必须单独盯
          const over3 = hits.filter((h) => h.n > 3).length;
          const nHist = {};
          for (const h of hits) nHist[h.n] = (nHist[h.n] || 0) + 1;

          return {
            bounds: { minX, maxX, minZ, maxZ },
            cityBounds: BB,
            sampled, reachable, unreachable, hitCount: hits.length,
            top: hits.slice(0, 40),
            over3, nHist,
            // 高度分布：确认触发点挡的是真房子而不是矮花坛
            tallHits: hits.filter((h) => h.topMax >= 3).length,
            baseline,
            openChecked, openViolations: openViolations.slice(0, 10),
            openViolationCount: openViolations.length,
            gridCells: Object.keys(grid).length,
            gridTop: Object.entries(grid).sort((a, b) => b[1] - a[1]).slice(0, 12),
          };
        }""",
            {"step": STEP, "camY": CAM_Y, "camDist": CAM_DIST,
             "openDist": OPEN_DIST},
        )

        print("=== 全城淡出触发点扫描 ===")
        print("城区（可玩区）:", report.get("cityBounds"))
        print("遮挡物总范围（含郊野）:", report.get("bounds"))
        print(f"采样点: {report['sampled']}  可达: {report['reachable']}"
              f"  不可达(在建筑内): {report['unreachable']}")
        print(f"可达点中触发淡出: {report['hitCount']}"
              f"  其中 top>=3: {report.get('tallHits')}")
        print(f"触发点覆盖网格: {report.get('gridCells')} 个 40×40 格")
        print("最密的格子:", report.get("gridTop"))
        print()
        print(f"同时淡出 >3 栋的可达点: {report['over3']}")
        print("淡出栋数分布:", report["nHist"])
        print("触发最多的 12 个坐标（可直接作为测试机位）:")
        for h in report["top"][:12]:
            print(f"  ({h['x']:>7}, {h['z']:>7})  淡出 {h['n']} 栋  "
                  f"最高 {h['topMax']}  solid={h['solidAll']}  ids={h['ids']}")
        print()
        print()
        print("推荐基准机位（空旷 + 离城适中）:", report.get("baseline"))
        print(f"空旷点校验: 检查 {report['openChecked']} 个空旷点, "
              f"误触发 {report['openViolationCount']} 个")
        for v in report.get("openViolations", []):
            print("   误触发:", v)

        browser.close()


if __name__ == "__main__":
    main()