# 按次计费模型优化（dsh-per-request-billing）

DeepSeek Harness（DSH）插件：把**按请求次数计费**的模型（通常是包月或按次计费的第三方中转/订阅）标记出来，并在用到它们时自动把调用方式往「更少请求、更长上下文」上引导——同时守住一条底线：**减少请求次数绝不意味着跳过授权与审批**。

## 引言

按 token 计费的模型，省钱的办法是少读少写；按**次数**计费的模型正相反——每一次往返都是固定成本，跟这次往返里带了多少 token 无关。同一个任务，拆成 20 次小请求和压成 4 次大请求，账单能差五倍。

麻烦在于两件事都没有现成开关：一是「哪些模型是按次计费的」这件事只在你脑子里，运行时并不知道；二是就算知道了，模型自己也不会因此改变习惯——它照样一个文件读一次、一步只发一个工具调用。

所以做了这个插件：先把「按次计费」变成一个可持久化的标记（提供方级 / 单模型级 / 全局），再让标记在每一次组装系统提示词时生效，把调用纪律直接写进提示词。判定依据不是猜的——它会把当前会话所有可能代表「正在使用的模型」的来源都收上来逐个比对，避免因为读错一个字段而静默失效。

## 功能

- **三级「按次计费」标记**，判定优先级从高到低：单模型 → 提供方（其下所有模型继承）→ 全局（所有模型默认按次计费）
- **标记持久化**：写在 profile 的 settings 文档里（`settings.register` 命名空间），重启后仍在
- **模型清单自动读取**：从运行时取每个提供方实际配置的模型（`llm.listConfigurableProviders()` + `settings.describe()`），新增提供方或加模型后自动出现；配置里还没有的模型可以手动输入 id 加入
- **两个 UI 入口**：设置面板的「按次计费」整页，以及**模型配置页每个提供方卡片内**的勾选区（渲染在你配 API Key / 模型的那张卡片里）
- **每步组装时注入调用纪律**（仅命中按次计费模型时）：批量与并行调用工具、一次拿全量、复用已有结果、一个回合内完成索取-修改-验证、主动利用更长上下文、交付完整结果
- **工具描述优化**：命中时给 `bash` / `pwsh` 的**本次组装**追加批量执行引导（schema 是 per-assembly 克隆，不会污染工具注册表，也不影响其他 agent）
- **模型可调用的工具**：`billing_status` 查询、`billing_set` 切换（持久化），所以也可以直接说「把 xx 提供方设成按次计费」
- **多来源路由判定**：不依赖单个字段（原因见下）

## 安装

**从 GitHub 安装**（仓库存有构建产物 `lib/`，不需要现场构建）：

```bash
dsh plugin --profile web add github:increChong/dsh-per-request-billing-plugin
dsh web   # 重启 web 服务使 profile 生效
```

**本地安装**（开发时最方便，改完 `npm run build` 即生效）：

```bash
git clone https://github.com/increChong/dsh-per-request-billing-plugin.git
dsh plugin --profile web add /path/to/dsh-per-request-billing-plugin
dsh web
```

**从 tarball 安装**：

```bash
npm pack && dsh plugin --profile web add ./dsh-per-request-billing-0.1.0.tgz
```

`dsh plugin` 是 pnpm 的转发器，因此 path / git / tarball 都能装，不必先发 npm。安装后声明了 `dsh.bundle` 的依赖会被自动登记为 profile 的 bundle 层，不用手工编辑任何文件。

## 卸载

```bash
dsh plugin --profile web remove dsh-per-request-billing
```

## 使用

打开 **设置 → 按次计费**：

- 顶部一行是全局开关与统计（已标记模型数 / 已注入优化提示词的步骤数）
- 每个提供方一张卡片：提供方级总开关 + 该提供方所有模型的勾选芯片
- 芯片上标注 `继承`（跟随提供方）或 `单独设置`（自己覆盖）；勾选的显示为告警色
- 底部有「清除单模型勾选」按钮，以及手动输入模型 id 的输入框

**模型配置页 → 任意提供方卡片内**：同一套开关，位置更贴近你的配置动作。

也可以直接让模型操作：

```
billing_status                     # 看当前标记与判定情况
billing_set  scope=provider  提供方=xxx  on=true
billing_set  scope=model     提供方=xxx  模型=yyy  on=true
```

勾选后**从下一个模型步骤开始生效**。

## 实现要点（都是踩过的坑）

### 不能用 `agent.options` 判断「当前模型」

`agent.options` 在**会话建立时**写入，用户中途切换模型**不会更新它**。开发这个插件的环境里，它长期停在 `deepseek-official/deepseek-v4-pro`，而会话实际在跑 `deepseek-official/deepseek-flash`——只信这一个字段会让优化**静默失效**，而且完全看不出来。

因此本插件把全部候选来源收集起来逐个比对，任一命中即注入：

1. `agentDefaultModel.currentSelection()` — 模型选择的权威所有者
2. 会话 `modelSelection` 投影的 `pending` / `lastUsed`
3. `agent.options` — 会话起点默认
4. 会话已记录的 request header — 最近一次实际使用的路由
5. `assembly.variables.provider/model` — 本次 waterfall 解析出的值

