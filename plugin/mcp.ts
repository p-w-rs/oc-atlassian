/** A minimal Streamable-HTTP MCP client for Atlassian's agent interface. */

export interface ToolInfo { readonly name: string; readonly description?: string; readonly inputSchema?: unknown; readonly annotations?: Record<string, unknown> }
export interface CallResult { readonly text: string; readonly isError: boolean; readonly structured?: unknown }

export class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class McpClient {
  #session?: string
  #initialized?: Promise<void>
  #id = 0
  /** @param authorization returns the Authorization header value (refreshing as needed). */
  constructor(private readonly url: string, private readonly authorization: () => Promise<string>, private readonly onUnauthorized?: () => Promise<void>) {}

  async #post(body: Record<string, unknown>, retried = false): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: await this.authorization(), "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18", ...(this.#session && { "mcp-session-id": this.#session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    })
    const session = response.headers.get("mcp-session-id")
    if (session) this.#session = session
    const text = await response.text()
    if (response.status === 401 && !retried && this.onUnauthorized) { await this.onUnauthorized(); return this.#post(body, true) }
    if (response.status === 404 && this.#session && !retried && body.method !== "initialize") {
      // Session expired on the server: start a new one and retry once.
      this.reset()
      await this.#ensure()
      return this.#post(body, true)
    }
    if (!response.ok && response.status !== 202) throw new HttpStatusError(`Atlassian ${response.status}: ${text.slice(0, 300)}`, response.status)
    if (!text.trim()) return undefined
    const lines = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean)
    const messages = (lines.length ? lines : [text]).map(line => JSON.parse(line) as Record<string, unknown>)
    const reply = messages.find(message => "id" in message && message.id === body.id) ?? messages.at(-1)
    if (reply?.error) {
      const error = reply.error as { message?: string; code?: number }
      throw new Error(`Atlassian: ${error.message ?? JSON.stringify(error)}`)
    }
    return reply?.result as Record<string, unknown> | undefined
  }

  reset(): void { this.#session = undefined; this.#initialized = undefined }

  #ensure(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#post({ id: ++this.#id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oc-atlassian", version: "0.1.0" } } })
      await this.#post({ method: "notifications/initialized" })
    })().catch(error => { this.#initialized = undefined; throw error })
    return this.#initialized
  }

  async listTools(): Promise<ToolInfo[]> {
    await this.#ensure()
    const tools: ToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await this.#post({ id: ++this.#id, method: "tools/list", params: cursor ? { cursor } : {} })
      tools.push(...((result?.tools as ToolInfo[] | undefined) ?? []))
      cursor = result?.nextCursor as string | undefined
      if (!cursor) break
    }
    return tools
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    await this.#ensure()
    const result = await this.#post({ id: ++this.#id, method: "tools/call", params: { name, arguments: args } })
    const content = (result?.content as { type: string; text?: string }[] | undefined) ?? []
    return {
      text: content.map(part => part.type === "text" ? part.text ?? "" : `[${part.type}]`).join("\n"),
      isError: result?.isError === true,
      ...(result?.structuredContent !== undefined && { structured: result.structuredContent }),
    }
  }
}
