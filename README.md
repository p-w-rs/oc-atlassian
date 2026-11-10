# oc-atlassian

Jira and Confluence for OpenCode agents. Sign in once (browser with single
sign-on, an API token, or a Data Center personal access token); agents can then
do anything your account can do in Jira and Confluence, with a permission table
per site and built-in know-how (an `atlassian` skill). macOS and Linux;
OpenCode 2.2.6+ and Pixi.

## Sign-in methods

| `auth` | For | How agents work |
|---|---|---|
| `browser` (default for `*.atlassian.net`) | Atlassian Cloud, including SSO (Microsoft, Okta, …) | Atlassian's agent interface (Rovo MCP): ~120 Jira and Confluence actions. No app to register, no secret; the sign-in refreshes itself. Your org must allow the Rovo MCP server (most do). |
| `token` | Atlassian Cloud, email + API token | The REST APIs (`atlassian_rest`), plus the agent actions if your org allows tokens there |
| `pat` | Data Center / Server | The REST APIs with a personal access token |

Any number of accounts (sites). The agent picks the only one, the default, or
the one it names; when it is unclear it asks.

## What agents get

| Tool | |
|---|---|
| `atlassian_list` | Accounts, who you are, products, what the agent may do; also in the tool description |
| `atlassian_find_actions` | Search actions by keyword; `names=[...]` returns exact parameters |
| `atlassian_run` | Run an action (`cloudId` filled in) |
| `atlassian_rest` | Any REST endpoint (token/PAT accounts) |
| `atlassian_account_upsert` / `_remove`, `atlassian_signin`, `atlassian_refresh`, `atlassian_request_token` | Setup |

The `atlassian` skill teaches JQL, CQL, fields and transitions, agile, content
formats (Markdown, ADF, storage, wiki markup), Confluence page editing, REST
endpoints and good habits (read before write, discover don't guess, confirm
bulk or irreversible changes).

## Permissions

Per account, for Jira, Confluence and other actions: read, create & edit,
delete, admin; plus edit/remove account. Defaults allow reading and writing;
deletes, admin changes, unknown writes and removing an account ask. Every cell
is editable in the GUI (`/atlassian`, the Review-pane **+** menu, or
**Settings → Atlassian**); **Allow always** on a prompt writes allow.
Atlassian's own permissions still apply.

## Setup

```sh
pixi run --locked install                                 # verified snapshot into your OpenCode config
pixi run signin work --site acme.atlassian.net            # or use the GUI, or ask your agent
pixi run token-set dc                                      # token/PAT accounts
```

Export/Import in the GUI moves accounts, permissions and sign-ins between
installs (passphrase-encrypted).

## Development

```sh
pixi run --locked test            # fake Atlassian: OAuth (DCR, PKCE, refresh), agent interface, REST
pixi run --locked smoke-host      # real OpenCode 2.2.6 CLI, scripted model, fake Atlassian
```
