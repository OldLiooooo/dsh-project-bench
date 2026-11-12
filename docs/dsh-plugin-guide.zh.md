# DSH 工作台插件：开发规则与发布指南（调研笔记）

> 调研日期：2026-11-11
> 依据：本机 DSH Desktop（`desktop` profile，插件包版本约 `0.2.2-rc.1`）+ 本机 DSH 源码 checkout
> `C:\Users\oldap\Documents\deepseek-harness-a\deepseek-harness`（`0.2.1-rc.2`）+ 官方 skill
> `cordis-plugin-development`。运行中的安装才是最终权威，文档与真实 API 有出入时以
> `cordis_inspect_query` 查到的 Service / Event / Slot / Config 为准。

---

## 一、先回答三个问题

### 1）有没有开发规则？

有，而且分三层（详见第二、三章）：

| 层 | 内容 | 位置 |
|---|---|---|
| 插件作者手册 | 插件形态、bundle 打包、Config、工具、打包安装、市场索引 | DSH 仓库 `docs/user/develop/`、`docs/user/guide/plugin-market.zh.md` |
| 官方 Agent skill | Host 插件 / UI 插件的清单式规则（元数据、图标、slot、清理、验证） | `packages/preset/agent-preset/skills/cordis-plugin-development/` |
| 机器可读约束 | `package.json` 的 `dsh.*`、`engines.dsh` 类型；安装器/读取器的实际校验 | `packages/util/package-manifest/README.zh.md`、`packages/boot/plugin-manager/`、`packages/boot/plugin-market/` |

要点：**DSH 本体是用 Cordis 插件框架搭的，所谓「DSH 插件」就是一个 npm 包 + 一份 Loader patch（`cordis.patch.yml`）+（可选）一份浏览器端模块。** 规则基本都围绕这三样东西。

### 2）开发之后怎么发布？

发布 = 把插件做成用户可安装的 **bundle（组合包）**，再选一种分发渠道：

1. **npm 包**（推荐）：`pnpm publish`，用户 `dsh plugin --profile <p> add <包名>` 即可。
2. **tarball**：`pnpm pack` 得到 `.tgz`，用户 `dsh plugin add ./xxx.tgz`（适合 GitHub Release 附件）。
3. **Git 仓库直装**：`dsh plugin add github:you/repo`。能跑，但要求你提供能自包含构建的 `prepare` 脚本，且用户必须手动授权安装期执行构建脚本（pnpm `allowBuilds`），否则装完没有 `lib/`，加载失败。
4. **想被「发现」页列出**：再发布一份静态 **插件市场索引 `index.json`**（可放 GitHub Pages），用户把该 URL 添加为索引源后就能搜索/一键安装。**DSH 目前没有官方插件市场**，也不内置任何索引源。

### 3）发布到 GitHub 就够吗？

分场景：

| 你的目标 | GitHub 够不够 | 说明 |
|---|---|---|
| 开源分享源码、让别人找到你 | ✅ 够 | 官方推荐给仓库加 **`dsh-plugin`** topic（见 DSH 主 README 与 CONTRIBUTING） |
| 别人能用一条命令装上 | ⚠️ 勉强 | `dsh plugin add github:you/repo` 需要 `prepare` 构建 + 用户 `allowBuilds` 授权；更顺的是发 npm 或发 `.tgz` |
| 用户能在「发现」页看到/一键装 | ❌ 不够 | 需要一份 `index.json` 市场索引；GitHub Pages 可以做这个静态主机 |
| 提交进官方市场 / 官方商店 | ❌ 不存在 | 官方明确「目前没有官方插件市场」；且当前不接受外部 PR |

**推荐组合（个人开发者）：GitHub 仓库（源码 + `dsh-plugin` topic + Release 附 `.tgz` + Pages 托管 `index.json`）+ npm 包。** 这样源码、发现、安装三条路都通。

---

## 二、核心概念（先建立正确心智模型）

### 2.1 插件

一个 Cordis 插件 = 一个导出 `apply` 的模块。框架在加载时调用它，把 `ctx` 交给你，你通过 `ctx` 注册能力：

```js
export const name = 'my-plugin'
export function apply(ctx) {
  // ctx.tools.register(...)、ctx.on(...)、ctx.effect(...)
}
```

也可写成对象形式或 class 形式（需要对外提供服务时用 class + `Service`）。同一个插件不要混用多种导出形态。

