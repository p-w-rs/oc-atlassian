import { test } from "node:test"
import assert from "node:assert/strict"
import { capabilityOf, classifyAction, classifyRest, defaultEffect, normalizeAccount } from "./model.js"
import { searchActions } from "./tools.js"

test("accounts: sites, auth defaults and validation", () => {
  assert.deepEqual(normalizeAccount({ id: "work", site: "acme.atlassian.net/" }, new Date(0)), { id: "work", site: "https://acme.atlassian.net", auth: "browser", updatedAt: "1970-01-01T00:00:00.000Z" })
  assert.equal(normalizeAccount({ id: "dc", site: "https://jira.corp.example" }).auth, "pat")
  assert.throws(() => normalizeAccount({ id: "dc", site: "https://jira.corp.example", auth: "browser" }), /Data Center/)
  assert.throws(() => normalizeAccount({ id: "t", site: "acme.atlassian.net", auth: "token" }), /email/)
  assert.throws(() => normalizeAccount({ id: "x", site: "acme.atlassian.net", token: "nope" }), /Unknown account field/)
  assert.throws(() => normalizeAccount({ id: "bad id", site: "acme.atlassian.net" }), /account id/)
})

test("agent actions are classified by product and verb", () => {
  const kind = (name: string) => capabilityOf(classifyAction(name))
  assert.equal(kind("searchJiraIssuesUsingJql"), "jira-read")
  assert.equal(kind("getConfluencePublicLinkStatus"), "confluence-read")
  assert.equal(kind("createJiraIssue"), "jira-write")
  assert.equal(kind("transitionJiraIssue"), "jira-write")
  assert.equal(kind("manageJiraSprint"), "jira-write")
  assert.equal(kind("addOrEditJiraIssueComment"), "jira-write")
  assert.equal(kind("archiveConfluenceContent"), "confluence-delete")
  assert.equal(kind("removeConfluenceContentPermissions"), "confluence-delete")
  assert.equal(kind("addConfluenceContentPermissions"), "confluence-admin")
  assert.equal(kind("enableConfluencePublicLink"), "confluence-admin")
  assert.equal(kind("createConfluenceSpace"), "confluence-admin")
  assert.equal(kind("createJiraBoard"), "jira-admin")
  assert.equal(kind("atlassianUserInfo"), "other-read")
  assert.equal(kind("getAccessibleAtlassianResources"), "other-read")
  assert.equal(kind("frobnicateSomething"), "other-write")
})

test("REST calls are classified by method and path", () => {
  const kind = (product: "jira" | "confluence", method: string, path: string) => capabilityOf(classifyRest(product, method, path))
  assert.equal(kind("jira", "GET", "/rest/api/3/issue/ACME-1"), "jira-read")
  assert.equal(kind("jira", "POST", "/rest/api/3/search/jql"), "jira-read")
  assert.equal(kind("jira", "POST", "/rest/api/3/issue"), "jira-write")
  assert.equal(kind("jira", "POST", "/rest/api/3/issue/ACME-1/transitions"), "jira-write")
  assert.equal(kind("jira", "DELETE", "/rest/api/3/issue/ACME-1"), "jira-delete")
  assert.equal(kind("jira", "PUT", "/rest/api/3/project/ACME"), "jira-admin")
  assert.equal(kind("jira", "POST", "/rest/api/3/workflow"), "jira-admin")
  assert.equal(kind("jira", "GET", "/rest/api/3/user/search?query=a"), "jira-read")
  assert.equal(kind("confluence", "POST", "/api/v2/pages"), "confluence-write")
  assert.equal(kind("confluence", "POST", "/api/v2/spaces"), "confluence-admin")
  assert.equal(kind("confluence", "PUT", "/rest/api/content/1/restriction"), "confluence-admin")
})

test("defaults: reads and writes allowed; deletes, admin, unknown writes and removal ask", () => {
  for (const capability of ["jira-read", "jira-write", "confluence-write", "manage"]) assert.equal(defaultEffect(capability), "allow")
  for (const capability of ["jira-delete", "confluence-admin", "other-write", "remove"]) assert.equal(defaultEffect(capability), "ask")
})

test("action search ranks name matches first", () => {
  const tools = [{ name: "getJiraIssue", description: "x" }, { name: "transitionJiraIssue", description: "Move an issue to a new status" }, { name: "createConfluenceContent", description: "create page" }]
  assert.deepEqual(searchActions(tools, "transition issue").map(tool => tool.name), ["transitionJiraIssue", "getJiraIssue"])
  assert.deepEqual(searchActions(tools, "page").map(tool => tool.name), ["createConfluenceContent"])
})
