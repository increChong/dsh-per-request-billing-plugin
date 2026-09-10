# dsh-per-request-billing

**DeepSeek Harness 的「按次计费模型优化」插件——一个可 `dsh plugin add` 安装的 npm 包。**

当某个模型按**请求次数**计费（而不是按 token）时，每一次往返都是固定成本。这个插件让你按**提供方**或**单个模型**标记「按次计费」，并在这些模型被使用时自动把调用方式往「更少请求、更长上下文」上引导；同时明确禁止为了减少请求而绕过授权与审批。

标记是持久化的：写进 profile 的 settings 文档，重启后仍在。

---

## 安装

本包同时是 **profile bundle**（`dsh.bundle.patch`）和**客户端插件**（`dsh.client`），所以安装一次即可同时得到宿主半与设置页 UI。

### 从 npm（发布后）

```sh
dsh plugin --profile web add dsh-per-request-billing
```

### 从 git（未发布也能装）

`dsh plugin` 只是 pnpm 的转发器，因此任何 pnpm 能解析的来源都可以：

```sh
# git 仓库（推荐）
dsh plugin --profile web add github:increChong/dsh-per-request-billing-plugin

# 本地目录（开发时最方便，改完 npm run build 即生效）
dsh plugin --profile web add /path/to/dsh-per-request-billing-plugin

# 打包后的 tarball
npm pack && dsh plugin --profile web add ./dsh-per-request-billing-0.1.0.tgz
```

装完**重启 profile**（`dsh --profile web`）。安装器会把声明了 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`，也就是 profile 的层栈。

### 卸载

```sh
dsh plugin --profile web remove dsh-per-request-billing
```

---

## 使用

重启后，设置面板会出现一个**「按次计费」**页；同时**模型配置页每个提供方卡片里**会出现勾选区。三级开关，判定优先级从高到低：

| 粒度 | 作用范围 |
| --- | --- |
| 单模型 | 只影响该模型（覆盖下面两级） |
| 提供方 | 该提供方下所有模型继承 |
| 全局 | 所有模型默认按次计费 |

模型清单自动从运行时读取（`llm.listConfigurableProviders()` + `settings.describe()`），新增提供方或在模型配置页加模型后会自动出现。配置里还没有的模型可以手动输入 id 加入。

也可以直接让模型调用两个工具：

| 工具 | 作用 |
| --- | --- |
| `billing_status` | 查询全局开关、各提供方模式、已标记模型，以及注入计数 |
| `billing_set` | `scope=global\|provider\|model` 切换标记（持久化） |

勾选后**从下一个模型步骤开始生效**。

---

## 自动优化做了什么

命中按次计费模型时，插件在**每一步组装系统提示词**时注入一段调用纪律：

- 先侦察后行动：一次 `bash` 用 `&&` 串联或同时读取多处，而不是一个文件一次调用；
- 互不依赖的工具调用**并行**发出，在同一个模型步骤内一起返回；
- 一次调用拿全量，宁可单次输出更长也不要为「省 token」多跑一轮；
- 同一轮内复用已有结果，不重复读取、不重复执行同样的命令；
- 一个回合内完成索取、修改与验证；
- **主动利用更长上下文**：把更多文件、更长日志一次性放进请求，只在真的触达上限时才压缩；
- 交付完整结果，避免下一轮补充。

同时给 `bash` / `pwsh` 的**本次组装**追加批量执行引导（工具 schema 是 per-assembly 克隆，不会污染工具注册表）。

### 安全底线（优先级高于上述全部）

> 为了减少请求次数，**绝不**意味着跳过授权、审批与安全校验。需要用户批准的操作仍然照常发起批准流程；不得把多个需要分别授权的动作合并成一个来绕过审批。**优化只作用于「调用方式」，不改变「是否被允许」。**

这段话本身也写在注入的提示词里，作为最高优先级约束。本插件不触碰 `approval`、沙箱或权限行。

---

## 实现要点（都是踩过的坑）

### 1. 不能用 `agent.options` 判断「当前模型」

`agent.options` 在**会话建立时**写入，用户中途切换模型**不会更新它**。在开发这个插件的环境里，它长期停在 `deepseek-official/deepseek-v4-pro`，而会话实际在跑 `deepseek-official/deepseek-flash`——只信它会让优化**静默失效**。

因此本插件收集全部候选路由并逐个判定，任一命中即注入：

1. `agentDefaultModel.currentSelection()` — 模型选择的权威所有者
2. 会话 `modelSelection` 投影的 `pending` / `lastUsed`
3. `agent.options` — 会话起点默认
4. 会话已记录的 request header — 最近一次实际使用的路由
5. `assembly.variables.provider/model` — 本次 waterfall 解析出的值

### 2. 组装钩子必须自带兜底

`system-prompt/assemble` 的结果由 `dsh-system-prompt` 的 invariant 校验：section 名不能重复、text 必须是字符串。钩子里任何异常都会破坏整个模型步骤，所以整个过程包在 `try/catch` 里，失败就原样返回未修改的 assembly。

### 3. 客户端 bundle 不是模块，是交给 loader 的工厂

浏览器半的产物形状是：

```js
window.__ModuleLoader__.load({
  id: 'dsh-per-request-billing',
  factory: (require) => { var module = { exports: {} }; /* 模块体 */ return module.exports },
})
```

`require` 由 loader 的**模块表**回答，因此只能使用平台已播种的 specifier（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`），其余通过 `dsh.client.external` 显式申请。**模块表答不上来的 `require` 是必然的运行时异常**，所以本包的客户端只 `require('react')`。