### 2.2 组合包 bundle 与 profile 是两种东西

- **bundle（组合包）** = 「包 + 一个配置层」的 npm 包，声明 `dsh.bundle.patch`，回答「这个包贡献什么」。
- **profile** = `$DSH_HOME/profiles/<name>` 下描述一次启动组合的目录，声明 `dsh.profile.bundles` 有序列表，回答「这次启动由哪些组合包按什么顺序组成」。

你写的是 bundle；用户用 `dsh --profile <name>` 或 Desktop 启动的是 profile。

最小 Host-only bundle：

```
hello-plugin/
├── package.json         # 声明 dsh.bundle.patch
├── cordis.patch.yml     # 安装后叠加到配置树的 patch 层
├── index.js             # 插件入口
├── locale/en.json       # 展示元数据（必需英文）
├── locale/zh.json       # 中文展示元数据
└── icon.svg             # 插件图标
```

`package.json`：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "engines": { "dsh": ">=0.2.0" },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

`cordis.patch.yml`（与 `--patch` overlay 同一套 YAML 方言）：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

说明：

- 插件行 `name` 写**包名**（安装后由 Node 模块解析找到），不要写相对路径；`--patch` 本地调试时才写绝对路径。
- `patch` 也可以是**有序文件列表**（如 `["./base.patch.yml", "./web.patch.yml"]`），按顺序作为同一层应用。
- 后续层按行 id 覆盖前面层，且 **覆盖会替换整行 `config`，不是深合并**——只改一个键也要把其它键重述一遍。
- 没有 `dsh.bundle` 的包仍可安装，但只是普通依赖，不会激活任何配置层。

### 2.3 配置层加载顺序（谁赢）

1. `dsh.profile.bundles` 里各组合包的 patch，按列表顺序；
2. profile 自己的 `cordis.patch.yml`；
3. home 级 `$DSH_HOME/cordis.patch.yml`；
4. 每个 `--patch <path>` overlay，按 argv 顺序。

后应用者按行 id 胜出。用户可以在自己的 profile patch 里覆盖你的行，所以你的默认值要选用户大概率会保留的值。

### 2.4 版本兼容

- 用 `engines.dsh`（SemVer 范围，可为精确预发布版本）声明支持的 DSH 版本。
- 没有 `engines.dsh` 时，按 `@deepseek-ai/dsh*` 的 `peerDependencies` 范围检查。
- 安装与 profile 启动都会检查；不兼容的包需要用户显式做版本豁免（有风险，Desktop 插件管理器里有对应流程）。

---

## 三、开发规则清单

### 3.1 所有插件通用

- **命名与品牌**：项目/包名体现生态关联时用缩写 **DSH**，不要直接用完整商标「DeepSeek Harness」当项目名；描述里可以写「基于 DSH 构建」。不要用官方品牌素材暗示官方背书（见 `BRAND_GUIDELINES.zh.md`）。插件 id / 包名要唯一。
- **可调参数进 Config，不硬编码**。判断标准：能否只改 `cordis.patch.yml` 就调整这个值？
- **配置错误要响**：用 Schemastery schema 校验，非法配置在加载时直接失败并给明确原因。
- **注册即 effect**：事件监听、工具、定时器、slot 注册都挂在 `ctx` 上，插件卸载时自动清理；需要手写清理的资源用 `ctx.effect(() => cleanup)`。
- **可选服务放 `inject`**：让插件在没有该服务的 profile 里保持不激活，而不是抛错。
- **不要向 session 追加自定义 `type` 事件**：读取方只接受带 `ignorable: true` 的未知事件，而实时 `Session.append()` 设不了这个标记，会导致会话无法重开。状态请从既有事件派生，或放进 storage 服务。
- **性能**：派生状态用 `ctx.sessionProjections`，不要订阅 `session/event` 后全量重扫；等 `turn/end` 等持久事件，不要轮询 `agent/status`。
- **扩展点用最弱手段**：`tools.restrict` → `tools.guard` → waterfall → 整体替换，能弱则弱。

### 3.2 Host 插件（Node 侧）

