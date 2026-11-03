---
name: harness
description: How to work inside a JiraSync Hub harness run. Load it first, for every task - before running tests, builds, lint, a dev server, git status/diff, or any HTTP request to the app under development. You have no shell; the app executes commands for you through the `harness` MCP tools and shows them to the owner live.
---

# Working in a JiraSync Hub run

You are running inside a git worktree prepared by JiraSync Hub for one Jira task.
The owner watches every command the app runs for you in the Run panel.

## What is already done before you start

- The worktree is checked out from the latest `origin/<base>` on branch `ai/<ISSUE-KEY>-<run-id>`.
- Dependencies are installed, `.env` is copied from the base repo, and any database or
  service containers are running and migrated. Their host/port are already in `.env`.
- Do not reinstall dependencies or recreate services. If something is missing, say so
  in your report instead of working around it.

## Tools you have

| Need | Use |
| --- | --- |
| Read, search, edit, create files | `Read`, `Glob`, `Grep`, `Edit`, `Write` (worktree only) |
| Run build / test / lint | `mcp__harness__run` with `command: "build" \| "test" \| "lint"` |
| Start the dev server | `mcp__harness__run` with `command: "dev"` (long-running; returns the port) |
| Call the app's HTTP API | write a `.hurl` file, then `mcp__harness__run` with `command: "hurl"`, `files: [...]` |
| Git state | `mcp__harness__git` with `op: "status" \| "diff" \| "log" \| "show"` (read-only) |
| Full output of an earlier command | `mcp__harness__get_log` with the `logId` from a run result |

There is no `Bash`, `curl`, `npm`, `bun`, `pip`, or other shell access. Do not try to find
one. Command names are fixed by the owner; you cannot pass a command string.

## Rules

1. **Never install anything.** No new dependencies unless the task requires it; if it does,
   edit the manifest/lockfile and say so. The app reinstalls before the final checks.
2. **Never commit or push.** The app commits, pushes, and opens a Draft PR after the owner
   accepts. Leave your changes uncommitted in the worktree.
3. **Results come from the app, not from you.** A run result has `status`, `exitCode`, and the
   tail of the output. Report what it says. Never claim tests pass without a passing result.
4. **Read the short result first.** Call `get_log` only when the tail is not enough to fix
   the failure, and ask for the page you need.
5. **Do not touch secrets.** You can read `.env`, but never copy its values into code, tests,
   `.hurl` files, logs, or your report. Use `{{variables}}` in Hurl instead.
6. **Stop and report** when a command fails for a reason outside the task (missing service,
   broken install, port in use).

## Typical loop

1. Read the task context and the relevant code.
2. Make the change with `Edit`/`Write`.
3. `run` → `test` (and `build` or `lint` if the change can affect them).
4. Fix and repeat until the result passes, within your repair budget.
5. For an HTTP behaviour change: `run` → `dev`, write a `.hurl` file, `run` → `hurl`.
6. Finish with a short report: what changed, which harness commands passed, what is still open.

## HTTP checks with Hurl

Put request files under `.harness/http/` in the worktree, for example
`.harness/http/create-user.hurl`. The app runs:

```
hurl --test --variable base_url=http://127.0.0.1:<dev port> --report-json <artifact> <files>
```

so always use `{{base_url}}` instead of a hard-coded host. Minimal example:

```hurl
GET {{base_url}}/health
HTTP 200

POST {{base_url}}/api/users
{ "name": "Ada" }
HTTP 201
[Captures]
user_id: jsonpath "$.id"
[Asserts]
jsonpath "$.name" == "Ada"

GET {{base_url}}/api/users/{{user_id}}
HTTP 200
```

For the full syntax (sections, captures, predicates, options, exit codes) load
`references/hurl.md` from the app: `mcp__harness__skill_get` with `name: "harness"` and
`file: "references/hurl.md"`.

`.harness/` is scratch space. Keep a `.hurl` file in the change only when it is a test the
owner should keep. Otherwise mention it in your report and the owner decides.
