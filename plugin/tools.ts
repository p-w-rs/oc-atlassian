import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { ToolInfo } from "./mcp.js"
import { API_TOKEN, capabilityOf, classifyAction, classifyRest, mergeAccount, normalizeAccount, validAccountId, type Account, type Discovery } from "./model.js"
import type { AtlassianService } from "./service.js"

export const TOOL_NAMES = [
  "atlassian_list", "atlassian_find_actions", "atlassian_run", "atlassian_rest",
  "atlassian_account_upsert", "atlassian_account_remove", "atlassian_signin", "atlassian_refresh", "atlassian_request_token",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

const MAX_OUTPUT = 60_000
const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const ACCOUNT = { type: "string", description: "Account id or site URL (optional when there is only one account)" }

export const USAGE = [
  "Load the 'atlassian' skill before non-trivial Jira/Confluence work (JQL, CQL, content formats, transitions, fields).",
  "Workflow: atlassian_find_actions to find the action and its parameters (query by keyword, then names=[...] for full schemas), then atlassian_run. cloudId is filled in for you.",
  "Accounts that sign in with a token can also use atlassian_rest for any REST endpoint.",
].join("\n")

function describe(account: Account, discovery: Discovery | undefined): string {
  const who = discovery?.name ?? discovery?.email ?? (discovery?.accountId ? "signed in" : "not signed in")
  const products = discovery?.products ? Object.entries(discovery.products).map(([product, access]) => `${product} ${access}`).join(", ") : undefined
  const how = account.auth === "browser" ? "browser sign-in, agent actions" : account.auth === "token" ? "API token, REST" + (discovery?.actions ? " + agent actions" : "") : "Data Center token, REST"
  return `  ${account.id}: ${account.site} — ${who}; ${how}${products ? `; ${products}` : ""}${account.label ? ` (${account.label})` : ""}${discovery?.error ? ` [problem: ${discovery.error.slice(0, 120)}]` : ""}`
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>): string {
  if (!accounts.length) return "No Atlassian accounts are configured yet. Create one with atlassian_account_upsert (site, auth), then atlassian_signin."
  return ["Atlassian accounts (Jira and Confluence sites you can work in):", ...accounts.map(account => describe(account, discovery[account.id]))].join("\n")
}

/** Ranks actions by how well they match a keyword query. */
export function searchActions(tools: readonly ToolInfo[], query: string): ToolInfo[] {
  const words = query.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1)
  if (!words.length) return [...tools]
  const score = (tool: ToolInfo) => {
    const name = tool.name.toLowerCase(), text = `${name} ${(tool.description ?? "").toLowerCase()}`
    return words.reduce((sum, word) => sum + (name.includes(word) ? 3 : text.includes(word) ? 1 : 0), 0)
  }
  return tools.map(tool => [tool, score(tool)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([tool]) => tool)
}

const clip = (text: string) => text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} characters; narrow the request (fields, limit, pagination)]` : text
const summarize = (value: unknown) => { const text = JSON.stringify(value); return text.length > 400 ? `${text.slice(0, 400)}…` : text }

export function createTools(service: AtlassianService): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })

  return [
    {
      name: "atlassian_list",
      description: () => {
        const { accounts, discovery } = service.store.cached()
        return `${inventory(accounts, discovery)}\n${USAGE}\nCall this tool for details and what you may do (allow / ask = the user is prompted / deny).`
      },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const settings = await service.store.settings()
        const accounts = await Promise.all((await service.store.list()).map(async account => {
          const discovery = await service.store.discovery(account.id)
          const signIn = service.signIns.get(account.id)
          const may = Object.fromEntries(await Promise.all(["jira-read", "jira-write", "jira-delete", "jira-admin", "confluence-read", "confluence-write", "confluence-delete", "confluence-admin"].map(async capability =>
            [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const)))
          return {
            id: account.id, site: account.site, auth: account.auth, ...(account.label && { label: account.label }),
            signedInAs: discovery?.name ?? discovery?.email ?? discovery?.accountId ?? null, products: discovery?.products,
            agentActions: discovery?.actions ?? 0, rest: account.auth !== "browser", secrets: await service.secretStatus(account),
            ...(signIn?.status === "waiting" && { signIn: `waiting for the user: ${signIn.url}` }), ...(discovery?.error && { problem: discovery.error }),
            ...(settings.defaultAccount === account.id && { default: true }), youMay: may,
          }
        }))
        return json({ accounts, usage: USAGE })
      },
    },
    {
      name: "atlassian_find_actions",
      description: () => "Find Atlassian actions (Jira and Confluence operations) by keyword, e.g. 'transition issue', 'create page', 'sprint', 'worklog'. Returns names and summaries; pass names=[...] to get their full parameter schemas before calling atlassian_run.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, query: { type: "string", maxLength: 200 }, names: { type: "array", items: { type: "string" }, maxItems: 20 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      execute: async (input: { account?: string; query?: string; names?: string[]; limit?: number }) => {
        const account = await service.pick(input.account)
        if (!service.usesActions(account)) return json({ account: account.id, actions: [], note: "This account uses the REST APIs: call atlassian_rest (see the atlassian skill for endpoints)." })
        const tools = await service.actions(account)
        if (input.names?.length) {
          const found = input.names.map(name => tools.find(tool => tool.name === name) ?? { name, missing: true })
          return json({ account: account.id, actions: found.map(tool => "missing" in tool ? tool : { name: tool.name, kind: capabilityOf(classifyAction(tool.name)), description: tool.description, parameters: tool.inputSchema }) })
        }
        const matches = searchActions(tools, input.query ?? "").slice(0, input.limit ?? 25)
        return json({
          account: account.id, total: tools.length,
          actions: matches.map(tool => ({ name: tool.name, kind: capabilityOf(classifyAction(tool.name)), summary: (tool.description ?? "").split("\n")[0]!.slice(0, 240) })),
          next: "Call atlassian_find_actions names=[...] for parameters, then atlassian_run.",
        })
      },
    },
    {
      name: "atlassian_run",
      description: () => "Run an Atlassian action found with atlassian_find_actions, e.g. action='searchJiraIssuesUsingJql' arguments={jql:'assignee = currentUser() AND resolution = Unresolved'}. cloudId is filled in when omitted. Destructive or admin actions may ask the user first.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, action: { type: "string", minLength: 1, maxLength: 120 }, arguments: { type: "object", additionalProperties: true } },
        required: ["action"], additionalProperties: false,
      },
      execute: async (input: { account?: string; action: string; arguments?: Record<string, unknown> }, context) => {
        const account = await service.pick(input.account)
        if (!service.usesActions(account)) throw new Error(`${account.id} uses the REST APIs: call atlassian_rest instead.`)
        const tools = await service.actions(account)
        const tool = tools.find(item => item.name === input.action)
        if (!tool) {
          const near = searchActions(tools, input.action).slice(0, 5).map(item => item.name)
          throw new Error(`No action ${JSON.stringify(input.action)}.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use atlassian_find_actions.`)
        }
        const args = { ...(input.arguments ?? {}) }
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
        if ("cloudId" in properties && args.cloudId === undefined) {
          const cloudId = await service.cloudId(account)
          if (cloudId) args.cloudId = cloudId
        }
        await check(context, capabilityOf(classifyAction(tool.name)), account.id, { action: tool.name, arguments: summarize(input.arguments ?? {}), site: account.site })
        const result = await service.mcp(account).call(tool.name, args)
        if (result.isError) throw new Error(`${tool.name} failed: ${clip(result.text)}`)
        return { content: clip(result.text || "(no output)") }
      },
    },
    {
      name: "atlassian_rest",
      description: () => "Call any Jira or Confluence REST endpoint for accounts that sign in with an API token or Data Center token. Paths are relative to the product, e.g. product=jira GET /rest/api/3/search/jql?jql=…, product=confluence GET /api/v2/pages/123 (Cloud) or /rest/api/content/123 (Data Center).",
      input: {
        type: "object",
        properties: {
          account: ACCOUNT, product: { type: "string", enum: ["jira", "confluence"] },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string", minLength: 1, maxLength: 2000 },
          query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } }, body: {},
        },
        required: ["product", "method", "path"], additionalProperties: false,
      },
      execute: async (input: { account?: string; product: "jira" | "confluence"; method: string; path: string; query?: Record<string, unknown>; body?: unknown }, context) => {
        const account = await service.pick(input.account)
        if (/^https?:/.test(input.path)) throw new Error("path must be relative to the product, e.g. /rest/api/3/myself")
        await check(context, capabilityOf(classifyRest(input.product, input.method, input.path)), account.id, { request: `${input.method} ${input.product}${input.path}`, ...(input.body !== undefined && { body: summarize(input.body) }), site: account.site })
        const result = await service.rest(account, input.product, input.method, input.path, { ...(input.query && { query: input.query }), ...(input.body !== undefined && { body: input.body }) })
        return { content: clip(typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? { status: result.status }, null, 2)) }
      },
    },
    {
      name: "atlassian_account_upsert",
      description: () => "Create or update an Atlassian account (fields merge; null clears). site: e.g. https://acme.atlassian.net or a Data Center URL. auth: browser (Atlassian Cloud, works with SSO; recommended), token (Cloud email + API token), pat (Data Center personal access token). Never pass tokens here.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Name chosen by the user, e.g. work" },
          rename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
          site: { type: "string" }, auth: { type: "string", enum: ["browser", "token", "pat"] }, email: { type: ["string", "null"] },
          confluenceUrl: { type: ["string", "null"], description: "Data Center only: Confluence base URL if different from site" },
          label: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
        },
        required: ["id"], additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) { await service.vault.renameEntity(id, target); await service.policy.renameEntity(id, target) }
        if (existing && existing.auth !== saved.auth) await service.signOut(saved)
        const secrets = await service.secretStatus(saved)
        const next = saved.auth === "browser"
          ? (secrets["access-token"] === "unset" ? `sign in: atlassian_signin account=${saved.id}` : undefined)
          : (secrets[API_TOKEN] === "unset" ? `ask the user for the token: atlassian_request_token account=${saved.id}` : undefined)
        return json({ saved, secrets, ...(next && { next }) })
      },
    },
    {
      name: "atlassian_account_remove",
      description: () => "Delete an Atlassian account with its stored sign-in and permission settings. Asks the user by default. Does not change anything in Atlassian.",
      input: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
      execute: async (input: { account: string }, context) => {
        const account = await service.pick(input.account)
        await check(context, "remove", account.id)
        service.signIns.get(account.id)?.flow.cancel()
        service.signIns.delete(account.id)
        await service.store.remove(account.id)
        await service.vault.deleteEntity(account.id)
        await service.policy.removeEntity(account.id)
        await service.requests.remove({ entity: account.id })
        return json({ removed: account.id })
      },
    },
    {
      name: "atlassian_signin",
      description: () => "Start the browser sign-in for a Cloud account (auth=browser). Returns a link for the user to open on this computer; it completes in the background once they approve (including Microsoft or other single sign-on). wait blocks up to that many seconds.",
      input: { type: "object", properties: { account: ACCOUNT, wait: { type: "integer", minimum: 0, maximum: 600 } }, additionalProperties: false },
      execute: async (input: { account?: string; wait?: number }, context) => {
        const account = await service.pick(input.account)
        await check(context, "manage", account.id, { operation: "sign in" })
        const state = await service.startSignIn(account)
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (state.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = state.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, status: state.status,
          ...(state.status === "waiting" && { tellUser: `Open this link on this computer, sign in to Atlassian (your organization's single sign-on if asked), choose ${account.site} and approve: ${state.url}  — or click Sign in in OpenCode's Atlassian view.` }),
          ...(state.error && { error: state.error }),
          ...(discovery && { signedInAs: discovery.name ?? discovery.email ?? discovery.accountId, products: discovery.products, actions: discovery.actions, ...(discovery.error && { problem: discovery.error }) }),
        })
      },
    },
    {
      name: "atlassian_refresh",
      description: () => "Check an account again: who it is, which products and how many actions it has (after the user signed in, changed permissions, or something failed).",
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }) => {
        const account = await service.pick(input.account)
        return json({ account: account.id, ...(await service.rediscover(account)) })
      },
    },
    {
      name: "atlassian_request_token",
      description: () => "Ask the user to enter the API token (Cloud) or personal access token (Data Center) for an account. They enter it outside the chat; you only learn whether it is set.",
      input: { type: "object", properties: { account: ACCOUNT, purpose: { type: "string", maxLength: 300 } }, additionalProperties: false },
      execute: async (input: { account?: string; purpose?: string }, context) => {
        const account = await service.pick(input.account)
        if (account.auth === "browser") throw new Error(`${account.id} uses browser sign-in: call atlassian_signin`)
        await service.requests.add({ entity: account.id, name: API_TOKEN, purpose: input.purpose ?? "", sessionID: context.sessionID })
        return json({
          status: (await service.vault.has(account.id, API_TOKEN)) ? "set (the user may replace it)" : "unset",
          tellUser: `Please enter the ${account.auth === "pat" ? "personal access token" : "API token (https://id.atlassian.com/manage-profile/security/api-tokens)"} for ${account.id} in OpenCode's Atlassian view (Settings → Atlassian), or in a terminal in the oc-atlassian folder: pixi run token-set ${account.id}`,
        })
      },
    },
  ]
}