- 导出形态三选一：`apply(ctx, config)` + 可选 `inject` / `Config`；或默认导出一个 Service class。**不要混用**。
- 所有资源在 `apply` 内用 `ctx.effect` / `ctx.on` 注册并返回清理函数。
- 声明了 `Config` 的插件，写配置前先用 `cordis_inspect_query` 的 `Config.listConfigs` 查 schema（含 `$defs` 引用）。
- 工具用 `defineTool(...)` 定义参数 schema、输出 schema 和渲染函数。
- 按「能力三分离」设计：Service Definition / Provider / Consumer 各司其职（参考 `docs/user/develop/practice/index.zh.md`）。

### 3.3 Web UI 插件（浏览器侧）

- `package.json` 增加 `dsh.client` 段和 `./client` export：

  ```json
  {
    "exports": { ".": "./index.js", "./client": "./client.js" },
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
    }
  }
  ```

- `client.js` 用浏览器模块表注册惰性工厂，**id 必须等于包名**：

  ```js
  window.__ModuleLoader__.load({
    id: '@local/my-decoration',
    factory(require) {
      const React = require('react')
      // ...返回 { inject: ['slots'], apply(ctx) { ctx.slots.inject(...) } }
    },
  })
  ```

- **UI 只通过 slot 贡献**：`ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`；先用 `cordis_inspect_query` 的 `Slots.listSubTree` 选一个**已经分配好空间**的 slot，不要自己找位置。
- 工厂函数保持无副作用；样式/监听在 `apply` 里用 `ctx.effect` 注册并返回清理。
- **主题只用 token**（`--dsw-alias-*`），字面色只用于插画；不要 iframe 嵌入 Host 页面，不要替换 app root、不要向 `document.body` 追加节点，不要读别的插件 DOM/样式来「估算」位置。
- **不要 `require('@deepseek-ai/dsh-client-ui-primitives')` 等 Harness Client 包**；需要控件就按宿主样式自己写（抄样式、改类名前缀、保留无障碍行为）。
- 可见文案走 Client locale 服务；页面/面板的交互若涉及应用数据，按「一个操作两个调用方」实现：Host service 方法一份实现，UI 动作和 agent 工具都调它（用户授权类动作只留给用户）。

### 3.4 展示元数据与图标（安装后用户第一眼看到的东西）

- `locale/en.json` 必须有 `meta.title`、`meta.description`，且是**真实描述该插件能力**的文字，不能留模板文案；再补 `locale/zh.json` 等语言。
- 图标原创，或使用允许再分发的素材并保留署名；SVG / PNG / JPEG / WebP，**≤256 KiB**，路径在包内、相对 manifest，不能是绝对路径/URL/指向包外的符号链接。
- 包根 `package.json` 的 `icon` 字段优先于 `./icon` export。
- `exports` 暴露 `./locale/*.json` 与 `./icon`，`files` 要列全所有运行时文件（含 client.js、locale、icon）——打包发布后按实际 tarball 文件清单核对；**link 安装不过滤 `files`，别被链接安装「骗」过**。
- 安装后检查：插件页/组合包详情的标题、描述、图标在中英文下是否正确渲染，有无元数据诊断或回退。

### 3.5 如果你要往 DSH 官方仓库贡献

- 当前 **不接受外部 PR**（CONTRIBUTING.zh.md）；官方希望社区以插件生态方式参与。
- 若将来被邀请/在仓库内开发：先读根 `AGENTS.md`、`docs/development.zh.md`、`docs/i18n/`、`docs/cookbook/`，遵守 typecheck / 测试 / changeset / i18n 门禁。

---

## 四、本机开发与调试（Desktop 环境）

你现在的 DSH Desktop 正在运行 `desktop` profile。三种开发路径，按推荐顺序：

### 方式 A（推荐，最快看到效果）：会话内用插件管理器安装工作区 bundle

1. 在 workspace 里写好 bundle 目录（可复制 `templates/` 里的骨架）；本地开发建议用 `@local/xxx` 包名 + `"private": true`。
2. 让 agent 调 `plugin_manager` → `install_bundle`，`target` 传 bundle 的**绝对目录**。
3. 读返回的 `application` / `warnings` 判断是否生效（不是看日志）：`applied` = 已生效；`restart-required` = 需要重启；`overridden` = 被更高优先层覆盖。
4. 用 `cordis_inspect_query`（免审批）确认插件行/注册，而不是 `list_plugins`。
5. 迭代：改 Host 代码后重新安装；替换已安装包通常需要重启应用才能载入新的 JS 模块，新 bundle 可能通过 HMR 直接生效。改 UI 用页面刷新验证。

