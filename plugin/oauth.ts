import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"

/** Atlassian's agent interface (Rovo MCP). Overridable for tests. */
export const DEFAULT_MCP = "https://mcp.atlassian.com/v2/mcp"

export interface AuthServer {
  readonly resource: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly registrationEndpoint: string
  readonly scopes: readonly string[]
}

/** Scopes requested: everything Jira and Confluence offer, plus identity and refresh. */
export const SCOPE_PATTERN = /^(read|write|search|delete|manage):(jira|confluence):agent-interface$|^read:me$|^read:account$|^offline_access$/

const json = async (response: Response, what: string) => {
  const text = await response.text()
  let data: Record<string, unknown>
  try { data = JSON.parse(text) } catch { throw new Error(`${what}: ${response.status} ${text.slice(0, 200)}`) }
  return data
}

/** Reads the protected-resource and authorization-server metadata (RFC 9728 / RFC 8414). */
export async function discoverAuth(mcp: string): Promise<AuthServer> {
  const url = new URL(mcp)
  const resourceMeta = await json(await fetch(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`), "Atlassian resource metadata")
  const issuer = (resourceMeta.authorization_servers as string[] | undefined)?.[0]
  if (!issuer) throw new Error("Atlassian did not name an authorization server")
  const server = await json(await fetch(`${issuer}/.well-known/oauth-authorization-server`), "Atlassian authorization metadata")
  return {
    resource: String(resourceMeta.resource ?? mcp),
    authorizationEndpoint: String(server.authorization_endpoint),
    tokenEndpoint: String(server.token_endpoint),
    registrationEndpoint: String(server.registration_endpoint),
    scopes: ((resourceMeta.scopes_supported as string[] | undefined) ?? []).filter(scope => SCOPE_PATTERN.test(scope)),
  }
}

export interface Grant {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  readonly scopes: string[]
}
export interface OAuthClient { readonly clientId: string; readonly tokenEndpoint: string; readonly resource: string }

const grantOf = (data: Record<string, unknown>): Grant => ({
  accessToken: String(data.access_token),
  ...(typeof data.refresh_token === "string" && { refreshToken: data.refresh_token }),
  ...(typeof data.expires_in === "number" && { expiresAt: Date.now() + data.expires_in * 1000 }),
  scopes: typeof data.scope === "string" ? data.scope.split(/\s+/).filter(Boolean) : [],
})

export async function refresh(client: OAuthClient, refreshToken: string): Promise<Grant> {
  const data = await json(await fetch(client.tokenEndpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: refreshToken, resource: client.resource }),
  }), "Atlassian token refresh")
  if (!data.access_token) throw new Error(`Atlassian sign-in expired; sign in again (${data.error_description ?? data.error ?? "no token"})`)
  return grantOf(data)
}

const b64 = (buffer: Buffer) => buffer.toString("base64url")

export interface BrowserSignIn {
  /** Open this in a browser on the same computer as the OpenCode server. */
  readonly url: string
  readonly expiresAt: number
  /** Resolves with the grant once the user approves; rejects on error, cancel or timeout. */
  readonly done: Promise<{ grant: Grant; client: OAuthClient }>
  /** Completes from a pasted redirect URL (when the browser runs on another computer). */
  complete(redirectUrl: string): void
  cancel(): void
}

/**
 * Browser sign-in as a public client: registers a client (dynamic registration, no secret), opens the authorization
 * page with PKCE, and receives the code on a loopback callback. Works with any identity provider (Microsoft SSO etc.).
 */
export async function startBrowserSignIn(mcp: string, options: { clientName?: string; timeoutMs?: number } = {}): Promise<BrowserSignIn> {
  const auth = await discoverAuth(mcp)
  const server: Server = createServer()
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`
  const registration = await json(await fetch(auth.registrationEndpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: options.clientName ?? "OpenCode (oc-atlassian)", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  }), "Atlassian client registration")
  if (!registration.client_id) { server.close(); throw new Error(`Atlassian refused the sign-in client: ${registration.error_description ?? registration.error ?? "no client id"}`) }
  const clientId = String(registration.client_id)
  const verifier = b64(randomBytes(32)), state = b64(randomBytes(16))
  const url = new URL(auth.authorizationEndpoint)
  for (const [key, value] of Object.entries({
    client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: auth.scopes.join(" "), state,
    code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: auth.resource, prompt: "consent",
  })) url.searchParams.set(key, value)

  const timeoutMs = options.timeoutMs ?? 15 * 60_000
  let settle!: (code: string) => void, fail!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject })
  const timer = setTimeout(() => fail(new Error("The sign-in was not finished in time; start again")), timeoutMs)
  const handle = (target: URL) => {
    const params = target.searchParams
    if (params.get("state") !== state) { fail(new Error("Sign-in response did not match (state); start again")); return false }
    const value = params.get("code")
    if (value) { settle(value); return true }
    fail(new Error(`Sign-in was not approved: ${params.get("error_description") ?? params.get("error") ?? "unknown"}`))
    return false
  }
  server.on("request", (req, res) => {
    if (!req.url?.startsWith("/callback")) { res.writeHead(404); res.end(); return }
    const ok = handle(new URL(req.url, redirectUri))
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(`<!doctype html><title>Atlassian sign-in</title><body style="font:16px system-ui;margin:3em">${ok ? "<h2>Signed in to Atlassian.</h2><p>You can close this tab and return to OpenCode.</p>" : "<h2>Sign-in did not complete.</h2><p>Return to OpenCode and try again.</p>"}</body>`)
  })
  const done = code.then(async value => {
    const data = await json(await fetch(auth.tokenEndpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: value, redirect_uri: redirectUri, code_verifier: verifier, resource: auth.resource }),
    }), "Atlassian token exchange")
    if (!data.access_token) throw new Error(`Atlassian did not issue a token: ${data.error_description ?? data.error ?? "unknown"}`)
    return { grant: grantOf(data), client: { clientId, tokenEndpoint: auth.tokenEndpoint, resource: auth.resource } }
  }).finally(() => { clearTimeout(timer); server.close() })
  done.catch(() => {})
  return {
    url: url.href, expiresAt: Date.now() + timeoutMs, done,
    complete: redirectUrl => { try { handle(new URL(redirectUrl)) } catch { fail(new Error("That is not the address the browser was sent to after sign-in")) } },
    cancel: () => fail(new Error("Sign-in cancelled")),
  }
}
