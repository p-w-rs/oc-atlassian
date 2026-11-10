import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { createAdmin } from "./admin.js"
import { startFakeAtlassian, type FakeAtlassian } from "./testatlassian.js"
import type { AtlassianService } from "./service.js"

const API_TOKEN = "ATATT-fake-api-token-0123456789"
const dirs: string[] = []
let fake: FakeAtlassian
before(async () => { fake = await startFakeAtlassian({ apiToken: API_TOKEN, email: "me@acme.example" }) })
after(async () => { await fake.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oca-"))
  dirs.push(dir)
  const hooks = { evaluate: [] as any[], after: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string; content: string }[] = []
  const prompts: { action: string; resources: string[]; metadata?: Record<string, unknown> }[] = []
  let rpc: any
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const ctx = {
    options: { dataDirectory: dir, mcpUrl: fake.mcpUrl, ...options },
    session: { get: async () => ({ parentID: undefined }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, resources: input.resources, metadata: input.metadata }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (_: string, callback: any) => registration(hooks.after, callback),
    },
    skill: { transform: async (callback: any) => { callback({ add: (skill: any) => skills.push(skill) }); return { dispose: async () => { skills.length = 0 } } } },
    event: { subscribe: () => (async function* () {})() },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", hidden: false }] }) },
    rpc: { register: async (_: unknown, handlers: any) => { rpc = handlers; return { dispose: async () => { rpc = undefined } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const call = async (name: string, input: unknown, agent = "build") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = { sessionID: "s", agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} }
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    for (const hook of hooks.after) await hook(event)
    if (event.status === "error") throw event.error
    const text = event.result.content
    try { return JSON.parse(text) } catch { return text }
  }
  /** Signs in a Cloud account through the browser flow, approving like a user would. */
  const signedIn = async (id = "work") => {
    await call("atlassian_account_upsert", { id, site: fake.site })
    const started = await call("atlassian_signin", { account: id })
    const url = /(http\S+authorize\S+)/.exec(started.tellUser)![1]!
    await fake.approve(url)
    for (let i = 0; i < 100; i++) { const list = await call("atlassian_list", {}); if (list.accounts.find((a: { id: string }) => a.id === id)?.signedInAs) break; await new Promise(r => setTimeout(r, 30)) }
  }
  return { dir, tools, skills, prompts, call, signedIn, cleanup, rpc: () => rpc, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }) }
}

test("identity, tools, skill, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 9)
  assert.equal(h.skills[0]!.id, "atlassian")
  assert.match(h.skills[0]!.content, /JQL essentials/)
  assert.match(h.tools.get("atlassian_list")!.description, /No Atlassian accounts are configured yet/)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  const broken = await host("approve", { dataDirectory: "relative" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ mcpUrl: "ftp://x" }), /http/)
})

test("browser sign-in with a public client (no secret), then discovery", async () => {
  const h = await host()
  await h.signedIn()
  const list = await h.call("atlassian_list", {})
  const work = list.accounts[0]
  assert.equal(work.signedInAs, "Test Person")
  assert.deepEqual(work.products, { jira: "read-write", confluence: "read-write" })
  assert.equal(work.agentActions, 8)
  assert.doesNotMatch(JSON.stringify(list), /access_token|refresh/, "tokens never reach the agent")
  await new Promise(r => setTimeout(r, 20))
  assert.match(h.tools.get("atlassian_list")!.description, /work: https:\/\/acme\.atlassian\.net — Test Person; browser sign-in, agent actions; jira read-write/)
})

test("find and run actions; cloudId is filled in; output masks tokens", async () => {
  const h = await host()
  await h.signedIn()
  const found = await h.call("atlassian_find_actions", { query: "search jira" })
  assert.equal(found.actions[0].name, "searchJiraIssuesUsingJql")
  assert.equal(found.actions[0].kind, "jira-read")
  const schema = await h.call("atlassian_find_actions", { names: ["createJiraIssue", "nope"] })
  assert.deepEqual(schema.actions[0].parameters.required, ["cloudId", "projectKey", "summary"])
  assert.deepEqual(schema.actions[1], { name: "nope", missing: true })
  const search = await h.call("atlassian_run", { action: "searchJiraIssuesUsingJql", arguments: { jql: "project = ACME" } })
  assert.equal(search.issues[0].key, "ACME-1")
  assert.equal(fake.calls.at(-1)!.args.cloudId, fake.cloudId)
  const created = await h.call("atlassian_run", { action: "createJiraIssue", arguments: { projectKey: "ACME", summary: "From agent" } })
  assert.match(created.key, /^ACME-\d+$/)
  assert.deepEqual(h.prompts, [], "reads and writes allowed by default")
  await assert.rejects(h.call("atlassian_run", { action: "createJiraIsue", arguments: {} }), /Did you mean: createJiraIssue/)
  await assert.rejects(h.call("atlassian_run", { action: "getJiraIssue", arguments: { issueIdOrKey: "NOPE-9" } }), /getJiraIssue failed: Issue does not exist/)
})

