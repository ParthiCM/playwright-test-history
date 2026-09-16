# Troubleshooting

Every entry here is a failure that has actually happened.

## The build step

### `missing --store`, then `--junit: command not found`

A broken line continuation. The backslash at the end of a line is missing, or
has a trailing space after it — which stops it continuing. Bash then runs the
`node` line on its own (no `--store`) and the rest as a separate command.

The tell is that you get **one** `command not found`, not eight: the remaining
backslashes are intact, so everything after the break joins into a single
bogus command.

The build is marked **failed even though the tests passed**, and failure emails
go out.

**Fix:** put the whole command on one line. This is why every example in this
repo does.

### `Cannot find module '.../triage-report.js'`

The job is building a branch that does not contain the script. Check the
branch spec against the branch you committed to.

### `store not found: <path>`

Expected on the very first run. Add `--init` for one build, then remove it.

If it appears **later**, something has changed — most often the job ran on an
agent where the store volume is not mounted. That is exactly what this error
exists to tell you. Do not solve it by putting `--init` back; find out why the
path vanished, or you will silently start history over.

### `---: command not found`

A `---` separator line was copied out of a markdown document into the shell
step. Delete it.

---

## The report

### The sidebar link is missing

No build has published the report yet. Saving the job config is not enough —
the link is created by the first successful publish. Run a build.

### "Not Found" at the report URL

Same cause as above. The path is created by the first publish.

### The report shows an old build

Two possibilities, and the console output tells you which.

**The report step failed.** Look for the `triage-report:` lines. If they are
absent or show an error, the HTML was never regenerated.

**The job has no workspace cleanup.** Without it, `triage-report/index.html`
from the previous build is still on disk, and HTML Publisher re-archives that
stale file every build — link works, content is days old, nothing warns you.

**Fix:** add `rm -rf ./playwright-report/* ./triage-report` before the test run.
With `allowMissing` ticked, a failed generation then shows an empty report
rather than silently serving old data.

> The console output is the authority on what happened, not the page.

### Every failure is its own row in Table B

The cause table is supposed to collapse failures. If it shows one row per test,
something is producing a unique signature per failure.

Almost always: the signature is being read from `<system-out>` rather than
`<failure>`, and picking up a timestamped log line. This is the defect
`test/signature.test.js` exists to prevent, so if you are on an unmodified copy
you should not see it.

If you have customised the parser, check `failureText()` is still scoped to the
`<failure>`/`<error>` element.

### History suddenly starts from one build

The job ran somewhere the store volume is not mounted, **and** `--init` was
still in the command — so it cheerfully created an empty directory.

Check which agent the build ran on. Remove `--init`. If you have a backup of
the store directory, restore it; otherwise that history is gone.

This is the failure mode the `--init` rule exists to prevent.

### All environment chips show a grey dash

`--env` is not being passed, or the builds predate it. Past builds are **not**
backfilled — the tool will not guess at an environment it did not record.

Check the variable name too: `BASE_URL` in these docs is only a convention.

### A chip shows an unexpected label like `SAND`

The URL did not match dev / staging / prod, so the first four letters of the
hostname's first label are used. That is working as intended — an unrecognised
environment is recorded and labelled rather than discarded. Add a mapping to
`ALIASES` in `src/lib/env.js` if you want it coloured.

### Tests I deleted are still in Table A

Correct. The table is every test **ever seen**, and a deleted test shows dashed
cells for the builds after it went. That is the honest rendering — a test that
disappeared is different from a test that passed.

Filter to *failing now* to see only what is live.

### The matrix is unreadably wide

The **columns** menu hides builds. It defaults to the last 30 when history goes
beyond that. The quick-picks (`last 10`, `last 20`) narrow it further, and the
environment quick-picks narrow it to one environment.

---

## Data questions

### Where exactly is my history?

Whatever you passed to `--store`. The console prints it on every run.

```
ls -la /var/jenkins_home/ci-data/triage/acme-shop-e2e/
```

One JSON file per build. They are plain JSON — readable, greppable, and easy to
back up or move between servers.

### How do I back it up?

Copy the directory. That is the entire procedure; there is no database and no
export step.

It is worth doing. Once this has been running a while, that directory is the
**only** record of test history beyond the last few builds.

### Can I merge two stores?

Copy the files together, as long as the build numbers do not collide. If they
do, the two jobs were never one history and merging them will produce
nonsense.

### Can I re-run a build without corrupting history?

Yes. Re-running build #142 replaces `build-0142.json` and nothing else. That is
what the one-file-per-build layout is for.
