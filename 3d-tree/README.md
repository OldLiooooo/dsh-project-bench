# 3D 项目树视图

把 `.project/project.db` 渲染成一棵**会发光的 3D 树**。主干是项目状态，分支是切片状态，
叶子上挂的是**磁盘上真实的文件**。独立只读服务，浏览器直接开。

```
node 3d-tree/server.mjs --root C:/Users/oldap/Documents/lumio --open
```

![](https://img.shields.io/badge/three.js-r169-brightgreen) ![](https://img.shields.io/badge/deps-0(Vendored)-blue) ![](https://img.shields.io/badge/tests-91%20passed-brightgreen)

---

## 树长什么样

```
        ●  ← 主干（Trunk）：项目本身
       ╱ ╲    颜色 = 项目状态（蓝=进行中 黄=待决策 绿=完成 红=阻塞）
      ╱   ╲   呼吸脉冲 = 状态是活的
     ●     ●  ← 分支（Branch）：一个切片 / 一个 docs 子目录
    ╱│╲   ╱│╲   颜色 = 切片状态，光晕大小 = 文件数量
   ● ● ● ● ● ●  ← 叶子（Leaf）：真实文件
               青=已落地  红=库里有但磁盘没有  黄=库里还没正文
```

**一眼看懂规则**：主干什么颜色 → 项目什么状态；哪条分支亮着 → 那条在工作；
叶子红的多 → 有一堆文档还没导出到磁盘。

**阶段 S01/S07 的百分比不在这上面**，它们是弹窗里的东西（点顶部「阶段进度」或点主干）。

## 跑起来

```bash
node 3d-tree/server.mjs --root <项目根目录>          # 起服务
node 3d-tree/server.mjs --root <项目> --open         # 起完自动开浏览器
node 3d-tree/server.mjs --db <项目>/.project/project.db
node 3d-tree/server.mjs --list                       # 不知道项目在哪
```

| 参数 | 说明 |
|---|---|
| `--root, -r <dir>` | 项目根目录 |
| `--db <file>` | 直接指定数据库 |
| `--port, -p <n>` | 端口，默认 `5777` |
| `--host <addr>` | 监听地址，默认 `127.0.0.1` |
| `--open` | 启动后打开浏览器 |
| `--no-watch` | 关闭文件监听 |
| `--list` | 列出当前目录下所有项目 |

## 操作

| 动作 | 效果 |
|---|---|
| 拖拽 | 轨道旋转（带阻尼） |
| 滚轮 | 缩放（3–46 距离限制） |
| 点击分支 | 弹窗看该切片的文件和状态 |
| 点击叶子 | 弹窗看文件详情（路径/状态/版本/大小） |
| 点击主干 | 弹窗看阶段进度（S01..S07 百分比在这里） |
| 右侧列表 | 点任一分支 → 相机聚焦 + 弹窗 |
| `R` | 重置视角 |
| `Esc` | 关闭弹窗 / 取消选中 |

## 完成度怎么算

### 文档（权重 5）
| 状态 | 权重 |
|---|---|
| `frozen` / `approved` | 1.0 |
| `review` | 0.6 |
| `draft` | 0.3 |
| **`current_version = 0`** | **0** |

最后一行是刻意的：状态写着 `frozen` 但从没写过正文，是数据异常，不能算完成。

### 任务（权重 4）
`done` 1.0 · `review` 0.7 · `in_progress` 0.4 · 其余 0

### 决策（权重 2）
已拍板（`approved`/`rejected`/`superseded`）算 1。**未决决策会拉低完成度**。

### 切片
有哪几类就按哪几类加权平均，**不存在的不进分母**。

### 阶段
`切片均值 × 0.7 + 应有交付物覆盖率 × 0.3`

"应有交付物"来自 `project.json` 的 `stageTemplate[].deliverableTypes`。
缺哪个在弹窗里明确列出（比如 S3 缺 `adr/design/spec`）。

### 两个总量口径
- **流水线完成度**：所有阶段的均值，空阶段算 0（不粉饰）
- **已开工阶段**：只算有切片的阶段（不被没开工的稀释）

两者差越大 = 还有越多阶段没启动。

## 一个重要的诚实性问题

真实项目（lumio）的 `docs/` 里有 **271 个 md 文件**，但库里只登记了 **2 个文档**。

如果只画 DB 文档，树上就只有 2 个叶子 —— 而项目明明有 271 个文件，**那是在撒谎**。

所以未纳管的文件也会进树，作为独立的"未纳管"分支（带 `未纳管` 标签，不冒充成工作项）。
这带来一个有用的副产品：**未纳管分支的规模 = 库对文件的覆盖率有多低**。

> 术语：这些文件叫 **untracked（未纳管）**，不叫 orphan（孤儿）——
> 它们是项目自己手写的文档，不是垃圾。

## 文件三态

| 状态 | 含义 | 颜色 |
|---|---|---|
| `synced` | DB 有、磁盘也有 | 青绿 |
| `stale` | DB 说有版本，磁盘没有 —— **真问题** | 红 |
| `empty` | DB 里就没正文（version=0） | 黄 |

推导路径与插件 `host/export.js` 同规则（`exportMap` → 子目录，`logicalKey` 的 `/` 换 `-`），有单测钉住。

## API

| 路由 | 说明 |
|---|---|
| `GET /` | 页面 |
| `GET /api/snapshot` | 完整数据（每次现开现关库，不占 WAL） |
| `GET /api/meta` | db 路径 / 版本 / 错误 |
| `GET /api/events` | SSE：库一变就推新快照 |
| `POST /api/reload` | 手动重算（唯一非 GET，不写库） |

**只读契约**：除 `/api/reload` 外拒绝一切非 GET（405）；SQLite 只用 `readOnly`；
不写数据库、不写文件。测试验证 reload 前后 DB 文件字节数不变。

实时更新靠 `fs.watch` 盯 `project.db*`，150ms 防抖。

## 视觉资源

**three.js r169 + UnrealBloom 泛光后处理**，全部 vendored 到 `web/vendor/`（约 760KB，无 CDN 依赖、离线可用）。

为什么是 vendored 而不是 npm 装：这台机器 `npm install` 会 EPERM。
为什么用 three 而不是手写投影：要 Bloom、要真实光照、要体积光晕 —— 手写不值当。

**降级**：如果 WebGL 不可用（远程桌面/无 GPU），页面会显示提示而不是白屏。

## 测试

```bash
node 3d-tree/tests/model.test.mjs       # 31 例：完成度算法、路径推导、磁盘三态
node 3d-tree/tests/projection.test.mjs  # 23 例：纯数学投影（旧渲染层，保留）
node 3d-tree/tests/render.test.mjs      #  9 例：旧 canvas 渲染器
node 3d-tree/tests/scene.test.mjs       # 15 例：3D 布局语义（主干/分支/叶）
node 3d-tree/tests/server.test.mjs      # 13 例：HTTP 契约、只读保证、SSE
```

共 **91 例**。用 `node <file>` 而不是 `node --test`：某些沙箱禁止 `--test` 派生子进程。

**已验证的**：资源全部 HTTP 200、`buildScene` 在真 THREE 对象下构造 335 个网格且位置零误差、
319/319 节点可拾取、两个真实项目数据正确、SSE 实时推送、watcher 捕获外部写入。

**未验证的**：沙箱里 headless Chromium 起不来（多进程 mojo 被拒），所以**没有像素级截图基线**。
WebGL 渲染效果需要你在浏览器里亲自确认。

## 实现选择

| 决定 | 原因 |
|---|---|
| Canvas → three.js | 要 Bloom/光照/光晕，手写不值当 |
| three vendored | `npm install` 在本机 EPERM |
| 自带 `buildScene` 而非依赖 GPU | 布局与几何构造可脱离 WebGL 单测 |
| 阶段不进树 | 会把树撑成直线，稀释"主干/分支"语义 |
| 未纳管文件进树 | 只画 DB 文档等于撒谎（2 vs 271） |

**文件布局**

```
3d-tree/
├── server.mjs            # HTTP + SSE + 静态资源
├── model.mjs             # 只读投影：DB 行 -> 主干/分支/叶
├── defaults.mjs          # 阶段模板镜像（与插件源有单测比对）
├── web/
│   ├── index.html        # 页面（3D 全屏 + 弹窗）
│   ├── viewer.js         # three.js 主程序、Bloom、交互
│   ├── scene.js          # 布局 + 几何构造（可脱离 GPU 测试）
│   ├── projection.js     # 旧纯数学投影（保留，有单测）
│   ├── renderer.js       # 旧 canvas 渲染器（保留，有单测）
│   └── vendor/           # three.js r169 + 后处理（vendored）
└── tests/                # 91 例
```
