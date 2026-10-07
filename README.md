# OT2 HD-2D 港口小镇

基于 three.js 的浏览器 3D 游戏原型，画面风格参考《歧路旅人 2》(Octopath Traveler 2) 的 HD-2D 表现。

## 快速开始

```bash
npm install
npm run dev          # 开发服务器 http://localhost:5173
npm run build        # 产出 dist/
npm run preview      # 预览构建产物
```

## 目录结构

```
├── index.html            页面骨架 + loading 层
├── vite.config.js
├── src/
│   ├── main.js           入口：装配、渲染循环、resize
│   ├── core/             与「游戏内容」无关的引擎层
│   │   ├── renderer.js   HD-2D 后处理管线（见下）
│   │   ├── camera.js     跟随相机 + 视线避障
│   │   ├── input.js      键盘 / 触控输入
│   │   ├── optimize.js   静态几何按材质合并（降draw call）
│   │   └── vertexAO.js   顶点级环境光遮蔽烘焙
│   ├── shaders/          自定义后处理
│   │   ├── grade.js      色彩分级：split-tone / 暗角 / 颗粒 / 舞台光
│   │   └── tiltShift.js  移轴景深 + 色阶量化
│   └── world/            游戏内容层
│       ├── scene.js      场景总装 + WORLD 常量（地图尺寸唯一数据源）
│       ├── city.js       程序化城区生成（确定性 seed）
│       ├── props.js      建筑 / 树木 / 道具构件
│       ├── character.js  角色精灵 + 控制器 + 碰撞
│       ├── water.js      海面 shader
│       ├── hd2dTextures.js  程序化贴图生成（Canvas）
│       └── textures.js   贴图缓存入口
├── public/               运行时资源（Vite 原样拷贝）
│   └── assets/chars/cast.png   角色图集（唯一必需的资源）
├── assets-source/        构建输入素材（不进产物）
│   ├── cast/             Kenney CC0 16x16 角色源图
│   └── cast.meta.json    图集规格元数据（运行时**不加载**）
├── tools/                开发脚本（不进产物）
├── docs/screenshots/     文档配图
└── dist/                 构建产物（git 忽略）
```

### 三类资产的边界

这是本项目整理时最重要的一条约定：

| 位置 | 含义 | 是否发布 |
|---|---|---|
| `public/` | 运行时**真正会加载**的文件 | 是 |
| `assets-source/` | 构建工具的**输入**素材 | 否 |
| `tools/` | 开发期脚本与调试页 | 否 |

判断某个文件该放哪里的标准只有一条：**游戏运行时会不会请求它？**
会→ `public/`；不会但构建要用 → `assets-source/`；纯粹是开发工具 → `tools/`。

## 渲染管线

管线顺序本身是设计的一部分，不要随意调整：

```
RenderPass
  → PosterizePass色阶量化
  → UnrealBloomPass   柔和辉光
  → TiltShiftPass     微缩景深
  → RenderPixelatedPass  像素化
  → OutputPass        tone mapping + 色彩空间
  → GradePass         split-tone / 暗角 / 颗粒
```

两条硬约束：

1. **所有逐像素运算必须在像素化之前**。它们按 `gl_FragCoord` 工作，
   放在像素化之后会让同一像素块内各像素结果不同，干净色块被打成彩色噪点。
2. **调色必须在 tone mapping 之后**。`renderer.toneMapping` 设为
   `NoToneMapping`，映射完全交给 `OutputPass` 执行 ——
   两者同时生效会做两次映射，把中高光压掉一大截，画面发灰、对比度尽失。

## 关键设计决策

### 地图尺寸参数化

`WORLD.SCALE` 是地图放大倍数的**唯一数据源**，雾、天空、海面、地面尺寸、
地面贴图 `repeat` 全部由它派生。改地图大小只改这一个值。

雾与天空用 `√SCALE` 而非 `SCALE` 缩放：雾是视觉引导参数，
应该在**看得见的范围内**起作用；线性放大会让远景永远不雾化，
HD-2D 最标志性的「远景融进背景」就没了。

### 程序化贴图

画面贴图基本全部由 `hd2dTextures.js` 用 Canvas 生成，不依赖外部 PBR 图片。
这是项目仅靠约 660KB JS 产物即可完整运行的原因。

### 确定性布局

城区用固定 seed（`20240517`）的伪随机数生成，保证每次刷新布局一致 ——
玩家能形成空间记忆，这是导航体验的根基。

### 相机避障与碰撞

`world/blockers` 列表登记所有会遮挡「相机 → 角色」视线的物体
（房子**与树**，不只是房子），由 `scene.js` 汇成单一数据源，同时喂给：

- **相机**（`core/camera.js`）：迭代求解抬升量，让视线越过遮挡物
- **角色**（`world/character.js`）：把玩家推出实心建筑

两者必须共享同一份列表。历史上相机拿的是「只有房子」的列表、
角色完全没有碰撞，于是出现「相机认为视线通畅、实际被树挡住」的偏差。

### 遮挡物登记的完整性

凡是竖直方向能挡住视线的东西都要登记，漏一类就会出现一类 bug。
最初只登记房子，射线诊断（`npm run diagnose`）实测发现
沿街的树冠（`Icosahedron`）同样横在视线上，且相机高度仍是基准值
（说明避障压根没触发）。

## 开发工具

```bash
npm run shoot       # 截图（xvfb + headful Chromium）
npm run diagnose    # 相机视线诊断：射线检测遮挡物并列出命中对象
npm run build:cast  # 从assets-source/cast/ 重建角色图集
```

`diagnose` 是排查「角色看不见」这类问题的**唯一可靠手段** ——
包围盒的数学判定和真实渲染结果会对不上，射线打的是真实几何，结论唯一。
它需要 `?debug=nomerge` 模式才能定位到具体物体
（合并后整座城是一个巨型 mesh，射线只能报告「被合并体挡住」）。

> 无头环境注意：本机没有 GPU，Chromium 必须走
> `xvfb-run` + headful + swiftshader，否则拿不到 WebGL2。
> 软件渲染下的 FPS 不代表真实设备表现，应关注 draw call / 三角面 / pass 耗时。

## 素材授权

- 主角：codex-pet.org `kasumi-orange`（作者 lincoco），用户已授权使用
- NPC：Kenney Roguelike Characters（CC0）
- 其余贴图：全部由本项目程序化生成
