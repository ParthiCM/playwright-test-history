# Architecture

## The problem

Every per-build test report dies with the build that produced it.

Jenkins rotates build records — the default `numToKeep` on most jobs is a
handful. Playwright's HTML report, Allure and the JUnit archiver each show
**one build**. So the questions a team actually asks:

- *Has TC-1042 ever passed, or has it been red since the day it was written?*
- *Did my fix work, or did it just get lucky on one run?*
- *Are these 26 failures 26 problems, or 4?*

…all need evidence that has usually already been deleted by the time anyone
thinks to look.

The second problem is subtler. Even with one build in front of you, a wall of
40 red tests tells you almost nothing about **how much work** you are looking
at. It could be one broken selector or fifteen unrelated regressions, and
nothing in a standard report distinguishes those two cases.

## The shape of the solution

```
Playwright run
  │
  │  writes   playwright-report/results.xml        (JUnit — already produced today)
  ▼
triage-report.js                                   (a post-test shell step)
  │
  │  appends  <store>/build-0142.json              OUTSIDE the workspace
  │  reads    <store>/build-*.json                 the full history
  ▼
triage-report/index.html                           one self-contained page
  │
  ▼
HTML Publisher ──► a link in the job sidebar
```

Four design decisions do all the work.

### 1. The store lives outside the build record

This is the whole idea. Results are written to a directory the CI server does
not own:

```
/var/jenkins_home/ci-data/triage/<job-name>/
  build-0139.json
  build-0140.json
  build-0141.json
```

Build rotation cannot touch it. Workspace cleanup cannot touch it. Build #142's
data is captured at build #142 and stays there long after Jenkins has forgotten
#142 ever existed.

The practical requirement is a path that is stable across builds and, ideally,
on a volume with a different lifecycle from the CI server itself — see
[`jenkins/docker-compose.yml`](../jenkins/docker-compose.yml), where the store
is a separate Docker volume so the Jenkins container can be rebuilt without
losing history.

### 2. One immutable file per build

Not one growing database. Each build writes only its own file and never reads
or rewrites another's.

That single constraint buys three properties for free:

| Property | Why it follows |
|---|---|
| **Crash-safe** | A build that dies mid-write corrupts at most its own file. `readStore` skips unparseable files, so the rest of history renders. |
| **Idempotent** | Re-running build #142 replaces `build-0142.json`. No duplicate column, no reconciliation logic. |
| **Concurrency-safe** | Two builds running at once write different filenames. No locking. |

It costs roughly 10–15 KB per build. A thousand builds is a few megabytes.

### 3. Read JUnit, not the CI API

The tool parses the XML file on disk rather than calling the Jenkins API.

This matters more than it sounds. An API-driven reporter can only see what the
server still remembers, which puts you back where you started. Reading the file
means build #142's data is captured **at build #142**, while the file is still
sitting in the workspace — and it makes the tool work identically on GitHub
Actions, GitLab CI or a laptop.

### 4. Failure-signature clustering

The signature is:

```
<normalised error message>  @  <deepest frame in your own code>
```

Two tests that fail with the same message in the same place are almost always
the same defect. Grouping on that pair turns "26 tests are red" into "you have
4 things to fix", ordered by how many tests each one unblocks.

Two details make it work, and both are easy to get wrong:

**Read the `<failure>` element, not the first CDATA block.** An early version of
this took the first CDATA anywhere inside `<testcase>`. On any suite that logs
to stdout, that is `<system-out>` — so every signature picked up a unique
timestamp, every group had exactly one member, and the cause table degenerated
into one row per test. It looked like it was working. It was worse than useless,
because it *appeared* to be triaging. See `test/signature.test.js`.

**Normalise volatile values.** Timeouts in milliseconds, UUIDs, timestamps and
memory addresses all differ between two runs of the identical defect. They are
replaced with placeholders before the signature is formed.

The grouping is mechanical, not clever. It tells you *which tests share a
cause*; it does not tell you *why*. The report says so, in the report.

## Module layout

```
src/
  triage-report.js      CLI: argument handling, orchestration, exit codes
  lib/
    junit.js            JUnit XML → test results
    signature.js        failure text → signature → clusters
    store.js            immutable per-build store, and the history matrix
    env.js              URL → environment name
  template/
    report-template.html   the UI, with __TITLE__ and __DATA__ placeholders
```

The template is a separate file with two placeholder tokens. The generator
never builds HTML by concatenation — it reads the template and substitutes the
data as one JSON blob. That keeps the visual design editable without touching
the parser, and keeps the parser testable without rendering anything.

## Why zero dependencies

The consumer is a shell step on a build agent someone else administers. Every
dependency is a thing that can fail to install, pull a CVE, or need a lockfile
committed to a repo that is about tests, not tooling.

The cost is a regex-based XML reader rather than a real parser. That is a real
trade-off, and it is only acceptable because the input shape is narrow and
every assumption is pinned down by a test. If this had to accept arbitrary XML,
the trade would be wrong.

## What this does not do

- **It is not a flake-quarantine system.** It shows you what is flaky; deciding
  what to do about it is a human call.
- **It does not know why anything failed.** It groups; it does not diagnose.
- **It does not replace a per-build report.** Playwright's HTML report has
  traces, screenshots and videos. This answers a different question — the one
  that spans builds — and links back to the build for the rest.
