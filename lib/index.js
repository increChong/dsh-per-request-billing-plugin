/**
 * Per-request billing optimizer — host half.
 *
 * A profile-bundle plugin: this module runs in the DSH host process, so unlike
 * a dynamic Cordis package it has real imports, real services, and durable
 * storage. Marks live in a registered `settings` namespace, which means they
 * are written to the profile's settings document and survive a restart — the
 * one thing the dynamic-sandbox form could not do.
 *
 * @module dsh-per-request-billing
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Plugin name, as the loader reports it. */
export const name = 'per-request-billing'

/**
 * Services this plugin consumes. Declaring them is what makes the row activate
 * only once they exist, and what lets the composition audit see the edges.
 */
export const inject = ['llm', 'settings', 'systemPrompt', 'tools']

/** The settings namespace holding every mark this plugin persists. */
const NS = 'per-request-billing'

/** Schema of one route's mode. */
const billingMode = z.union(['per-request', 'per-token'])

/** The persisted shape: a global default, per-provider defaults, per-model marks. */
const Config = z.object({
  /** Every model is billed per request. */
  global: z.boolean().default(false),
  /** Provider route -> default mode for every model under it. */
  providerDefault: z.dict(billingMode).default({}),
  /** `provider/model` -> explicit mode, overriding both provider and global. */
  models: z.dict(billingMode).default({}),
})

function normMode(value) {
  return value === 'per-request' || value === 'per-token' ? value : undefined
}

/**
 * Resolve one route's mode: explicit model mark, then provider default, then
 * the global switch.
 * @param config - the current namespace value.
 * @param provider - provider route id.
 * @param model - model id.
 * @returns `per-request` or `per-token`.
 */
function modelMode(config, provider, model) {
  const explicit = normMode(config.models[String(provider) + '/' + String(model)])
  if (explicit !== undefined) return explicit
  const providerDefault = normMode(config.providerDefault[provider])
  if (providerDefault !== undefined) return providerDefault
  return config.global ? 'per-request' : 'per-token'
}

/**
 * Read model ids out of a provider profile's `models` field only.
 *
 * Walking arbitrary object keys would treat a whole config object as a model
 * dictionary: `llm-deepseek` keeps its profile at the section root, so a raw
 * key walk surfaces `maxTokens`, `filesApiTimeoutMs` and friends as models.
 * @param holder - a provider profile, or anything else.
 * @returns model ids in declaration order.
 */
function idsFromModelsField(holder) {
  if (holder === null || typeof holder !== 'object') return []
  const models = holder.models
  if (Array.isArray(models)) {
    const out = []
    for (const item of models) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0) out.push(item.id)
      else if (typeof item === 'string' && item.length > 0) out.push(item)
    }
    return out
  }
  if (models !== null && typeof models === 'object') return Object.keys(models)
  return []
}

function idsFromArray(node) {
  const out = []
  if (!Array.isArray(node)) return out
  for (const item of node) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0) out.push(item.id)
    else if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out
}

function readPath(root, path) {
  let node = root
  for (const seg of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[seg]
  }
  return node
}

/**
 * Collect the route candidates that could describe the request being
 * assembled, most authoritative first. The caller decides on the FIRST
 * candidate only — never on "any candidate that happens to be marked".
 *
 * `agent.options` is written when the session starts and is NOT updated when
 * the model is switched mid-session, and `agentDefaultModel.currentSelection()`
 * is a deployment-wide default that any session's model pick overwrites, so
 * neither describes "the model running right now". They are therefore demoted
 * to fallbacks; the ordered sources are:
 *
 *   1. `assembly.variables.provider/model` — resolved for THIS step. The agent
 *      scope rewrites these to the live selection while the waterfall unwinds,
 *      so a listener registered at boot observes the authoritative route.
 *   2. the session `modelSelection` projection's `pending` — a selection made
 *      for a request that has not been recorded yet
 *   3. the session's logged request header — the route the last request used,
 *      which is what the platform itself falls back to
 *   4. the projection's `lastUsed`, then `agent.options` — historical only, so
 *      they must never outvote a route that is still current
 * @param context - the plugin context.
 * @param assembly - the assembled prompt.
 * @param agent - the agent this assembly belongs to, when known.
 * @returns candidate routes, de-duplicated, in priority order.
 */