test("permissions: delete asks, deny refuses, per agent", async () => {
  const h = await host()
  await h.signedIn()
  await h.call("atlassian_run", { action: "archiveConfluenceContent", arguments: { contentId: "1" } })
  assert.deepEqual(h.prompts.map(p => [p.action, p.resources, p.metadata?.action]), [["oc-atlassian.confluence-delete", ["work"], "archiveConfluenceContent"]])
  await (await h.policy()).setCells([{ entity: "work", row: { agent: "plan" }, capability: "jira-write", effect: "deny" }])
  await assert.rejects(h.call("atlassian_run", { action: "createJiraIssue", arguments: { projectKey: "ACME", summary: "x" } }, "plan"), /Denied by the oc-atlassian permissions table \(jira-write on work\)/)
  const rejecting = await host("reject")
  await rejecting.signedIn()
  await assert.rejects(rejecting.call("atlassian_run", { action: "archiveConfluenceContent", arguments: { contentId: "1" } }), /rejected by user/)
})

test("expired access tokens are refreshed transparently", async () => {
  const h = await host()
  await h.signedIn()
  const before = await (await h.vault()).get("work", "access-token")
  fake.expireTokens()
  const search = await h.call("atlassian_run", { action: "searchJiraIssuesUsingJql", arguments: { jql: "x" } })
  assert.ok(search.issues)
  assert.notEqual(await (await h.vault()).get("work", "access-token"), before, "new token stored")
})

test("API-token accounts use REST (and agent actions where allowed)", async () => {
  const h = await host()
  await h.call("atlassian_account_upsert", { id: "tok", site: fake.base, auth: "token", email: "me@acme.example" })
  const asked = await h.call("atlassian_request_token", { account: "tok" })
  assert.match(asked.tellUser, /pixi run token-set tok/)
  const admin = createAdmin({ service: undefined as unknown as AtlassianService, root: async id => id, agents: async () => [] })
  void admin
  const result = await h.rpc().setToken({ id: "tok", token: API_TOKEN })
  assert.equal(result.who, "Token Person")
  const issue = await h.call("atlassian_rest", { account: "tok", product: "jira", method: "GET", path: "/rest/api/3/issue/ACME-1" })
  assert.equal(issue.key, "ACME-1")
  await h.call("atlassian_rest", { account: "tok", product: "jira", method: "DELETE", path: "/rest/api/3/issue/ACME-1" })
  assert.deepEqual(h.prompts.map(p => p.action), ["oc-atlassian.jira-delete"])
  assert.equal(fake.rest.at(-1)!.auth, "Basic")
  await assert.rejects(h.call("atlassian_rest", { account: "tok", product: "jira", method: "GET", path: "https://evil.example/x" }), /relative/)
  await assert.rejects(h.call("atlassian_rest", { account: "tok", product: "jira", method: "GET", path: "/rest/api/3/issue/ZZZ-9" }), /404/)
})

test("several accounts: the agent must pick, or a default applies", async () => {
  const h = await host()
  await h.signedIn("work")
  await h.call("atlassian_account_upsert", { id: "other", site: "other.atlassian.net" })
  await assert.rejects(h.call("atlassian_find_actions", { query: "jira" }), /Several Atlassian accounts exist .* Pass account=<id>/)
  assert.ok((await h.call("atlassian_find_actions", { account: "work", query: "jira" })).actions.length)
  await h.rpc().setDefault({ id: "work" })
  assert.ok((await h.call("atlassian_find_actions", { query: "jira" })).actions.length)
})

test("GUI admin: state, sign-in from the GUI, export and import", async () => {
  const h = await host()
  await h.call("atlassian_account_upsert", { id: "work", site: fake.site })
  const started = await h.rpc().signIn({ id: "work" })
  assert.equal((await h.rpc().state({ sessionID: "s" })).accounts[0].signIn.status, "waiting")
  await fake.approve(started.url)
  for (let i = 0; i < 100 && !(await h.rpc().state({})).accounts[0].who; i++) await new Promise(r => setTimeout(r, 30))
  const state = await h.rpc().state({ sessionID: "s" })
  assert.equal(state.accounts[0].who, "Test Person")
  assert.equal(state.accounts[0].signIn, undefined)
  assert.deepEqual(state.products, ["jira", "confluence", "other"])
  const token = (await (await h.vault()).get("work", "access-token"))!
  assert.ok(!JSON.stringify(state).includes(token), "tokens never reach the GUI")
  await h.rpc().setCells({ changes: [{ entity: "work", capability: "jira-delete", effect: "deny", agent: "*" }] })
  const exported = await h.rpc().exportBundle({ passphrase: "export passphrase 1" })
  const other = await host()
  const preview = await other.rpc().previewImport({ content: exported.content, passphrase: "export passphrase 1" })
  assert.deepEqual(preview.accounts, [{ id: "work", status: "added" }])
  await other.rpc().applyImport({ content: exported.content, passphrase: "export passphrase 1", mode: "merge" })
  for (let i = 0; i < 100 && !(await other.rpc().state({})).accounts[0]?.who; i++) await new Promise(r => setTimeout(r, 30))
  const imported = await other.rpc().state({})
  assert.equal(imported.accounts[0].who, "Test Person", "the imported sign-in works on the new install")
  assert.equal(imported.cells.work["*"]["jira-delete"], "deny")
})