### 组装钩子必须自带兜底

`system-prompt/assemble` 的结果由 `dsh-system-prompt` 的 invariant 校验：section 名不能重复、text 必须是字符串。钩子里任何异常都会破坏整个模型步骤，所以整个过程包在 `try/catch` 里，失败就原样放行未修改的 assembly。

### 模型 id 只能从 `models` 字段读

`llm-deepseek` 这类提供方的 profile 就在 settings 段的根上。如果把「对象的 key」当成模型字典，会把 `maxTokens`、`filesApiTimeoutMs` 这类配置键显示成模型。

### 客户端 bundle 不是模块，是交给 loader 的工厂

浏览器半的产物形状是：

```js
window.__ModuleLoader__.load({
  id: 'dsh-per-request-billing',
  factory: (require) => { var module = { exports: {} }; /* 模块体 */ return module.exports },
})
```

`require` 由 loader 的**模块表**回答，所以只能使用平台已播种的 specifier（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`），其余要经 `dsh.client.external` 显式申请。**模块表答不上来的 `require` 是必然的运行时异常**，所以本包客户端只 `require('react')`。

bundle 是 CommonJS 格式，模块体里不能有顶层 ESM `export`——因此客户端源码直接写成 CJS（`exports.apply = ...`），`npm run build` 只做 banner/prelude 包装与语法校验，不依赖仓库的 tsc + JSX 构建链。

### 客户端 ↔ 宿主

真实插件没有动态插件那套 `host.call` builtin。本包在宿主侧注册一个同源 HTTP 路由（`/plugins/dsh-per-request-billing/state`，GET 读 / POST 写），客户端用 `fetch` 访问——两个调用不值得引入 Typert Remote 代码生成。该路由用 `ctx.get('webServer')` **可选**获取，所以无头部署下宿主行依然会激活（只是没有 UI）。

## 要求与开发

- 是**标准形态的双半身插件**：宿主半提供 settings 命名空间、组装钩子与两个工具；客户端半通过 `settings.section` 与 `settings.models.provider-card` 两个座位提供 UI。
- 依赖划分：`@deepseek-ai/schemastery` 是真实 npm 依赖；DSH 自身的包（`dsh-tools`、`dsh-settings`、`dsh-system-prompt`、`dsh-llm` …）全部声明为 **peerDependencies**，由运行时提供——这与官方 `dsh-tool-bash` 的做法一致，因此本包在零依赖环境下也能 `npm pack`。
- 需要 profile 有模型配置页：`settings.models.provider-card` 座位由 `@deepseek-ai/dsh-client-ui-settings-models` 声明。

```bash
npm run build          # 由 src/client/index.js 生成 lib/client.js（含语法校验）
npm run check:package  # 包形状检查（零依赖，npm pack 前自动执行）
npm run check          # 契约检查（需要 DSH 安装，见下）
```

`npm run check` 的每条断言都对应运行时真的会炸的地方，不是风格检查：宿主半的导出形状与 `inject` 覆盖、客户端 bundle 是否真的交付 factory、factory 在**只播种 `react`** 时能否跑通并通过**真正触发回调**的 `inject` 注册出预期座位、以及宿主路由走**真实 handler** 的完整读写往返（GET 读目录 → POST 落盘到 settings 命名空间 → 再 GET 可见 → 未知 scope 返回 400 而不崩）。

本工作区没有 DSH 安装，所以检查用 `DSH_INSTALL` 指向 DSH 的 `node_modules` 来解析 peer 依赖：

```bash
DSH_INSTALL=/path/to/node_modules npm run check
```

## 已知限制

- **本包尚未在真实 profile 中端到端验证过。** 已验证的是上述契约检查（含客户端↔宿主的真实读写往返）；未经真实运行验证的是 `dsh plugin add` 的解析、浏览器里的实际渲染，以及 peer 版本匹配（当前写的是 `"*"`，如需可钉到 `^0.1.5-rc.1`）。装完若座位不出现或 pnpm 报 peer 冲突，请提 issue。
- **「增加上下文长度」是提示词引导，不是改配置。** 上下文窗口由各适配器自己的 `contextWindow` 决定，插件不会去改写它；这里做的是让模型主动把更多内容放进单次请求、不提前触发压缩。
- **审批策略不变。** 插件只改提示词与工具描述，不触碰 `approval`、沙箱或权限行。注入的提示词里也写明了这条底线，且优先级高于所有效率规则。
- **只影响被标记的模型。** 未标记的模型完全不受影响（判定不命中就原样返回 assembly）。

## 数据与隐私

- 标记（全局开关、提供方级默认、单模型覆盖）保存在 profile 的 **settings 文档**中，通过 DSH 的 `settings` 服务读写，不额外落盘、不联网。
- 插件的 HTTP 路由挂在 DSH WebServer 上，只服务两个 JSON 读写；它不读文件、不读凭据、不发起任何出站请求。与其它 WebServer 路由一样，**不要把 DSH 的 WebServer 暴露到公网**。
- 注入的提示词与工具描述只作用于当前模型请求，不写入任何外部系统。

## License

[MIT](./LICENSE)