function resolveCandidates(context, assembly, agent) {
  const out = []
  const push = (provider, model, source) => {
    if (typeof provider !== 'string' || provider.length === 0) return
    if (typeof model !== 'string' || model.length === 0) return
    for (const item of out) if (item.provider === provider && item.model === model) return
    out.push({ provider, model, source })
  }

  // The resolved assembly variables are the authoritative route for this step.
  // Keep them first; all other sources are only fallbacks for diagnostics or
  // runtimes that do not install model-selection projection support.
  const variables = assembly !== null && typeof assembly === 'object' ? assembly.variables : undefined
  if (variables !== null && typeof variables === 'object') push(variables.provider, variables.model, 'assemble-variables')

  if (agent !== null && agent !== undefined) {
    const projections = context.get('sessionProjections')
    if (projections !== undefined) {
      try {
        const projected = projections.stateOf(agent.session, 'modelSelection')
        if (projected !== null && projected !== undefined && projected.pending !== null && projected.pending !== undefined) {
          push(projected.pending.provider, projected.pending.model, 'session-pending')
        }
      } catch {
        // Projection unavailable: skip.
      }
    }
    try {
      const header = agent.session.requestHeader()
      const config = header === undefined ? undefined : header.config
      if (config !== null && typeof config === 'object') push(config.provider, config.model, 'request-header')
    } catch {
      // No history yet: skip.
    }
    if (projections !== undefined) {
      try {
        const projected = projections.stateOf(agent.session, 'modelSelection')
        if (projected !== null && projected !== undefined && projected.lastUsed !== null && projected.lastUsed !== undefined) {
          push(projected.lastUsed.provider, projected.lastUsed.model, 'session-last-used')
        }
      } catch {
        // Projection unavailable: skip.
      }
    }
    const options = agent.options
    if (options !== null && typeof options === 'object') push(options.provider, options.model, 'agent-options')
  }
  return out
}

/**
 * Describe every configurable provider and its models for the UI and the tools.
 * @param context - the plugin context.
 * @param config - the current namespace value.
 * @returns a JSON-safe catalog.
 */
