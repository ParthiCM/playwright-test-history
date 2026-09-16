# Adding this to a Jenkins job

Takes about ten minutes on an existing Playwright job. Nothing about the test
run itself changes.

## Before you start

| Check | Why it matters |
|---|---|
| The job has **Node available** — usually the NodeJS build wrapper | The report is a Node script |
| `playwright.config.ts` has the **JUnit reporter** enabled | That file is the input |
| The job **checks out the branch containing the script** | It can only run if it is in the workspace |
| You know a **path that persists between builds** | The store must outlive the build record |

If the JUnit reporter is not on yet, add it alongside whatever you already use:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["html", { outputFolder: "playwright-report" }],
    ["junit", { outputFile: "playwright-report/results.xml" }],
  ],
});
```

Both reporters can write to the same folder.

---

## Step 1 — get the script into the repo

Copy `src/` into your test repo, somewhere sensible:

```
tools/triage/
  triage-report.js
  lib/
  template/
```

It has no dependencies, so there is nothing to install and nothing to add to
`package.json`.

Commit it to the branch the job builds. If you are trialling it on a feature
branch first, point the job at that branch until you are happy.

## Step 2 — pick a store directory

This is the decision that matters. It must be:

- **outside the workspace** — workspace cleanup runs before every build
- **stable across builds** — the same path every time
- **one per job** — two jobs sharing a store interleave their build numbers and
  produce a meaningless report

A conventional choice on a container-based Jenkins:

```
/var/jenkins_home/ci-data/triage/<job-name>/
```

Ideally on a volume with its own lifecycle, so the Jenkins container can be
rebuilt without losing history.

## Step 3 — add the build step

**Configure → Build → Execute shell**, immediately above the final `exit`:

```bash
node tools/triage/triage-report.js --init --junit playwright-report/results.xml --build "$BUILD_NUMBER" --branch "$BRANCH_NAME" --env "$BASE_URL" --url "$BUILD_URL" --job "acme-shop-e2e" --store /var/jenkins_home/ci-data/triage/acme-shop-e2e --out triage-report/index.html
```

> **Keep it on one line.** Backslash line-continuations are the single most
> common way this step breaks. A trailing space after a backslash stops it
> continuing, bash splits the command in two, and you get `missing --store`
> followed by `--junit: command not found` — with the build marked failed even
> though every test passed.

> **Do not paste `---` separator lines from documentation into the shell step.**
> Bash will try to run them.

`--env` takes whatever variable holds the URL the suite ran against — `BASE_URL`,
`TEST_ENV`, `APP_URL`, whatever yours is called. It is normalised to
dev / staging / prod, so a full URL is fine. Omitting it is safe; those builds
render with a neutral dash.

A full working job is in
[`jenkins/freestyle-config.xml`](../jenkins/freestyle-config.xml), and the
Pipeline equivalent in [`jenkins/Jenkinsfile`](../jenkins/Jenkinsfile).

## Step 4 — publish it

**Configure → Post-build Actions → Publish HTML reports → Add**

| Field | Value |
|---|---|
| HTML directory to archive | `triage-report` |
| Index page[s] | `index.html` |
| **Report title** | `Test History` |
| Keep past HTML reports | unticked |
| Always link to last build | unticked |
| Allow missing report | **ticked** |

Two things here bite people:

**Two fields look alike.** *Report title* sets the **sidebar link label**.
*Index page title(s)* only sets the browser tab title inside the report. Put
your name in the wrong one and you get two sidebar entries both called "HTML
Report".

**Tick "Allow missing report".** If the suite dies before producing
`results.xml`, the output folder may not exist. Without this the whole build
fails on a missing report, burying the actual failure behind a reporting error.

## Step 5 — run a build, then remove `--init`

The console should end with:

```
triage-report: created store /var/jenkins_home/ci-data/triage/acme-shop-e2e
triage-report: wrote .../build-0142.json - 42 tests, 10 failed, 0 skipped
triage-report: rendered triage-report/index.html - 1 builds, 42 tests, 4 causes
[htmlpublisher] Archiving at PROJECT level .../triage-report to Test_20History
```

The sidebar link appears **only after a build has published the report**.
Saving the config is not enough.

Now **delete `--init`** from the command.

With `--init`, a missing store is silently recreated. If the job later runs on
an agent where the store volume is not mounted, you start a brand-new empty
history and nobody notices until someone goes looking for a trend that no
longer exists. Without it, that situation fails loudly.

This step is easy to skip and painful to discover later.

## Step 6 — two settings worth changing

**Raise `numToKeep` to ~30.** The history store is immune to rotation; console
logs and per-build reports are not. Otherwise the report will happily tell you a
test broke at build #312 and the log for #312 will be long gone.

**If the job does not use the Workspace Cleanup plugin**, delete the output
directories before the run:

```bash
rm -rf ./playwright-report/* ./triage-report
```

Without this, a run that dies before writing `results.xml` leaves the previous
build's files on disk, and the report step records stale results as if they
were this build's.

## Step 7 (optional) — a sidebar icon

HTML Publisher's `icon` field takes either a Jenkins symbol name or a file from
the report directory. For a symbol, browse [ionic.io/ionicons](https://ionic.io/ionicons),
pick the outline variant, and write it as:

```
symbol-stats-chart-outline plugin-ionicons-api
```

Requires the `ionicons-api` plugin. If the icon simply does not appear, that
plugin is missing — it fails silently rather than breaking the build.

---

## Adding it to a second job

Change two values: `--job` and `--store`. Everything else is identical.

Give the new job its **own** store directory. It is the one mistake that is
tedious to undo, because the two jobs' build numbers will already be
interleaved in a single history by the time it is obvious.
