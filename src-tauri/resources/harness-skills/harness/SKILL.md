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
- Do not recreate services. If install or migrate failed, the app asks you to fix it
  first: fix the cause (or the command) and run it again, without asking the owner.

## Language

Talk to the owner in the language the ticket is written in (its title and description in
`.harness/task.md`): your plan, progress notes, questions and reports. A Thai ticket gets Thai
answers, an English ticket English ones. Code, identifiers, file paths and commands stay as
they are. Commit and pull-request text follows its own rules in the drafting step.

## Solve it with the least new code

Writing code is the last option, not the first. The best change is the one you never write.
Before you plan any code, search the repo (`Grep`, `Glob`) and walk this ladder. Take the first
step that fully solves the task:

1. **Does it need to exist?** Skip options, flexibility and "for later" code nobody asked for.
2. **Already in this codebase?** Look for an existing helper, component, util or pattern that
   does it (search by what it does, not only by name) and use it the way nearby code does.
3. **A platform or standard-library feature?** Prefer it. Check whether a different argument,
   locale, flag or setting changes the behaviour before you add code that post-processes it.
4. **An installed dependency?** Use it. Never add one for a few lines.
5. **One obvious line** a reader gets at a glance.
6. Only then: the minimum new code that works.

- Fix the root cause once, in the shared code. Before editing a function, `Grep` every caller.
- No new wrapper, helper, type conversion, option or config unless a caller truly needs it.
  Deleting code beats adding it.
- Be lazy about the solution, not about the change: still finish every caller, test and
  fixture the change touches, and keep validation and error handling at trust boundaries.
- New non-trivial logic (a branch, a parser, money, security) gets one small test; trivial
  changes need none.
- Name what you skipped or did not check, and any risk, in your plan and your report.

## Tools you have

| Need                              | Use                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| Read, search, edit, create files  | `Read`, `Glob`, `Grep`, `Edit`, `Write` (worktree only)                               |
| Run build / test / lint           | `mcp__harness__run` with `command: "build" \| "test" \| "lint"`                       |
| Re-run setup after fixing it      | `mcp__harness__run` with `command: "install" \| "migrate"`                            |
| Fix a project command that is wrong | `mcp__harness__set_command` with `name`, `executable`, `args` (saved for later runs) |
| Start the dev server              | `mcp__harness__run` with `command: "dev"` (long-running; returns the port)            |
| Call the app's HTTP API           | write a `.hurl` file, then `mcp__harness__run` with `command: "hurl"`, `files: [...]` |
| Git state                         | `mcp__harness__git` with `op: "status" \| "diff" \| "log" \| "show"` (read-only)      |
| Full output of an earlier command | `mcp__harness__get_log` with the `logId` from a run result                            |

There is no `Bash`, `curl`, `npm`, `bun`, `pip`, or other shell access. Do not try to find
one. Command names are fixed by the owner; you cannot pass a command string.

## Rules

1. **No new dependencies** unless the task requires it; if it does, edit the manifest/lockfile
   and say so. Re-run `install` through `run`; the app also reinstalls before the final checks.
2. **Never commit or push.** The app commits, pushes, and opens a Draft PR after the owner
   accepts. Leave your changes uncommitted in the worktree.
3. **Results come from the app, not from you.** A run result has `status`, `exitCode`, and the
   tail of the output. Report what it says. Never claim tests pass without a passing result.
4. **Read the short result first.** Call `get_log` only when the tail is not enough to fix
   the failure, and ask for the page you need.
5. **Do not touch secrets.** You can read `.env`, but never copy its values into code, tests,
   `.hurl` files, logs, or your report. Use `{{variables}}` in Hurl instead.
6. **A failed command is yours to fix; do not ask the owner.** Read its output. If your code
   or the repo is the cause, fix that. If the command itself is wrong (flags, folder, script
   name), fix it with `set_command`. Then run it again. Stop and report only when the cause is
   outside the repo and the commands (Docker or the network is down, a credential is missing).

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