注意：这一步会写 `desktop` profile（`~/.dsh/profiles/desktop`），**影响所有会话且重启后保留**；安装动作在当前沙箱下会请求一次授权审批。

### 方式 B：Desktop 自带的 `dsh` CLI + 独立 profile

1. 应用菜单 → **管理 dsh 命令…** → 安装 `dsh`（Windows 注册到用户 PATH）。
2. 先启动一次 Desktop 初始化 profile，然后**完全退出 Desktop**（profile 写锁）。
3. 用 CLI 管理 Desktop 插件：

   ```sh
   dsh plugin --profile desktop add C:\path\to\my-bundle
   dsh plugin --profile desktop list
   dsh plugin --profile desktop remove my-bundle
   ```

   普通 npm 安装的 CLI 不允许管 `desktop` profile；Desktop 自带命令可以（需要 profile 已初始化）。
4. 重开 Desktop 生效。

也可以建独立开发 profile 练手：`dsh plugin --profile dev add ./my-bundle`，`dsh --profile dev --dump-config` 检查层，`dsh --profile dev` 启动。

### 方式 C：起一个独立 Web 开发实例（Host 逻辑迭代）

```sh
dsh web --patch C:\Users\oldap\Documents\dsh-porject-bench\templates\host-bundle\dev-overlay.yml
```

- 默认打开 `http://127.0.0.1:3080`，不影响 Desktop 的 GUI。
- overlay 里插件行的 `name` 要写**绝对路径**（指向 `index.js` 或包目录）。
- patch overlay 文件不在 HMR 监视范围内，改完重启该实例；UI client 部分建议仍以方式 A 的 bundle 安装验证为准。

### 常用检查命令

```sh
dsh --profile dev --dump-config          # 不启动看组合后的配置层
dsh --profile dev --dump-config-schema   # 看插件 Config 的 JSON Schema
```

---

## 五、发布

### 5.1 发布前检查清单

- [ ] `version` 递增，`engines.dsh` 与实际兼容范围一致
- [ ] 发布到 npm 时去掉 `"private": true`（或改 false）
- [ ] `exports` 含 `.`、`./client`（有 UI 时）、`./locale/*.json`、`./icon`
- [ ] `files` 列全所有运行文件；用 `npm pack --dry-run` 或解开 `.tgz` 核对文件清单
- [ ] `locale/en.json` + 目标语言（如 `zh.json`），`meta.title` / `meta.description` 真实准确
- [ ] 图标原创/有许可、格式与大小符合（≤256 KiB、包内相对路径）
- [ ] `README`：安装方法、配置项、兼容版本、卸载方法；附 `LICENSE`
- [ ] `node --check` 语法检查、JSON 解析检查、`--dump-config` 能出层
- [ ] 在**干净 profile** 里用 tarball 安装验证（不要只测 link 安装）
- [ ] git tag 与 npm 版本对应

### 5.2 三种分发方式对比

| 方式 | 作者操作 | 用户操作 | 优点 | 坑 |
|---|---|---|---|---|
| npm | `pnpm publish`（产物已构建好） | `dsh plugin add <pkg>` / 市场「发现」一键装 | 最顺、可发现 | 需要 npm 账号；包名/scope 规划 |
| tarball | `pnpm pack` → 发布 `.tgz`（GitHub Release 附件） | `dsh plugin add ./xxx.tgz` | 不依赖 npm、产物可控 | 需手动下载附件，不能自动更新 |
| git 仓库 | 提供**自包含** `prepare` 构建脚本 | `dsh plugin add github:you/repo`（+ 授权 `allowBuilds`） | 无需发版 | git 安装拉源码不拉产物；pnpm ≥10 默认不跑 prepare；必须锁 commit；用户需信任并授权安装期执行代码 |

### 5.3 发布到 npm（推荐）

```sh
# 首次
npm login
# 构建产物（TypeScript 包先 build 出 lib/）
pnpm publish            # 或 npm publish；scoped 包记得 --access public
```

用户侧：

```sh
dsh plugin --profile demo add your-package-name
```

市场侧（可选）：在索引里把版本 `source` 写成 `{ "type": "npm" }`，读取器会安装 `name@version`（有 registry 字段时先询问它）。

### 5.4 GitHub 发布：够不够、怎么做

**够「分享源码」，不够「被市场发现」。** 实操建议：

