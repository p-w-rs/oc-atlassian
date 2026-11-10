// Browser sign-in for an Atlassian Cloud account from a terminal (the GUI and atlassian_signin do the same).
//   pixi run signin <account> [--site acme.atlassian.net]
// Creates the account (browser sign-in) if needed. Never prints tokens.
import { spawn } from "node:child_process"
import { pluginDataDir } from "oc-secure-kit"
import { normalizeAccount } from "../plugin/model.ts"
import { AtlassianService } from "../plugin/service.ts"

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const id = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"))
if (!id) { console.error("Usage: pixi run signin <account> [--site acme.atlassian.net]"); process.exit(2) }

const service = await AtlassianService.open(pluginDataDir("oc-atlassian", process.env.OC_ATLASSIAN_DATA_DIR || undefined))
let account = await service.store.get(id)
if (!account || option("--site")) {
  if (!option("--site") && !account) { console.error(`No account ${id} yet: add --site <your-site>.atlassian.net`); process.exit(2) }
  account = await service.store.put(normalizeAccount({ ...(account ?? { id, auth: "browser" }), ...(option("--site") && { site: option("--site") }) }))
  console.log(`Account ${id}: ${account.site}, ${account.auth} sign-in`)
}
const state = await service.startSignIn(account)
console.log(`\nOpening your browser. Sign in to Atlassian (your organization's single sign-on if asked), choose ${account.site.replace(/^https?:\/\//, "")} and approve.\nIf it does not open, visit:\n\n${state.url}\n`)
spawn(process.platform === "darwin" ? "open" : "xdg-open", [state.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
while (state.status === "waiting") await new Promise(resolve => setTimeout(resolve, 500))
if (state.status !== "done") { console.error(`Sign-in did not finish: ${state.error}`); process.exit(1) }
const discovery = await service.store.discovery(id)
console.log(`Signed in as ${discovery?.name ?? discovery?.email ?? discovery?.accountId}. Products: ${Object.entries(discovery?.products ?? {}).map(([p, a]) => `${p} (${a})`).join(", ") || "none"}. Agent actions: ${discovery?.actions ?? 0}.`)
if (discovery?.error) console.log(`Problem: ${discovery.error}`)
service.dispose()
process.exit(0)
