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

## Install

Requires [OpenCode](https://opencode.ai) 2.2.6+ (CLI or Desktop) and [Pixi](https://pixi.sh); macOS or Linux.

```sh
git clone https://github.com/p-w-rs/oc-atlassian.git && cd oc-atlassian
pixi run --locked install          # runs the tests, then installs a verified snapshot into your OpenCode config
```

Restart OpenCode (or `/reload`). Then open **Settings → Atlassian** (or `/atlassian` in a session) and add an account, or from a terminal: `pixi run signin work --site acme.atlassian.net`.
Agents can also set things up for you when you ask.

```sh
pixi run --locked install-status   # what is installed, and whether its files are intact
pixi run --locked rollback         # back to the previous snapshot
pixi run --locked uninstall        # removes only this plugin's entry; your data stays
```

Updating: `git pull && pixi run --locked install`. Accounts, sign-ins and permissions live in
`~/.local/share/oc-atlassian` and survive updates; move them between computers with **Export** / **Import** in the view.

## Development

```sh
pixi run --locked test            # fake Atlassian: OAuth (DCR, PKCE, refresh), agent interface, REST
pixi run --locked smoke-host      # real OpenCode 2.2.6 CLI, scripted model, fake Atlassian
```
