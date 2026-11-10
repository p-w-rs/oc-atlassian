// Enter the API token (Cloud) or personal access token (Data Center) of an account. Read with echo off, or from stdin.
//   pixi run token-set <account>
import { createInterface } from "node:readline"
import { pluginDataDir } from "oc-secure-kit"
import { API_TOKEN } from "../plugin/model.ts"
import { AtlassianService } from "../plugin/service.ts"

const [id] = process.argv.slice(2)
if (!id) { console.error("Usage: pixi run token-set <account>"); process.exit(2) }
const service = await AtlassianService.open(pluginDataDir("oc-atlassian", process.env.OC_ATLASSIAN_DATA_DIR || undefined))
const account = await service.store.get(id)
if (!account) { console.error(`No account ${id}.`); process.exit(1) }
if (account.auth === "browser") { console.error(`${id} uses browser sign-in: pixi run signin ${id}`); process.exit(1) }
function readHidden(prompt) {
  if (!process.stdin.isTTY) return new Promise(resolve => { let data = ""; process.stdin.on("data", c => { data += c }); process.stdin.on("end", () => resolve(data.trim())) })
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = text => { if (!muted) process.stdout.write(text) }
    rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()) })
    muted = true
  })
}
const token = await readHidden(`${account.auth === "pat" ? "Personal access token" : "API token"} for ${id} (${account.site}): `)
if (!token) { console.error("Empty; nothing stored."); process.exit(1) }
await service.vault.set(id, API_TOKEN, token)
await service.requests.remove({ entity: id, name: API_TOKEN })
const discovery = await service.rediscover(account)
console.log(discovery.error ? `Stored, but Atlassian said: ${discovery.error}` : `Stored. Signed in as ${discovery.name ?? discovery.accountId}.`)
service.dispose()