因为 bundle 是 CommonJS 格式，模块体里不能出现顶层 ESM `export`——本包的客户端源码直接写成 CJS（`exports.apply = ...`），并**没有**使用仓库里的 tsc + JSX 构建链，`npm run build` 只做 banner/prelude 包装与语法校验。

### 4. 模型 id 只能从 `models` 字段读

`llm-deepseek` 这类提供方的 profile 就在 settings 段的根上。如果把「对象的 key」当成模型字典，会把 `maxTokens`、`filesApiTimeoutMs` 这类配置键显示成模型。

### 5. 客户端↔宿主通信

真实插件没有动态插件那套 `host.call` builtin。本包在宿主侧注册一个同源 HTTP 路由（`/plugins/dsh-per-request-billing/state`，GET 读 / POST 写），客户端用 `fetch` 访问——两个调用不值得引入 Typert Remote 代码生成。该路由通过 `ctx.get('webServer')` **可选**获取，所以无头部署下这一行依然能激活。

---

## 开发

```sh
npm run build    # 由 src/client/index.js 生成 lib/client.js（含语法校验）
npm run check    # 契约检查（见下）
```

`npm run check` 不是风格检查，每条都对应运行时真的会炸的地方：

- 宿主半导出 `name` / `inject` / `apply`，且 `inject` 覆盖它用到的服务；
- 客户端 bundle 确实调用 `__ModuleLoader__.load` 并交出 factory；
- factory 在只播种 `react` 的情况下能跑通，`apply` 通过**真正触发回调**的 `inject` 注册出预期座位（设置页 + 两个提供方卡片家族）；
- 宿主路由走**真实 handler**：GET 返回目录，POST 落盘到 settings 命名空间，再 GET 能看到，未知 scope 返回 400 而不是崩掉。

本工作区没有 DSH 安装，所以检查会用 `DSH_INSTALL=<dsh 的 node_modules>` 为目标解析 peer 依赖：

```sh
DSH_INSTALL=/path/to/node_modules npm run check
```

## 已知限制

1. **需要 profile 有模型配置页**：`settings.models.provider-card` 座位由 `@deepseek-ai/dsh-client-ui-settings-models` 声明；没有该页的部署仍会注入策略、也会在设置页出现，但不显示提供方卡片内的勾选区。
2. **「增加上下文长度」是提示词引导，不是改配置**：上下文窗口由各适配器自己的 `contextWindow` 决定，插件不会去改写它。
3. **审批策略不变**：插件只改提示词与工具描述。

## License

MIT