async function buildCatalog(context, config) {
  const llm = context.llm
  const providers = []
  let directory = []
  try {
    directory = llm.listConfigurableProviders()
  } catch (error) {
    context.logger?.warn?.(`listConfigurableProviders failed: ${String(error)}`)
  }
  if (directory.length === 0) {
    try {
      directory = llm.listProviders().map((entry) => ({
        provider: entry.id,
        displayName: entry.name,
        settingsNs: '',
        settingsPath: [],
      }))
    } catch (error) {
      context.logger?.warn?.(`listProviders failed: ${String(error)}`)
    }
  }

  let descriptors = null
  try {
    descriptors = context.settings.describe()
  } catch {
    descriptors = null
  }

  for (const entry of directory) {
    const settingsNs = String(entry.settingsNs ?? '')
    const settingsPath = Array.isArray(entry.settingsPath) ? entry.settingsPath.map(String) : []
    const ids = []
    const seen = new Set()
    const push = (id) => {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return
      seen.add(id)
      ids.push(id)
    }

    if (settingsNs.length > 0 && descriptors !== null) {
      const descriptor = descriptors.find((candidate) => String(candidate.ns) === settingsNs)
      if (descriptor !== undefined) {
        for (const id of idsFromModelsField(readPath(descriptor.user, settingsPath))) push(id)
        for (const id of idsFromArray(readPath(descriptor.user, settingsPath))) push(id)
        for (const id of idsFromArray(readPath(descriptor.value, settingsPath))) push(id)
        if (settingsPath.length === 0) {
          const resolved = descriptor.value
          const profiles = resolved !== null && typeof resolved === 'object' ? resolved.providers : undefined
          const profile = profiles !== null && typeof profiles === 'object' ? profiles[entry.provider] : undefined
          for (const id of idsFromModelsField(profile)) push(id)
        }
      }
    }

    if (ids.length === 0) {
      try {
        for (const info of await llm.listModels(entry.provider)) push(info.id)
      } catch {
        // Route not registered: keep the provider row without models.
      }
    }

    // A marked model that is not (yet) in the configuration must stay visible,
    // otherwise a mark would silently disappear from the UI.
    const prefix = String(entry.provider) + '/'
    for (const key of Object.keys(config.models)) {
      if (key.startsWith(prefix) && normMode(config.models[key]) !== undefined) push(key.slice(prefix.length))
    }

    const providerDefault = normMode(config.providerDefault[entry.provider])
    const providerMarked = providerDefault !== undefined ? providerDefault === 'per-request' : config.global
    providers.push({
      provider: String(entry.provider),
      displayName: typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : String(entry.provider),
      marked: providerMarked,
      explicit: providerDefault !== undefined,
      error: typeof entry.error === 'string' ? entry.error : null,
      models: ids.map((id) => ({
        id,
        marked: modelMode(config, entry.provider, id) === 'per-request',
        explicit: normMode(config.models[prefix + id]) !== undefined,
      })),
    })
  }

  let markedModels = 0
  let totalModels = 0
  for (const provider of providers) {
    totalModels += provider.models.length
    for (const model of provider.models) if (model.marked) markedModels += 1
  }

  return {
    global: config.global,
    providers,
    stats: { markedModels, totalModels },
  }
}

/**
 * The call-discipline policy injected for a per-request-billed model.
 *
 * The safety paragraph outranks every efficiency rule on purpose: the plugin's
 * job is to change HOW the model calls tools, never WHAT it is allowed to do.
 * @param provider - provider route id.
 * @param model - model id.
 * @param availableTools - tool names visible in this assembly.
 * @returns the section text.
 */
function sectionText(provider, model, availableTools) {
  const base = ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'read_image']
  const present = availableTools.length === 0 ? base : base.filter((tool) => availableTools.includes(tool))
  const tools = (present.length > 0 ? present : base).map((tool) => '`' + tool + '`').join('、')
  return [
    '[按次计费模式 · 自动优化已生效]',
    `当前模型 \`${provider}/${model}\` 被标记为「按次计费」：每次请求都是固定成本，与 token 用量无关。因此本轮的目标是**用尽可能少的请求次数完成同样的工作**，请遵守以下调用纪律：`,
    '1. 先侦察、后行动：动手前用 1 次调用批量收集信息，例如 `bash` 里用 `&&` 串联或同时读取多处内容，而不是每次只看一个文件。',
    `2. 并行发起互不依赖的工具调用（${tools} 等），让它们在同一个模型步骤内一起返回；不要串行地一次只发一个。`,
    '3. 一次调用拿全量：宁可单次输出更长（必要时配合 `limit` 调大、`grep` 加大上下文行数），也不要为了「省 token」而多跑一轮。',
    '4. 同一轮内已获得的结果要复用，不要重复读取或重复执行同样的命令；需要确认时优先在已有输出里查找。',
    '5. 一次性把活干完：不要用多轮小请求逐步试探，尽量在单个回合内完成索取、修改与验证。',
    '6. 主动利用更长上下文：可以把更多相关文件、更长日志与更完整的背景一次性放进请求；仅在确实触达上下文上限时才需要压缩，不要为省上下文而制造额外往返。',
    '7. 交付完整结果：回答写全（结论、关键证据、后续建议），避免下一轮再补充。',
    '**安全底线（优先级高于以上任何一条）**：为了减少请求次数，绝不意味着跳过授权、审批与安全校验。需要用户批准的操作仍然照常发起批准流程；不得把多个需要分别授权的动作合并成一个来绕过审批；不得为了少一轮而省略必要的校验或验证。优化只作用于「调用方式」，不改变「是否被允许」。',
    '（该指令由「按次计费模型优化」插件按当前模型自动注入。）',
  ].join('\n')
}

