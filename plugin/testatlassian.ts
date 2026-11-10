// Test helper: a fake Atlassian — OAuth (metadata, dynamic registration, PKCE, refresh), the agent interface (MCP over
// Streamable HTTP) and a few REST endpoints with Basic/Bearer auth.
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export interface FakeAtlassian {
  readonly base: string
  readonly mcpUrl: string
  readonly site: string
  readonly cloudId: string
  /** What the browser does: open the authorization URL, approve, follow the redirect to the loopback callback. */
  approve(authorizeUrl: string): Promise<void>
  readonly calls: { name: string; args: Record<string, unknown> }[]
  readonly rest: { method: string; path: string; auth: string }[]
  /** Makes the current access tokens expire (to exercise refresh). */
  expireTokens(): void
  stop(): Promise<void>
}

export async function startFakeAtlassian(options: { apiToken?: string; email?: string; pat?: string } = {}): Promise<FakeAtlassian> {
  const site = "https://acme.atlassian.net"
  const cloudId = "11111111-2222-3333-4444-555555555555"
  const clients = new Set<string>()
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string }>()
  const access = new Map<string, number>() // token -> expiry
  const refresh = new Set<string>()
  const sessions = new Set<string>()
  const calls: FakeAtlassian["calls"] = []
  const rest: FakeAtlassian["rest"] = []
  const issues = new Map<string, { key: string; summary: string; status: string }>([["ACME-1", { key: "ACME-1", summary: "First issue", status: "To Do" }]])
  let base = ""
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body))
  }
  const read = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString() }
  const issue = () => { const token = randomBytes(12).toString("hex"); access.set(token, Date.now() + 3600_000); const r = randomBytes(12).toString("hex"); refresh.add(r); return { access_token: token, refresh_token: r, expires_in: 3600, token_type: "Bearer", scope: "read:me read:jira:agent-interface write:jira:agent-interface read:confluence:agent-interface offline_access" } }
  const bearerOk = (req: IncomingMessage) => { const token = req.headers.authorization?.replace(/^Bearer /, ""); const expiry = token ? access.get(token) : undefined; return expiry !== undefined && expiry > Date.now() }
  const tools = [
    { name: "atlassianUserInfo", description: "Who you are", inputSchema: { type: "object", properties: {} } },
    { name: "getAccessibleAtlassianResources", description: "Sites", inputSchema: { type: "object", properties: {} } },
    { name: "getJiraCurrentUser", description: "Current Jira user", inputSchema: { type: "object", properties: { cloudId: { type: "string" } }, required: ["cloudId"] } },
    { name: "searchJiraIssuesUsingJql", description: "Search Jira issues with JQL", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, jql: { type: "string" } }, required: ["cloudId", "jql"] } },
    { name: "getJiraIssue", description: "Get a Jira issue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" } }, required: ["cloudId", "issueIdOrKey"] } },
    { name: "createJiraIssue", description: "Create a Jira issue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, projectKey: { type: "string" }, summary: { type: "string" } }, required: ["cloudId", "projectKey", "summary"] } },
    { name: "transitionJiraIssue", description: "Transition an issue", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, issueIdOrKey: { type: "string" }, transition: { type: "object" } } } },
    { name: "archiveConfluenceContent", description: "Archive a Confluence page", inputSchema: { type: "object", properties: { cloudId: { type: "string" }, contentId: { type: "string" } } } },
  ]
  const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    const path = url.pathname
    if (path === "/.well-known/oauth-protected-resource/v2/mcp") return send(res, 200, { resource: `${base}/v2/mcp`, authorization_servers: [`${base}/as`], scopes_supported: ["read:me", "offline_access", "read:jira:agent-interface", "write:jira:agent-interface", "read:confluence:agent-interface", "read:bitbucket:agent-interface"] })
    if (path === "/as/.well-known/oauth-authorization-server") return send(res, 200, { issuer: `${base}/as`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/as/register` })
    if (path === "/as/register") {
      const body = JSON.parse(await read(req))
      if (body.token_endpoint_auth_method !== "none") return send(res, 400, { error: "invalid_client_metadata" })
      const id = `client-${randomBytes(4).toString("hex")}`; clients.add(id)
      return send(res, 201, { client_id: id, redirect_uris: body.redirect_uris })
    }
    if (path === "/authorize") {
      const p = url.searchParams
      if (!clients.has(p.get("client_id")!) || p.get("code_challenge_method") !== "S256") return send(res, 400, { error: "invalid_request" })
      const code = randomBytes(8).toString("hex")
      codes.set(code, { clientId: p.get("client_id")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")! })
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` }); res.end(); return
    }
    if (path === "/oauth/token") {
      const form = new URLSearchParams(await read(req))
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code")!)
        const verifier = form.get("code_verifier") ?? ""
        if (!entry || entry.clientId !== form.get("client_id") || entry.redirect !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return send(res, 400, { error: "invalid_grant" })
        codes.delete(form.get("code")!)
        return send(res, 200, issue())
      }
      if (form.get("grant_type") === "refresh_token" && refresh.delete(form.get("refresh_token")!)) return send(res, 200, issue())
      return send(res, 400, { error: "invalid_grant" })
    }
    if (path === "/v2/mcp") {
      if (!bearerOk(req) && !(options.apiToken && req.headers.authorization === `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`)) return send(res, 401, { error: "invalid_token" })
      const message = JSON.parse(await read(req))
      if (message.method === "initialize") { const id = randomBytes(6).toString("hex"); sessions.add(id); res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": id }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } } })}\n\n`); return }
      if (!sessions.has(String(req.headers["mcp-session-id"]))) return send(res, 404, { error: "session not found" })
      if (!("id" in message)) { res.writeHead(202); res.end(); return }
      let result: unknown
      if (message.method === "tools/list") result = { tools }
      else if (message.method === "tools/call") {
        const { name, arguments: args } = message.params
        calls.push({ name, args })
        if (tools.find(tool => tool.name === name)?.inputSchema.properties && "cloudId" in tools.find(tool => tool.name === name)!.inputSchema.properties && args.cloudId !== cloudId) result = { ...text("cloudId is required"), isError: true }
        else if (name === "atlassianUserInfo") result = text({ data: { accountId: "acct-1" } })
        else if (name === "getJiraCurrentUser") result = text({ data: { accountId: "acct-1", displayName: "Test Person", emailAddress: "test@acme.example" } })
        else if (name === "getAccessibleAtlassianResources") result = text({ data: { resources: [{ cloudId, url: site, products: [{ id: "jira", access: "read-write" }, { id: "confluence", access: "read-write" }] }] } })
        else if (name === "searchJiraIssuesUsingJql") result = text({ issues: [...issues.values()], jql: args.jql })
        else if (name === "getJiraIssue") result = issues.has(args.issueIdOrKey) ? text(issues.get(args.issueIdOrKey)) : { ...text("Issue does not exist"), isError: true }
        else if (name === "createJiraIssue") { const key = `${args.projectKey}-${issues.size + 1}`; issues.set(key, { key, summary: args.summary, status: "To Do" }); result = text({ key }) }
        else result = text({ ok: true })
      } else return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`); return
    }
    if (path.startsWith("/rest/") || path.startsWith("/wiki/")) {
      const auth = req.headers.authorization ?? ""
      const basic = options.apiToken && auth === `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}`
      const pat = options.pat && auth === `Bearer ${options.pat}`
      rest.push({ method: req.method!, path, auth: auth.split(" ")[0]! })
      if (!basic && !pat) return send(res, 401, { message: "Unauthorized" })
      if (/\/rest\/api\/[23]\/myself$/.test(path)) return send(res, 200, { accountId: "acct-2", displayName: "Token Person", emailAddress: options.email })
      if (path === "/rest/api/3/search/jql" || path === "/rest/api/2/search") return send(res, 200, { issues: [...issues.values()].map(issue => ({ key: issue.key, fields: { summary: issue.summary } })) })
      const one = /\/rest\/api\/[23]\/issue\/([A-Z]+-\d+)$/.exec(path)
      if (one && req.method === "DELETE") { issues.delete(one[1]!); res.writeHead(204); res.end(); return }
      if (one) return issues.has(one[1]!) ? send(res, 200, { key: one[1], fields: { summary: issues.get(one[1]!)!.summary } }) : send(res, 404, { errorMessages: ["Issue does not exist"] })
      return send(res, 404, { message: "not found" })
    }
    send(res, 404, { message: "not found" })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base, mcpUrl: `${base}/v2/mcp`, site, cloudId, calls, rest,
    async approve(authorizeUrl) {
      const redirect = await fetch(authorizeUrl, { redirect: "manual" })
      const location = redirect.headers.get("location")
      if (!location) throw new Error(`authorize failed: ${redirect.status} ${await redirect.text()}`)
      await fetch(location)
    },
    expireTokens() { for (const token of access.keys()) access.set(token, 0) },
    async stop() { await new Promise(resolve => server.close(resolve)) },
  }
}
