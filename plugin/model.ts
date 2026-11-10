import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-atlassian-accounts/1"

/**
 * How an account signs in.
 * - browser: Atlassian Cloud browser sign-in (OAuth 2.1, works with SSO), through Atlassian's agent interface (Rovo MCP).
 *   No app or secret needed. Uses Atlassian's agent actions.
 * - token: Atlassian Cloud email + API token. Uses the REST APIs (and the agent actions when the org allows tokens there).
 * - pat: Data Center / Server personal access token. Uses the REST APIs.
 */
export type Auth = "browser" | "token" | "pat"

export interface Account {
  readonly id: string
  readonly label?: string
  /** Site base URL, e.g. https://acme.atlassian.net or https://jira.corp.example. */
  readonly site: string
  readonly auth: Auth
  /** Atlassian account email (token auth). */
  readonly email?: string
  /** Data Center: separate Confluence base URL, if Confluence lives elsewhere. */
  readonly confluenceUrl?: string
  readonly notes?: string
  readonly updatedAt: string
}

/** What the plugin learned by signing in. Rediscovered; never exported. */
export interface Discovery {
  readonly accountId?: string
  readonly name?: string
  readonly email?: string
  readonly cloudId?: string
  /** Products and access level on the site, e.g. { jira: "read-write" }. */
  readonly products?: Readonly<Record<string, string>>
  /** Scopes granted to the sign-in. */
  readonly scopes?: readonly string[]
  /** Agent actions (MCP tools) available to this account. */
  readonly actions?: number
  readonly rest?: boolean
  readonly checkedAt?: string
  readonly error?: string
}

export const PRODUCTS = ["jira", "confluence", "other"] as const
export type Product = (typeof PRODUCTS)[number]
export const VERBS = ["read", "write", "delete", "admin"] as const
export type Verb = (typeof VERBS)[number]
export const CAPABILITIES = [
  ...PRODUCTS.flatMap(product => VERBS.map(verb => `${product}-${verb}` as const)),
  "manage", "remove",
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Starting point only; users change it in the table. */
export function defaultEffect(capability: string): "allow" | "ask" {
  return /-(delete|admin)$/.test(capability) || capability === "other-write" || capability === "remove" ? "ask" : "allow"
}

/** Vault secret names (entity = account id). */
export const ACCESS = "access-token"
export const REFRESH = "refresh-token"
/** OAuth client registration bound to the tokens: { clientId, tokenEndpoint, resource, expiresAt }. */
export const OAUTH = "oauth"
export const API_TOKEN = "api-token"

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return value as string
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  return validName("account", id)
}

export function normalizeSite(value: unknown, field = "site"): string {
  let raw = text(value, field, 500) ?? fail(`${field} is required, e.g. https://acme.atlassian.net`)
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`
  let url: URL
  try { url = new URL(raw) } catch { return fail(`${field} ${JSON.stringify(value)} is not a URL`) }
  if (url.search || url.hash) fail(`${field} must not have a query or fragment`)
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`
}

export const isCloud = (site: string) => /\.atlassian\.net$|\.jira\.com$/.test(new URL(site).hostname)

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!["id", "label", "site", "auth", "email", "confluenceUrl", "notes", "updatedAt"].includes(key)) fail(`Unknown account field ${JSON.stringify(key)}`)
  const id = validAccountId(raw.id)
  const site = normalizeSite(raw.site)
  const auth = (raw.auth ?? (isCloud(site) ? "browser" : "pat")) as Auth
  if (!["browser", "token", "pat"].includes(auth)) fail("auth must be browser, token or pat")
  if (auth === "browser" && !isCloud(site)) fail("browser sign-in is for Atlassian Cloud sites (*.atlassian.net); use auth=pat for Data Center")
  const email = text(raw.email, "email", 254)
  if (email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(email)) fail("email is not an email address")
  if (auth === "token" && !email) fail("token auth needs the Atlassian account email")
  const confluenceUrl = raw.confluenceUrl == null || raw.confluenceUrl === "" ? undefined : normalizeSite(raw.confluenceUrl, "confluenceUrl")
  const label = text(raw.label, "label", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return {
    id, site, auth, ...(label && { label }), ...(email && { email }), ...(confluenceUrl && { confluenceUrl }), ...(notes && { notes }),
    updatedAt: now.toISOString(),
  }
}

export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

/** Secrets an account needs, for status display. */
export function secretSlots(account: Account): string[] {
  return account.auth === "browser" ? [ACCESS] : [API_TOKEN]
}

// ------------------------------------------------------------------ action classification

const READ = /^(get|list|search|lookup|download|export|diff|resolve|atlassianUserInfo$)/
const DELETE = /^(delete|remove|archive)/
const ADMIN = /Permissions$|RestrictionState$|PublicLink$|^createConfluenceSpace$|^createJiraBoard$|^setConfluenceSpaceInstructions$|^convertJiraIssueHierarchy$/

/** Product and verb of an agent action (MCP tool) by name. */
export function classifyAction(name: string): { product: Product; verb: Verb } {
  const product: Product = /Jira/.test(name) ? "jira" : /Confluence/.test(name) ? "confluence" : "other"
  const verb: Verb = READ.test(name) ? "read" : DELETE.test(name) && !/^removeLabel/.test(name) ? "delete" : ADMIN.test(name) ? "admin" : "write"
  // Read-only helpers that are not product-specific.
  if (product === "other" && /^(getAccessibleAtlassianResources|getContentFormatGuide|atlassianUserInfo)$/.test(name)) return { product, verb: "read" }
  return { product, verb }
}

/** Product and verb of a REST call. */
export function classifyRest(product: "jira" | "confluence", method: string, path: string): { product: Product; verb: Verb } {
  const m = method.toUpperCase()
  const p = path.split("?")[0]!
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return { product, verb: "read" }
  if (m === "POST" && /\/(search|jql|picker|bulkfetch|match|expression\/eval)(\/|$)|\/search\/jql$|\/issue\/picker$|\/content\/search$/.test(p)) return { product, verb: "read" }
  if (m === "DELETE") return { product, verb: "delete" }
  const admin = product === "jira"
    ? /\/(permission|permissionscheme|role|projectCategory|workflow|workflowscheme|screens?|screenscheme|issuetypescheme|fieldconfiguration|notificationscheme|securitylevel|group|groups|user(?!\/(properties|columns))|application-properties|configuration|auditing|webhook)(\/|$)|\/project\/?$|\/project\/[^/]+\/?$/.test(p) && !/\/user\/(search|assignable|picker)/.test(p)
    : /\/(space\/?$|space\/[^/]+\/?$|spaces\/?$|spaces\/[^/]+\/?$|permissions?|restrictions?|group|user|admin|settings|template)(\/|$)/.test(p)
  return { product, verb: admin ? "admin" : "write" }
}

export const capabilityOf = (c: { product: Product; verb: Verb }) => `${c.product}-${c.verb}`