/** Section name owned by this plugin, replaced in place on every assembly. */
const SECTION = 'per-request-billing:optimize'

/** Appended to a tool description for this assembly only. */
const TOOL_NOTE = '\n\n[按次计费模式] 当前模型按次计费：把多条命令用 `&&` / `;` 合并成一次调用，或在一次调用里用一段脚本完成多步。同一步骤内可并行发起多个互不依赖的调用。不要为了省 token 而把一个任务拆成多次调用。安全底线：不得为此跳过授权与审批。'

/** Tools whose description gains {@link TOOL_NOTE} while the mode is active. */
const ANNOTATED_TOOLS = ['bash', 'pwsh']

/** Largest accepted write body. Every legitimate request is well under 1 KiB. */
const MAX_BODY_BYTES = 64 * 1024

function textRender(_args, value) {
  return [{ type: 'text', text: value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : '' }]
}

function catalogText(catalog) {
  const lines = [
    `按次计费配置：全局=${catalog.global ? '按次计费(全局)' : '按量计费(默认)'}；模型标记 ${catalog.stats.markedModels}/${catalog.stats.totalModels}；已注入优化提示词的步骤数=${catalog.stats.steps}`,
  ]
  if (catalog.providers.length === 0) lines.push('（未发现任何可配置的模型提供方）')
  for (const provider of catalog.providers) {
    const marked = provider.models.filter((model) => model.marked)
    if (marked.length === 0 && !provider.marked) continue
    const explicit = marked.filter((model) => model.explicit).map((model) => model.id)
    const inherited = marked.filter((model) => !model.explicit).map((model) => model.id)
    lines.push(
      `- ${provider.provider} [${provider.marked ? 'per-request' : 'per-token'}] `
      + (explicit.length > 0 ? `单模型: ${explicit.join(', ')}` : '')
      + (inherited.length > 0 ? `${explicit.length > 0 ? '；' : ''}继承: ${inherited.join(', ')}` : '')
      + (marked.length === 0 ? '（提供方级开关）' : ''),
    )
  }
  lines.push('说明：per-request = 按次计费，会自动注入「少调用 + 长上下文」策略；per-token = 按量计费，不做任何干预。修改后从下一步组装提示词时生效。')
  return lines.join('\n')
}

/**
 * The plugin body.
 * @param ctx - the plugin context carrying the injected services.
 */