1. 仓库加 **`dsh-plugin`** topic，README 写明「兼容/基于 DSH」和安装方式。
2. 打 tag 发布 GitHub Release，附上 `pnpm pack` 产出的 `.tgz`（用户可离线装）。
3. 用 GitHub Actions 在 tag 上 `npm publish`，并顺带重新生成/部署市场索引到 GitHub Pages。
4. 仓库里也可以放 `index.json` + `icons/`，用 GitHub Pages 直接当市场源（见 5.5）。

> GitHub 直装注意事项：`dsh plugin add github:you/repo` 拿的是源码，不跑 `build`。作者必须提供**自包含**的 `prepare` 脚本（如专用 tsdown 配置直接转译 `src/`，不依赖 monorepo），用户首次安装会被 pnpm 拒绝，需要把 pnpm 打印的包键写进 profile 的 `pnpm-workspace.yaml`：
>
> ```yaml
> allowBuilds:
>   your-plugin-name: true
> ```
>
> 这等于允许该包代码在安装时于用户机器上执行、且不在 agent 沙箱内，务必提示用户锁 commit（`github:you/repo#<sha>`）。

### 5.5 上架「发现」市场：发布你自己的静态索引

现状：**DSH 没有官方插件市场，也不内置索引源**；「发现」页只显示用户自己添加的索引源。市场 = 一份 UTF-8 JSON 索引 + 图标文件，放在任意静态主机（官方点名 GitHub Pages、GitLab Pages、https 对象存储）。

最小索引（`index.json`）：

```json
{
  "format": 1,
  "title": { "en": "My DSH plugins", "zh": "我的 DSH 插件" },
  "plugins": [
    {
      "name": "dsh-plugin-foo",
      "title": { "en": "Foo", "zh": "Foo 插件" },
      "description": { "en": "Adds the foo tool", "zh": "新增 foo 工具" },
      "icon": "icons/foo.svg",
      "author": "Your Name",
      "homepage": "https://github.com/you/dsh-plugin-foo#readme",
      "repository": { "url": "https://github.com/you/dsh-plugin-foo" },
      "versions": [
        {
          "version": "1.1.0",
          "publishTimestamp": 1790476800,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.0" }
        }
      ]
    }
  ]
}
```

关键规则（违反任意一条整份索引会被拒绝）：

- `format` 必填且为 `1`；`title` 必填；`plugins[].name` 必填且唯一。
- 每个版本必须有 `version`（精确 SemVer）、`publishTimestamp`（Unix 秒）、`source`。
- `source` 二选一：`{ "type": "npm", "registry"?: url }`，或 `{ "type": "git", "url": https-url, "commit": 40 位 SHA, "path"?: 目录 }`。
- `icon`：内联 `data:` base64（SVG/PNG/JPEG/WebP，解码后 ≤32 KiB），或 URL；相对路径相对索引 URL 解析，跨源绝对 URL 必须 `https:`。
- 索引默认上限 128 MiB，须 2xx 返回且不重定向。
- 文本字段支持 `{ "en": "...", "zh": "..." }` 多语言对象，**必须含 `en`**。

生成器（DSH 源码 checkout 自带，省得手写）：

```sh
# plugins.txt 每行一个 npm 包名或 https Git 仓库 URL
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output site/index.json --title "My DSH plugins"
```

- 生成器会把过大的图标写成 `site/icons/`，输出确定、带缓存、只读下载不执行包代码。
- 产物目录（`index.json` + `icons/`）整个发布到静态主机。
- 每次发新版本后重跑一次生成器，再部署。

用户侧使用：插件页 → **实验性插件** 旁的 **更多** → 打开 **自定义插件市场** → **发现** → **添加索引源** → 填 `https://you.github.io/your-market/index.json` → 搜索/安装。

> 市场是第三方内容：DSH 只校验文件格式，不校验标题/作者/来源声明的真实性。你自己的索引也要只列你审核过的包。

### 5.6 一句话版发布流程

```
本地 bundle → 语法/清单检查 → pnpm pack 验证文件 →（npm publish + git tag）
            → 生成/更新 index.json + icons → 部署到 GitHub Pages
            → README 加安装说明 + 仓库加 dsh-plugin topic
```

---

## 六、常见坑

