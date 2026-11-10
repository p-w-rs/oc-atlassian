---
name: atlassian
description: Work effectively in Jira and Confluence through the oc-atlassian tools — finding and running actions, JQL and CQL, issue fields and transitions, content formats (Markdown, ADF, storage), sprints, worklogs, pages, comments, attachments, and REST for token accounts. Load before non-trivial Atlassian work.
---

# Working in Jira and Confluence

## Tools

- `atlassian_list` — accounts (sites), who you are there, products, and what you may do.
- `atlassian_find_actions` — search actions by keyword; then `names=[...]` to read exact parameters. **Always read the
  schema before the first call of an action**; parameter names differ between actions.
- `atlassian_run` — run an action. `cloudId` is filled in automatically.
- `atlassian_rest` — any REST endpoint, for accounts that use an API token (Cloud) or a personal access token (Data Center).
- Several accounts: pass `account`. If unclear which site the user means, use the conversation or ask.

Permissions: reads usually just run; creates and edits may run or ask; deletes and admin changes ask by default. A
denied action says so — tell the user, do not look for a workaround.

## Habits that make results good

1. **Read before writing.** Fetch the issue/page first; keep what you do not intend to change. Never overwrite a
   description or page body with a summary of it.
2. **Discover, do not guess.** Project keys (`listJiraProjects`), issue types and required fields
   (`getJiraIssueTypeMetaWithFields`), transition ids (`listJiraIssueTransitions`), users' accountIds
   (`lookupJiraAccountId` — Cloud has no usernames), link types (`listJiraIssueLinkTypes`), boards and sprints.
3. **Small, verifiable steps.** After a write, read back what matters (status, assignee, page version) and report links
   (`https://<site>/browse/KEY-1`, page URL from the response).
4. **Ask before bulk or irreversible changes** (many issues, deleting, moving pages, permission changes) unless the user
   clearly asked for exactly that.
5. **Quote the user's words** in comments only when asked; write professionally, in the user's language and tone.

## Jira

### JQL essentials
- `project = ABC AND statusCategory != Done ORDER BY updated DESC`
- `assignee = currentUser() AND resolution = Unresolved`
- `text ~ "login timeout"` (full text), `summary ~ "\"exact phrase\""`
- `updated >= -7d`, `created >= startOfWeek()`, `duedate < now()`
- `sprint in openSprints()`, `sprint in closedSprints()`, `"Epic Link" = ABC-12` (older), `parent = ABC-12` (current)
- `labels in (backend, api)`, `component = "Payments"`, `fixVersion = "2.3"`, `issuetype in (Bug, Story)`
- `status changed to Done during (startOfMonth(), now())`, `issueFunction` needs ScriptRunner (often unavailable).
- Quote values with spaces or reserved words; use `statusCategory` (To Do / In Progress / Done) when status names vary.
- Ask only for the fields you need and page through results (`maxResults`, `nextPageToken`/`startAt`).

### Issues
- Create: project key, issue type, summary; plus required fields from the metadata. Parent for sub-tasks/children.
- Descriptions and comments: the agent actions accept Markdown; REST v3 needs **ADF** (Atlassian Document Format);
  REST v2 and Data Center take wiki markup (`h2.`, `*bold*`, `{code}…{code}`).
- Custom fields have ids like `customfield_10016`; find them in the create/edit metadata (name → id). Story points,
  epic, team and sprint are custom fields and differ per site.
- Status changes are **transitions**: list them for the issue, use the transition id, and supply fields the transition
  screen requires (e.g. resolution).
- Assign with an accountId; unassign with `null`.
- Links: pick the link type name and direction (`inward`/`outward` text) correctly ("blocks" vs "is blocked by").
- Worklogs: time spent like `1h 30m`, `started` as ISO date-time with offset.
- Attachments: upload/download through the attachment actions; mention file names in your summary.

### Agile
- Boards (`listJiraBoards`), sprints (`listJiraBoardSprints`, `manageJiraSprint` to create/start/complete), board
  issues (`getJiraBoardIssueData`). Moving issues into a sprint is an edit of the sprint field or a sprint action.
- Versions/releases: `getJiraProjectVersions`, `manageJiraProjectVersion`.

## Confluence

### CQL essentials
- `type = page AND space = ENG AND title ~ "runbook"`
- `text ~ "incident" AND lastmodified >= now("-30d") ORDER BY lastmodified DESC`
- `label = "architecture"`, `ancestor = 12345` (everything under a page), `creator = currentUser()`
- `type in (page, blogpost)`, `contributor = currentUser()`

### Pages
- Spaces have keys and ids; pages have ids, versions and a parent. Find the space and parent before creating.
- Read the current version first; updates need the latest version number (incremented by the action or by you in REST)
  and the **whole** new body — fetch, edit, write back.
- Formats: the agent actions take Markdown or the storage format (XHTML with `ac:` macros); `getContentFormatGuide`
  explains what the site expects. Preserve macros (tables of contents, Jira issue macros, panels) when editing.
- Comments: footer comments for discussion, inline comments anchor to text. Resolve rather than delete.
- Moving, archiving, restricting and permission changes affect other people — confirm first.
- Large pages: work section by section; `getConfluenceContentDescendants` for page trees; `diffConfluenceContentVersions` to show what changed.

## REST (token accounts)

Cloud Jira: `/rest/api/3/...` (ADF), agile under `/rest/agile/1.0/...`. Search with `GET /rest/api/3/search/jql?jql=…&fields=summary,status`.
Cloud Confluence: `/api/v2/...` (`/api/v2/pages`, `/api/v2/spaces`, body format `storage` or `atlas_doc_format`); legacy `/rest/api/content` for CQL search (`/rest/api/search?cql=`).
Data Center: Jira `/rest/api/2/...`, Confluence `/rest/api/content/...`, `/rest/api/search?cql=`.
Errors: 400 = a field is wrong (read `errors`), 401 = token bad/expired, 403 = no permission, 404 = wrong key or no access, 429 = slow down.
