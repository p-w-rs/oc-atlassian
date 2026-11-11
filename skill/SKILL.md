---
name: atlassian
description: Work effectively in Jira and Confluence through the oc-atlassian tools — finding and running actions, JQL and CQL, issue fields and transitions, content formats (Markdown, ADF, storage), sprints, worklogs, pages, comments, attachments, and REST for token accounts. Load before non-trivial Atlassian work.
---

# Working in Jira and Confluence

## Tools

- `atlassian_list` — accounts (sites), who you are there, products, and what you may do.
- `atlassian_find_actions` — search actions by keyword; then `names=[...]` to read exact parameters. **Always read the
  schema before the first call of an action**; parameter names differ (`issueIdOrKey`, `content_id`, `contentId`…).
- `atlassian_run` — run an action (`action`, `arguments`); `cloudId` is filled in. Output over 60k characters is cut:
  narrow with fields, limits, pagination.
- `atlassian_rest` — `product` (`jira`|`confluence`), `method`, relative `path`, `query`, `body`. Only for `token`
  (Cloud API token) and `pat` (Data Center) accounts; for these `atlassian_find_actions` returns no actions.
- Several accounts: pass `account`. If unclear which site the user means, use the conversation or ask.
- Setup: `atlassian_account_upsert` → `atlassian_signin` (browser) or `atlassian_request_token` (the user enters it
  outside the chat — never ask for a token in chat); `atlassian_refresh` afterwards.

Permissions (defaults): reads, creates and edits run; deletes/archives, admin changes (permissions, restrictions, public
links, new spaces/boards) and non-Jira/Confluence writes ask. A denied action says so — tell the user, do not look for a
workaround.

## Habits that make results good

1. **Read before writing.** Fetch the issue/page first; keep what you do not intend to change. Never overwrite a
   description or page body with a summary of it.
2. **Discover, do not guess.** Project keys (`listJiraProjects`), issue types (`listJiraProjectIssueTypesMetadata`, then
   `getJiraIssueTypeMetaWithFields` with its id for required fields), transitions (`listJiraIssueTransitions`),
   accountIds (`listJiraIssueAssignableUsers`, `lookupJiraAccountId` — Cloud has no usernames), link types
   (`listJiraIssueLinkTypes`), statuses (`listJiraStatuses`), boards and sprints.
3. **Small, verifiable steps.** After a write, check what matters (status, assignee, page version) and report links
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
- `sprint in openSprints()`, `sprint in closedSprints()`, `parent = ABC-12` (`"Epic Link"` is legacy)
- `labels in (backend, api)`, `component = "Payments"`, `fixVersion = "2.3"`, `issuetype in (Bug, Story)`
- `status changed to Done during (startOfMonth(), now())`; `issueFunction` needs ScriptRunner (often unavailable).
- Quote values with spaces or reserved words; use `statusCategory` (To Do / In Progress / Done) when status names vary.
- `searchJiraIssuesUsingJql`: request only needed `fields` (custom fields need `view: "evidence"` or explicit
  `customfield_*` ids), `maxResults` ≤ 100, page with `nextPageToken` until `isLast`.

### Issues
- `createJiraIssue`: `projectKey`, `issueType` (name), `summary`; `parent` for sub-tasks/children; `assignToSprint`.
  Custom fields in `additional_fields` by **name** (`{"Story Points": 8}`) or `customfield_*` id; a rejected create
  returns `repairHint`/`allowedValues`. If only the sprint step fails, the issue exists — do not create it twice.
- `editJiraIssue` **sets, not appends** — send full lists for labels, components, fixVersions; clear with `null`.
- Descriptions and comments: actions take Markdown (default) or HTML with `contentFormat: "html"` (see
  `getContentFormatGuide`). Bodies with media, panels or @mentions come back as HTML — write them back as HTML.
  REST v3 needs **ADF** JSON; REST v2 and Data Center take wiki markup (`h2.`, `*bold*`, `{code}…{code}`).