1. **git 安装没有 `lib/`**：git 直装不跑 build，必须自带自包含 `prepare`，否则加载报模块找不到。
2. **pnpm ≥10 不跑 git 依赖构建**：用户首次 `add` 会失败，需要 `allowBuilds` 授权——等于允许安装期执行代码，提醒锁 commit。
3. **link 安装掩盖 `files` 缺失**：链接安装不过滤 `files`，只用 `pnpm pack` 后的 tarball 验证。
4. **覆盖 patch 行会整体替换 config**：改一个键也要重述该行所有键。
5. **会话事件不能自造 `type`**：会导致会话无法重开（`ignorable` 只能由 Host 侧写）。
6. **UI 不要越界**：iframe / 替换 app root / 写 `document.body` / import Harness Client 包 / 只用字面色——都会破坏主题、locale 或直接崩 slot。
7. **元数据别留模板文案**：`locale/en.json` 的 title/description 是用户和插件管理器看到的唯一说明。
8. **品牌**：项目名避免完整商标「DeepSeek Harness」，用「DSH」缩写；素材不得暗示官方背书。
9. **Desktop profile 特殊**：`desktop` profile 只能由 Desktop 自带 CLI（且先初始化、退出应用）或会话内插件管理器管理。
10. **版本不兼容会被拒**：`engines.dsh` 声明错会被安装器拒绝，需要显式版本豁免。
11. **市场索引是整份校验**：一个字段不合规，整个索引源报错、整份不显示。

---

## 七、本机参考资料索引

| 主题 | 路径 |
|---|---|
| 第一个插件 / 工具 / 配置 / 打包安装（教程） | `deepseek-harness\docs\user\develop\basic\{index,tool,config,publish}.zh.md` |
| 插件生命周期 / 服务与依赖 | `deepseek-harness\docs\user\develop\framework\` |
| 能力三分离实战 | `deepseek-harness\docs\user\develop\practice\index.zh.md` |
| 插件市场（含索引格式全表） | `deepseek-harness\docs\user\guide\plugin-market.zh.md` |
| 「发现」页参考 | `deepseek-harness\packages\client\ui-plugin-market\README.zh.md` |
| 市场服务 / 限制 / `plugin_market` 工具 | `deepseek-harness\packages\boot\plugin-market\README.zh.md` |
| 索引校验库 | `deepseek-harness\packages\util\plugin-market-index\README.zh.md` |
| 索引格式设计笔记（含每条规则） | `deepseek-harness\.agents\notes\implemented\feature\2026-10-02-plugin-market-index-format.zh.md` |
| 索引生成器 | `deepseek-harness\apps\plugin-market-generator\README.zh.md` |
| 插件包 manifest 类型 | `deepseek-harness\packages\util\package-manifest\README.zh.md` |
| 插件管理器（安装/兼容性/豁免） | `deepseek-harness\packages\boot\plugin-manager\README.zh.md` |
| CLI（profile / plugin / dump-config） | `deepseek-harness\apps\cli\README.zh.md`、`apps\cli\reference\README.zh.md` |
| Desktop（菜单安装 dsh 命令、内置运行时限制） | `deepseek-harness\apps\desktop\README.zh.md` |
| 官方 Agent skill（开发清单） | `deepseek-harness\packages\preset\agent-preset\skills\cordis-plugin-development\` |
| 品牌规范 | `deepseek-harness\BRAND_GUIDELINES.zh.md` |
| 贡献方式（不接受外部 PR、`dsh-plugin` topic） | `deepseek-harness\CONTRIBUTING.zh.md`、`README.zh.md` |
| 本工作区骨架 | `templates\host-bundle\`、`templates\ui-decoration\` |

> 源码 checkout 版本是 `0.2.1-rc.2`，Desktop 里实际安装的包约 `0.2.2-rc.1`；查 API 以运行中安装为准
> （agent 可用 `cordis_inspect_list` / `cordis_inspect_query`，或重新加载 `cordis-plugin-development` skill）。

---

## 八、下一步

1. 想清楚插件要做成什么：Host 工具（给模型用）、Web 面板/装饰（给用户看）、还是两者都有（推荐「一个操作两个调用方」）。
2. 复制 `templates/host-bundle`（纯 Host）或 `templates/ui-decoration`（带 Web UI）改名为你的包。
3. 把包名、`cordis.patch.yml` 行 id、locale、图标改成你的；先在 `desktop` profile 装起来看效果，再补功能。
4. 功能稳定后按第五章发布。
