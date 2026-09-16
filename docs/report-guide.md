# Reading the report

The page has three parts, and they answer three different questions.

> Open [`demo/report.html`](../demo/report.html) alongside this — it is built
> from the mock history and every example below is visible in it.

---

## 1. Trend — *is this getting better or worse?*

One bar per build: red failed, amber skipped, green passed, each as a share of
that build's own total.

**Compare shares, not counts.** Totals move when tests are added or removed. A
build that went from 10 failures to 12 while the suite grew from 40 tests to 60
got *better*, and the bar shows that where the number does not.

Each row carries an **environment chip**. A suite that ran against staging on
Monday and production on Tuesday produces two builds whose failures are not
comparable — the **ENV filter** above the trend exists to stop you drawing a
conclusion across that boundary.

The chip carries a colour *and* a label on purpose. Colour alone does not
survive a greyscale print, a compressed screenshot pasted into chat, or the
~8% of men who cannot separate orange from green.

| Chip | Environment |
|---|---|
| `DEV` blue | dev, local, feature branches |
| `STG` orange | staging, preprod, QA, UAT |
| `PROD` green | production |
| `—` grey | not recorded (no `--env` passed) |

Anything else keeps its own name, capped to four letters, in neutral grey.

---

## 2. Table A — *what is the history of this specific test?*

One row per test, one column per build. This is the part you cannot get
anywhere else.

**Read the shapes before you read anything else.**

| Shape | Meaning |
|---|---|
| ▬▬▬▬▬▬ solid red | Chronically broken. Has never worked. Often nobody has ever looked. |
| ▬▬▬▬▬▬ solid green | Fine. Ignore it. |
| ▬ ▬ ▬ ▬ alternating | **Flaky.** The test, not the product, is usually the problem. |
| ▬▬▬▬ → green | A fix landed. The column where it turns is the build that fixed it. |
| green → ▬▬▬▬ | A regression. The column where it turns is the build that broke it. |
| ⌐ ⌐ dashed | The test did not exist in that build. |

That last one matters more than it looks. A test that was *absent* is not a
test that *passed*, and conflating them is how a report quietly lies about
coverage. Added, renamed and deleted tests all show honestly.

### The three summary columns

| Column | Meaning |
|---|---|
| **rate** | passed / executed runs. Skips and absences are excluded, so `6/9` means it genuinely ran nine times. |
| **flips** | How many times the outcome changed. **2 or more is the working definition of flaky.** |
| **since** | The build the current unbroken failing run began. `#103` means it has been red since #103 — that is where to look in the commit history. |

### Controls

- **search** — by test id or title
- **failing now / flaky / fixed / always green** — the four questions people
  actually arrive with
- **diff mode** — rings every cell whose outcome changed from the build before
  it. Useful for scanning a long history for the exact build where something
  moved.
- **columns** — hide any column or build. The **environment quick-picks**
  narrow the grid to just the builds from one environment in a single click.

Rows are sorted currently-failing first, then flakiest. What you need is at the
top before you touch a single control.

---

## 3. Table B — *how much work is this actually?*

Every test failing in the latest build, grouped by **failure signature** — the
error message plus the deepest frame in your own code.

This is the row that changes your afternoon. Straight from the demo's build
#114:

| tests | error & location |
|---|---|
| **3** | `expect(received).toEqual(expected)` — `src/pages/cart.page.ts:64` |
| **3** | `locator.click: Timeout <n>ms exceeded` — `src/pages/search.page.ts:88` |
| **3** | `locator.waitFor: Timeout <n>ms exceeded` — `src/pages/product.page.ts:203` |
| **1** | `Download did not start within <n>ms` — `src/pages/account.page.ts:157` |

Ten red tests. **Four things to fix** — and three of those four are a single
line in a single page object.

Without this, ten failures look like ten investigations. Rows are sorted by how
many tests each one unblocks, so the top row is almost always where to start.
Earlier in the same history it is starker: at build #104, **sixteen failures
collapse to five causes**, and the largest single row accounts for six of them.

**The grouping is mechanical, not clever.** It tells you which tests share a
cause. It does not tell you what the cause *is* — that judgement is still
yours. Two genuinely different bugs that happen to produce the same timeout in
the same helper will group together, and occasionally one bug will split across
two rows because it surfaces in two places.

An empty Table B is the goal.

---

## A worked example

From the demo history:

1. **Trend** — failures climb from 11 to 16 over builds #101–#104, then drop
   sharply to 5 at #109. Something big was fixed there.
2. **Table A**, six `checkout` rows — all solid red through #108, all green
   from #109. That is the fix, and it landed in one build.
3. **Table A**, `TC-1024/1025/1026` — green until #111, red from #112. A
   regression, and #112 is the build that introduced it.
4. **Table B** confirms it: three tests, one signature,
   `src/pages/product.page.ts:203`. One fix.
5. **`TC-1053`** is solid red across all fourteen builds with 0 flips. It has
   never passed. Nobody has ever looked at it.
6. **`TC-1034`** has 7 flips in 14 builds. That is not the product — that test
   needs rewriting.

Six conclusions, none of which any single-build report can support.