- Status changes are **transitions** (`transitionJiraIssue` with `transitionId` — a transition's name is not its target
  status), plus `fields` the screen requires (e.g. resolution). Comment with `addOrEditJiraIssueComment`, not there.
- Links: `createJiraIssueLink` (type name, direction: "blocks" vs "is blocked by"); URLs/pages:
  `createJiraIssueRemoteIssueLink`.
- Worklogs: `addOrEditJiraIssueWorklog`, `timeSpent` like `1h 30m`, `started` like `2026-01-01T09:00:00.000+0000`.
- Attachments: `uploadAttachmentToJiraIssue` is two-phase (call with `filePath`, run the returned `uploadCommand` in
  the shell, call again with the `fileId`); `downloadJiraIssueAttachment` returns a `downloadCommand` to run.

### Agile
- Boards (`listJiraBoards`), sprints (`listJiraBoardSprints`, `getJiraBoardSprintData` — by name, active by default),
  board/backlog issues (`getJiraBoardIssueData`). `manageJiraSprint`: create, add issues, start, update (rewrites the
  whole sprint), close. One issue into a sprint/backlog: `transitionJiraIssue` with `sprintId` or `assignToBacklog`.
- Versions/releases: `getJiraProjectVersions`, `manageJiraProjectVersion`.

## Confluence

### CQL essentials (`searchConfluence`: `cql`, `limit`, `cursor`)
- `type = page AND space = ENG AND title ~ "runbook"`
- `text ~ "incident" AND lastmodified >= now("-30d") ORDER BY lastmodified DESC`
- `label = "architecture"`, `ancestor = 12345` (everything under a page), `creator = currentUser()`
- `type in (page, blogpost)`, `contributor = currentUser()`

### Pages
- Spaces have keys and numeric ids (`getConfluenceSpace` also returns space instructions to follow). Create with
  `createConfluenceContent`: `parent` (`{spaceId, parentContentId}`), `contentType` (`page` for a classic page,
  `live_doc`, `blogpost`…), `title`, `body`.
- Edit: `getConfluenceContent` (`draft: true, detail: "full"`) → `updateConfluenceContent` with the returned
  `snapshotToken` and the **whole** new `body` (or granular `edits`; `dryRun` previews). On `snapshot_stale`, re-read
  and reapply.
- Formats: `body: {format: "html"|"markdown", value}`. Confluence HTML is not plain HTML: read `getContentFormatGuide`
  (`toolName: "createConfluencePage"`/`"updateConfluencePage"`) once per task. Use HTML when the page has macros,
  panels, layouts or media, and preserve them.
- Comments: `createConfluenceComment`; resolve (`updateConfluenceCommentResolution`) rather than delete.
- Moving, archiving, restricting and permission changes affect other people — confirm first.
- `getConfluenceContentDescendants` for page trees; `diffConfluenceContentVersions` to show what changed;
  attachments via `createConfluenceAttachment`/`downloadConfluenceAttachment` (they return a curl command to run).

## REST (token accounts)

Cloud Jira: `/rest/api/3/...` (ADF), agile under `/rest/agile/1.0/...`. Search: `GET /rest/api/3/search/jql` with
`jql`, `fields=summary,status`, paged by `nextPageToken` (the old `/rest/api/3/search` is removed).
Cloud Confluence (relative to `<site>/wiki`): `/api/v2/pages`, `/api/v2/spaces`, `?body-format=storage`; update with
`PUT /api/v2/pages/{id}` (`id`, `status`, `title`, `body: {representation: "storage", value}`, `version.number` + 1).
CQL search: `/rest/api/search?cql=`.
Data Center: Jira `/rest/api/2/...`, Confluence `/rest/api/content/...`, `/rest/api/search?cql=`.
Errors: 400 = a field is wrong (read `errors`), 401 = token bad/expired, 403 = no permission, 404 = wrong key or no access, 409 = stale version, 429 = slow down.
