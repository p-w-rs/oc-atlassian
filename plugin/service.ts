import { join } from "node:path"
import { HttpStatusError, McpClient, PolicyStore, Redactor, refreshGrant, SecretRequests, Serial, startBrowserSignIn, Vault, type BrowserSignIn, type Grant, type McpToolInfo as ToolInfo, type OAuthClient, type PermissionBridge } from "oc-secure-kit"
import { ACCESS, API_TOKEN, DEFAULT_MCP, isCloud, OAUTH, REFRESH, SCOPE_PATTERN, secretSlots, type Account, type Discovery } from "./model.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-atlassian"

export interface SignInState {
  readonly account: string
  readonly url: string
  readonly expiresAt: number
  status: "waiting" | "done" | "failed"
  error?: string
  readonly flow: BrowserSignIn
}

interface Catalog { readonly tools: ToolInfo[]; readonly at: number }
const CATALOG_TTL = 6 * 60 * 60_000

/** Accounts, vault, permissions, sign-in and per-account connections of one data directory. */
export class AtlassianService {
  readonly redactor = new Redactor()
  readonly signIns = new Map<string, SignInState>()
  #bridge?: PermissionBridge
  #redactorStale = false
  #mcp = new Map<string, McpClient>()
  #catalog = new Map<string, Catalog>()
  #refreshing = new Map<string, Serial>()

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    readonly requests: SecretRequests,
    readonly mcpUrl: string,
  ) {}

  static async open(dir: string, options: { mcpUrl?: string } = {}): Promise<AtlassianService> {
    const [store, vault, policy, requests] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir), SecretRequests.open(dir)])
    const service = new AtlassianService(dir, store, vault, policy, requests, options.mcpUrl ?? DEFAULT_MCP)
    await service.refreshRedactor()
    vault.onChange(() => { service.#redactorStale = true })
    store.onChange(() => { service.#mcp.clear(); service.#catalog.clear() })
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }

  /** The account a call is for: the named one, the only one, or the default. */
  async pick(id: string | undefined): Promise<Account> {
    const accounts = await this.store.list()
    if (id) {
      const found = accounts.find(account => account.id === id || account.site === id || account.site.replace(/^https?:\/\//, "") === id.replace(/^https?:\/\//, "").replace(/\/$/, ""))
      if (!found) throw new Error(`No Atlassian account ${JSON.stringify(id)}. Accounts: ${accounts.map(account => `${account.id} (${account.site})`).join(", ") || "(none; create one with atlassian_account_upsert)"}`)
      return found
    }
    if (accounts.length === 1) return accounts[0]!
    const fallback = (await this.store.settings()).defaultAccount
    if (fallback) { const found = accounts.find(account => account.id === fallback); if (found) return found }
    if (!accounts.length) throw new Error("No Atlassian account is configured yet. Create one with atlassian_account_upsert (site, and auth: browser for Atlassian Cloud), then atlassian_signin.")
    throw new Error(`Several Atlassian accounts exist (${accounts.map(account => `${account.id}: ${account.site}`).join(", ")}). Pass account=<id>; decide from the conversation or ask the user.`)
  }

  // ------------------------------------------------------------------ credentials

  async saveGrant(account: Account, grant: Grant, client: OAuthClient): Promise<void> {
    await this.vault.set(account.id, ACCESS, grant.accessToken)
    if (grant.refreshToken) await this.vault.set(account.id, REFRESH, grant.refreshToken)
    await this.vault.set(account.id, OAUTH, JSON.stringify({ ...client, ...(grant.expiresAt && { expiresAt: grant.expiresAt }), scopes: grant.scopes }))
    await this.requests.remove({ entity: account.id, name: ACCESS })
    this.#mcp.delete(account.id)
    await this.refreshRedactor()
  }

  /** A valid access token for a browser account, refreshed when it is about to expire (or `force`). */
  async accessToken(account: Account, force = false): Promise<string | undefined> {
    const serial = this.#refreshing.get(account.id) ?? new Serial()
    this.#refreshing.set(account.id, serial)
    return serial.run(async () => {
      const token = await this.vault.get(account.id, ACCESS)
      const stored = await this.vault.get(account.id, OAUTH)
      const oauth = stored ? JSON.parse(stored) as OAuthClient & { expiresAt?: number } : undefined
      if (token && !force && (!oauth?.expiresAt || oauth.expiresAt - Date.now() > 5 * 60_000)) return token
      const refreshToken = await this.vault.get(account.id, REFRESH)
      if (!refreshToken || !oauth) return token
      const grant = await refreshGrant(oauth, refreshToken, "Atlassian")
      await this.saveGrant(account, { ...grant, refreshToken: grant.refreshToken ?? refreshToken }, oauth)
      return grant.accessToken
    })
  }

  /** Authorization header for an account (browser: bearer; token: Basic email:token; pat: bearer). */
  async authorization(account: Account): Promise<string> {
    if (account.auth === "browser") {
      const token = await this.accessToken(account)
      if (!token) throw new Error(`${account.id} is not signed in. Call atlassian_signin account=${account.id} and give the user the link.`)
      return `Bearer ${token}`
    }
    const token = await this.vault.get(account.id, API_TOKEN)
    if (!token) throw new Error(`${account.id} has no ${account.auth === "pat" ? "personal access token" : "API token"} yet: ask the user to enter it (atlassian_request_token account=${account.id}).`)
    return account.auth === "token" ? `Basic ${Buffer.from(`${account.email}:${token}`).toString("base64")}` : `Bearer ${token}`
  }

  // ------------------------------------------------------------------ agent actions (MCP)

  /** Whether an account can use Atlassian's agent actions (browser sign-in; API tokens where the org allows). */
  usesActions(account: Account): boolean { return account.auth === "browser" || (account.auth === "token" && isCloud(account.site)) }

  mcp(account: Account): McpClient {
    let client = this.#mcp.get(account.id)
    if (!client) {
      client = new McpClient(`${this.mcpUrl}?tools=all`, {
        authorization: () => this.authorization(account), clientName: PLUGIN_ID, clientVersion: "1.0.1", service: "Atlassian",
        ...(account.auth === "browser" && { onUnauthorized: async () => { await this.accessToken(account, true) } }),
      })
      this.#mcp.set(account.id, client)
    }
    return client
  }

  async actions(account: Account, fresh = false): Promise<ToolInfo[]> {
    const cached = this.#catalog.get(account.id)
    if (cached && !fresh && Date.now() - cached.at < CATALOG_TTL) return cached.tools
    const tools = await this.mcp(account).listTools()
    this.#catalog.set(account.id, { tools, at: Date.now() })
    return tools
  }

  /** Atlassian Cloud id of the account's site, needed by most agent actions. */
  async cloudId(account: Account): Promise<string | undefined> {
    const known = (await this.store.discovery(account.id))?.cloudId
    if (known) return known
    try {
      const response = await fetch(`${account.site}/_edge/tenant_info`)
      if (response.ok) return String(((await response.json()) as { cloudId?: string }).cloudId ?? "") || undefined
    } catch {}
    return undefined
  }

  // ------------------------------------------------------------------ REST

  restBase(account: Account, product: "jira" | "confluence"): string {
    if (product === "confluence") return account.confluenceUrl ?? (isCloud(account.site) ? `${account.site}/wiki` : account.site)
    return account.site
  }

  async rest(account: Account, product: "jira" | "confluence", method: string, path: string, init: { query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; data: unknown }> {
    if (account.auth === "browser") throw new Error(`${account.id} signs in through the browser, which grants Atlassian's agent actions rather than raw REST. Use atlassian_find_actions / atlassian_run instead.`)
    const url = new URL(`${this.restBase(account, product)}${path.startsWith("/") ? path : `/${path}`}`)
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: {
        authorization: await this.authorization(account), accept: "application/json",
        ...(init.body !== undefined && { "content-type": "application/json" }), "x-atlassian-token": "no-check", ...init.headers,
      },
      ...(init.body !== undefined && { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    })
    const text = await response.text()
    const data = text ? (() => { try { return JSON.parse(text) } catch { return text } })() : undefined
    if (!response.ok) {
      const detail = typeof data === "object" && data ? JSON.stringify(data).slice(0, 1500) : String(data ?? "").slice(0, 500)
      throw new HttpStatusError(`${method.toUpperCase()} ${url.pathname} → ${response.status}: ${detail}`, response.status)
    }
    return { status: response.status, data }
  }

  // ------------------------------------------------------------------ discovery and sign-in

  /** Learns who the account is, its site, products and (for agent actions) how many are available. */
  async rediscover(account: Account): Promise<Discovery> {
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    try {
      if (account.auth === "browser") {
        const client = this.mcp(account)
        const stored = await this.vault.get(account.id, OAUTH)
        const scopes = stored ? (JSON.parse(stored) as { scopes?: string[] }).scopes : undefined
        const tools = await this.actions(account, true)
        const call = async (name: string) => tools.some(tool => tool.name === name) ? JSON.parse((await client.call(name, {})).text || "{}") : undefined
        const me = (await call("atlassianUserInfo"))?.data ?? {}
        const resources: { cloudId: string; url: string; products?: { id: string; access: string }[] }[] = (await call("getAccessibleAtlassianResources"))?.data?.resources ?? []
        const site = resources.find(resource => resource.url.replace(/\/$/, "") === account.site) ?? (resources.length === 1 ? resources[0] : undefined)
        if (!me.name && site && tools.some(tool => tool.name === "getJiraCurrentUser")) {
          try {
            const result = await client.call("getJiraCurrentUser", { cloudId: site.cloudId })
            const jira = JSON.parse(result.text || "{}")
            const user = jira.data ?? jira
            if (user.displayName) me.name = user.displayName
            if (user.emailAddress && !me.email) me.email = user.emailAddress
          } catch {}
        }
        discovery = {
          ...(me.accountId && { accountId: me.accountId }), ...(me.name && { name: me.name }), ...(me.email && { email: me.email }),
          ...(site && { cloudId: site.cloudId, products: Object.fromEntries((site.products ?? []).map(product => [product.id, product.access])) }),
          ...(scopes && { scopes }), actions: tools.length, rest: false, checkedAt: new Date().toISOString(),
          ...(!site && { error: `Signed in, but ${account.site} is not among the sites this sign-in can reach (${resources.map(resource => resource.url).join(", ") || "none"}). Sign in again and choose that site.` }),
        }
      } else {
        const me = (await this.rest(account, "jira", "GET", isCloud(account.site) ? "/rest/api/3/myself" : "/rest/api/2/myself")).data as { accountId?: string; name?: string; displayName?: string; emailAddress?: string }
        let actions: number | undefined
        if (this.usesActions(account)) { try { actions = (await this.actions(account, true)).length } catch { actions = 0 } }
        discovery = {
          ...((me.accountId ?? me.name) && { accountId: me.accountId ?? me.name }), ...(me.displayName && { name: me.displayName }), ...(me.emailAddress && { email: me.emailAddress }),
          ...(isCloud(account.site) && { cloudId: await this.cloudId(account) }), rest: true, ...(actions !== undefined && { actions }), checkedAt: new Date().toISOString(),
        }
      }
    } catch (error) {
      discovery = { ...(previous ?? {}), error: (error as Error).message.slice(0, 500), checkedAt: new Date().toISOString() }
    }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  async startSignIn(account: Account): Promise<SignInState> {
    if (account.auth !== "browser") throw new Error(`${account.id} uses auth=${account.auth}; browser sign-in is for auth=browser`)
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.flow.cancel()
    const flow = await startBrowserSignIn(this.mcpUrl, {
      clientName: "OpenCode (oc-atlassian)", service: "Atlassian", authorizeParams: { prompt: "consent" },
      scopes: advertised => advertised.filter(scope => SCOPE_PATTERN.test(scope)),
    })
    const state: SignInState = { account: account.id, url: flow.url, expiresAt: flow.expiresAt, status: "waiting", flow }
    this.signIns.set(account.id, state)
    flow.done
      .then(async ({ grant, client }) => { await this.saveGrant(account, grant, client); await this.rediscover(account); state.status = "done" })
      .catch(error => { if (state.status === "waiting") { state.status = "failed"; state.error = (error as Error).message } })
    return state
  }

  async secretStatus(account: Account): Promise<Record<string, "set" | "unset">> {
    const stored = new Set((await this.vault.list(account.id)).map(item => item.name))
    return Object.fromEntries(secretSlots(account).map(slot => [slot, stored.has(slot) ? "set" : "unset"]))
  }

  async signOut(account: Account): Promise<void> {
    for (const name of [ACCESS, REFRESH, OAUTH, API_TOKEN]) await this.vault.delete(account.id, name)
    await this.store.setDiscovery(account.id, undefined)
    this.#mcp.delete(account.id)
    this.#catalog.delete(account.id)
    await this.refreshRedactor()
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }
  async refreshRedactor(): Promise<void> {
    this.redactor.replaceAll((await this.vault.values()).filter(item => item.name !== OAUTH).map(item => [`${item.entity}/${item.name}`, item.value] as const))
  }

  dispose(): void { for (const state of this.signIns.values()) state.flow.cancel() }
}

export const dataPath = (dir: string, name: string) => join(dir, name)
