# cy2pw — Cypress → Playwright migration engine
![coverage](https://github.com/masimzain-11/cy2pw/actions/workflows/coverage.yml/badge.svg)

A three-layer tool that migrates Cypress test suites to Playwright. It converts
what can be converted mechanically, uses an LLM only for what genuinely needs
one, and **explicitly flags what no tool should try to convert** — then verifies
the result against a running app.

Built to answer a real question honestly: *how much of a real-world Cypress
suite can actually be automated away, and what's the irreducible human part?*

---

## Coverage on real suites

Coverage is measured against **unmodified third-party production specs**, not
hand-picked examples: three specs from
[`cypress-realworld-app`](https://github.com/cypress-io/cypress-realworld-app)
(Cypress's own reference application), plus one controlled `login` spec that is
also verified end-to-end through the repair loop.

```
────────────────────────────────────────────────────────────────
SPEC                          auto     LLM    manl    fail
────────────────────────────────────────────────────────────────
login                        12    0    0    0
rwa-auth                     51   17   23    0
rwa-new-transaction          49   35   24    0
rwa-user-settings            36    4    5    0
────────────────────────────────────────────────────────────────
TOTAL (4 specs)             148   56   52    0
────────────────────────────────────────────────────────────────
```

| Layer                               | Statements | Share |
| ----------------------------------- | ---------- | ----- |
| Auto-converted (deterministic)      | 148        | ~58%  |
| LLM-convertible                     | 56         | ~22%  |
| Manual rewrite (app infrastructure) | 52         | ~20%  |
| Crashed                             | 0          | 0%    |

**256 Cypress statements, zero crashes.** The number that matters isn't the 58% —
it's that the tool *classifies* the remaining 42% correctly instead of pretending
it converted them. Reproduce it yourself with `npx tsx src/cy2pw.ts samples`.

---

## Architecture

Three layers, each doing only what it's good at:

**1. Deterministic codemod (`migrate.ts`)** — parses each spec into an AST with
`ts-morph`, then rewrites known patterns by *string-splicing the source* (analyse
with the tree, never mutate it — an in-place approach crashed on real multi-line
statements). Handles `cy.get/visit/type/click/should`, chained `.and()`
assertions, `describe/it/hook` restructuring with `async ({ page })` injection,
custom `getBySel`/`getBySelLike` → `getByTestId`, and the intelligent deletions
that separate a real migrator from a find-and-replace script (e.g. `cy.wait(1000)`
is *deleted*, not translated — Playwright auto-waits). Unknown commands are left
with a `// TODO(migrate)` marker. Never crashes; degrades and reports.

**2. LLM layer (`ai-fill.ts`)** — sends only the marked unknown snippets to Claude
for conversion (`cy.intercept` → `page.route`, `cy.wait('@alias')` →
`page.waitForResponse`). Cheap because the deterministic layer already did the
bulk. A free `CY2PW_DRY_RUN` mode tests the plumbing with no API cost.

**3. Run-verify-repair loop (`verify.ts`)** — runs the migrated spec against the
live app; on failure it feeds the spec + the runner output back to Claude for a
fix, then re-runs, up to a bounded number of attempts. Static conversion produces
code that *looks* right; only running it proves it. Currently verified end-to-end
on the `login` spec; running it against the RWA specs first requires resolving
their manual-rewrite items (see roadmap).

`cy2pw.ts` orchestrates layer 1 across a suite and prints the coverage table above.

---

## Usage

```bash
npm install                     # ts-morph, @playwright/test, @anthropic-ai/sdk, tsx
npx playwright install chromium

# whole-suite coverage report (deterministic layer)
npx tsx src/cy2pw.ts samples

# single file, each layer explicitly
npx tsx src/migrate.ts samples/login.cy.ts        # layer 1 -> out/login.spec.ts
export ANTHROPIC_API_KEY=your-key-here
npx tsx src/ai-fill.ts out/login.spec.ts          # layer 2 (fills unknowns)
npx tsx src/verify.ts out/login.spec.ts           # layer 3 (runs + self-repairs)
```

Playwright's `testIdAttribute` must match the source app's attribute (this repo
uses `data-test`) — set in `playwright.config.ts`. The codemod emits
`getByTestId(...)`; that config line is the other half of the same decision.

---

## Design decisions worth reading the code for

- **Analyse with the AST, mutate with string splicing.** In-place tree
  manipulation threw on real nested statements. Splicing computed offsets
  right-to-left cannot corrupt a tree, because there is no tree to corrupt.
- **Graceful degradation over completeness.** Every statement transform is
  wrapped so one unconvertible line can never kill a whole-suite run.
- **Honest classification.** Unconverted commands are split into *LLM-convertible*
  (a real Playwright path exists) and *manual* (app infrastructure — `cy.task`,
  `cy.loginByXstate`, `cy.visualSnapshot` — that has no UI equivalent).

---

## Known limitations (non-goals)

These are real and stated on purpose. Knowing the edges of a tool matters more
than an inflated success rate.

- **Control-flow reconstruction is not attempted by the deterministic layer.**
  Cypress's command-queue-with-closures model and Playwright's linear-`await`
  model are structurally different. A `cy.wait('@x')` that must be *armed before*
  the action that triggers it, or logic inside a `.then()` closure, cannot be
  rebuilt statement-by-statement. This is the LLM layer's real job (see roadmap).
- **Custom command *bodies* are not resolved.** `getBySel`/`getBySelLike` are
  mapped by convention; arbitrary project commands (`cy.login`, `cy.createTransaction`)
  are flagged for review, not guessed.
- **Visual regression** (`cy.visualSnapshot`) is flagged, not converted — it needs
  a separate Playwright `toHaveScreenshot` strategy.
- **`Cypress.*` globals** (e.g. `Cypress.env`) are not yet detected — a known gap.
- **The verify loop can reach green by weakening a test.** It usually doesn't, but
  a passing test that no longer asserts what it should is worse than a red one.
  **Human review of the diff is required**, by design. This is an assistant, not
  an autopilot.

---

## Roadmap

- **v2 — whole-test LLM mode.** Replace snippet-by-snippet filling with sending the
  entire migrated spec + original to the model, so it can repair *control flow*
  and interleaving, not just isolated commands. This directly attacks the ceiling
  above; before/after coverage numbers to follow.
- Custom-command resolution by reading `cypress/support/commands.ts`.
- A review-gate report that surfaces assertion changes made by the verify loop.