export function apply(ctx) {
  const stats = { steps: 0 }

  /** Latest committed namespace value; kept fresh by the settings scope. */
  let config = Config({})

  const scope = ctx.settings.register(NS, Config, { applies: 'live' })
  const sync = () => {
    config = scope.get()
  }
  sync()
  ctx.effect(() => scope.watch(() => {
    sync()
  }), 'per-request-billing: settings watch')

  /**
   * Record one mark at `path`, unless the level already inherits that value —
   * storing an inherited value as an explicit one would freeze the level and
   * stop it following its parent.
   * @param ops - the op list being built.
   * @param path - `['providerDefault', provider]` or `['models', key]`.
   * @param on - the mode the user asked for.
   * @param inheritedOn - whether the level currently inherits "per-request".
   */
  const markOp = (ops, path, on, inheritedOn) => {
    if (on === inheritedOn) ops.push({ op: 'unset', path })
    else ops.push({ op: 'set', path, value: on ? 'per-request' : 'per-token' })
  }

  /**
   * Persist one mark.
   *
   * `mutate` is used rather than `update` because the two need different
   * things: `update` merges, so it can only ever add or overwrite a key, while
   * switching a parent level has to *remove* the marks underneath it. Without
   * that removal a model marked once would keep outvoting its provider forever.
   * @param body - one of the write requests the UI sends.
   * @returns nothing; the next assembly reads the committed value.
   */
  async function write(body) {
    const scopeKind = String(body.scope)
    const on = body.on === true

    if (scopeKind === 'global') {
      // The root switch owns every level below it: toggling it re-establishes
      // inheritance for all of them.
      const ops = [
        ...Object.keys(config.models).map((key) => ({ op: 'unset', path: ['models', key] })),
        ...Object.keys(config.providerDefault).map((provider) => ({ op: 'unset', path: ['providerDefault', provider] })),
      ]
      if (on) ops.push({ op: 'set', path: ['global'], value: true })
      else ops.push({ op: 'unset', path: ['global'] })
      await ctx.settings.mutate(NS, ops)
      return
    }

    if (scopeKind === 'provider') {
      const provider = String(body.provider)
      const prefix = provider + '/'
      // Toggling a provider re-establishes inheritance for its own models, so
      // one marked individually follows the provider again from here on.
      const ops = Object.keys(config.models)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ op: 'unset', path: ['models', key] }))
      markOp(ops, ['providerDefault', provider], on, config.global === true)
      await ctx.settings.mutate(NS, ops)
      return
    }

    if (scopeKind === 'model') {
      const provider = String(body.provider)
      const key = provider + '/' + String(body.model)
      const providerDefault = normMode(config.providerDefault[provider])
      const inheritedOn = providerDefault === undefined ? config.global === true : providerDefault === 'per-request'
      const ops = []
      markOp(ops, ['models', key], on, inheritedOn)
      await ctx.settings.mutate(NS, ops)
      return
    }

    throw new Error(`unknown scope: ${scopeKind}`)
  }

  // ---------------------------------------------------------------- assembly
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      const agent = context !== null && typeof context === 'object' ? context.agent : undefined
      // Decide on the single most authoritative route. Scanning every
      // candidate for a mark would apply the policy to a session that merely
      // *used* a marked model at some earlier point — see resolveCandidates.
      const route = resolveCandidates(ctx, assembled, agent)[0]
      if (route === undefined) return assembled
      if (modelMode(config, route.provider, route.model) !== 'per-request') return assembled

      const toolNames = Array.isArray(assembled.tools)
        ? assembled.tools.filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string').map((tool) => tool.name)
        : []

      const sections = Array.isArray(assembled.sections) ? assembled.sections.slice() : []
      const injected = { name: SECTION, text: sectionText(route.provider, route.model, toolNames) }
      const index = sections.findIndex((section) => section !== null && typeof section === 'object' && section.name === SECTION)
      if (index === -1) sections.push(injected)
      else sections[index] = injected

      // Tool schemas are per-assembly clones, so annotating one here cannot
      // leak into the registry or another agent's view.
      if (Array.isArray(assembled.tools)) {
        for (const tool of assembled.tools) {
          if (tool === null || typeof tool !== 'object' || typeof tool.description !== 'string') continue
          if (!ANNOTATED_TOOLS.includes(tool.name)) continue
          if (tool.description.includes('[按次计费模式]')) continue
          tool.description += TOOL_NOTE
        }
      }

      stats.steps += 1
      return { ...assembled, sections }
    } catch (error) {
      // A failure here must never break a model step: leave the prompt as is.
      ctx.logger?.warn?.(`assemble hook failed, prompt left untouched: ${String(error)}`)
      return assembled
    }
  })

  // ------------------------------------------------------------------- tools
  ctx.tools.register(defineTool({
    name: 'billing_status',
    description: '查询各模型提供方与模型的「按次计费」标记：返回全局开关、每个提供方的模式、以及已标记为按次计费的模型列表。按次计费的模型会自动获得「尽量少发起请求、主动使用更长上下文」的调用策略。',
    parameters: {},
    output: { schema: { type: 'json' }, render: textRender },
    async execute() {
      const catalog = await buildCatalog(ctx, config)
      catalog.stats.steps = stats.steps
      return { text: catalogText(catalog), ...catalog }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'billing_set',
    description: '切换「按次计费」标记。scope=provider 时按整个提供方切换（其下所有模型继承）；scope=model 时必须同时给出 provider 与 model，只切换该模型；scope=global 时切换全局开关。on=false 会把该粒度显式设为「按量计费」，因此单个模型可以退出按次计费的提供方。修改会持久化，从下一个模型步骤开始生效。',
    parameters: {
      scope: { type: 'string', required: true, enum: ['global', 'provider', 'model'], description: '切换粒度：global / provider / model。' },
      provider: { type: 'string', description: '提供方路由 id（scope=provider 或 model 时必填），可用 billing_status 查看。' },
      model: { type: 'string', description: '模型 id（scope=model 时必填），可用 billing_status 查看。' },
      on: { type: 'boolean', required: true, description: 'true=按次计费，false=按量计费（显式覆盖，优先级高于提供方与全局开关）。' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const scopeKind = String(args.scope)
      if ((scopeKind === 'provider' || scopeKind === 'model') && (typeof args.provider !== 'string' || args.provider.length === 0)) {
        throw new Error('billing_set: scope=provider/model 需要 provider 参数')
      }
      if (scopeKind === 'model' && (typeof args.model !== 'string' || args.model.length === 0)) {
        throw new Error('billing_set: scope=model 需要 model 参数')
      }
      await write({ scope: scopeKind, provider: args.provider, model: args.model, on: args.on === true })
      const catalog = await buildCatalog(ctx, config)
      catalog.stats.steps = stats.steps
      return { text: '已更新。\n' + catalogText(catalog), ...catalog }
    },
  }))

  // ------------------------------------------------------ client transport
  // The browser half is served from this same origin and asks the host over
  // plain HTTP: a real plugin has no `host.call` builtin, and a Remote service
  // would drag in the Typert code generator for two calls. The service is read
  // optionally because a headless deployment has no web server at all, and a
  // hard dependency would keep this row from activating there.
  const ROUTE = '/plugins/dsh-per-request-billing/state'
  const webServer = ctx.get('webServer')

  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(payload))
        }
        try {
          if (req.method === 'GET') {
            const catalog = await buildCatalog(ctx, config)
            catalog.stats.steps = stats.steps
            send(200, { ok: true, catalog })
            return
          }
          if (req.method === 'POST') {
            // Requiring a JSON content type is the CSRF guard: a cross-site
            // fetch that sets it triggers a preflight this route never answers,
            // while the simple requests an attacker CAN send (form posts,
            // text/plain) are refused here before the body is read.
            const contentType = String(req.headers?.['content-type'] ?? '')
            if (!contentType.toLowerCase().startsWith('application/json')) {
              send(415, { ok: false, message: 'content-type must be application/json' })
              return
            }
            const chunks = []
            let size = 0
            for await (const chunk of req) {
              size += chunk.length
              if (size > MAX_BODY_BYTES) {
                send(413, { ok: false, message: `request body exceeds ${MAX_BODY_BYTES} bytes` })
                return
              }
              chunks.push(chunk)
            }
            let body
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              send(400, { ok: false, message: 'request body is not JSON' })
              return
            }
            await write(body)
            const catalog = await buildCatalog(ctx, config)
            catalog.stats.steps = stats.steps
            send(200, { ok: true, catalog })
            return
          }
          send(405, { ok: false, message: 'method not allowed' })
        } catch (error) {
          // A rejected write is the caller's fault (unknown scope, bad value);
          // anything else is ours and must be reported as such.
          const message = error instanceof Error ? error.message : String(error)
          send(message.startsWith('unknown scope') ? 400 : 500, { ok: false, message })
        }
      },
    }), 'per-request-billing: client state route')
  }

  ctx.logger?.info?.(`per-request-billing ready (namespace: ${NS})`)
}
