# cy2pw — Cypress → Playwright migration engine

A three-layer tool that migrates Cypress test suites to Playwright. It converts
what can be converted mechanically, uses an LLM only for what genuinely needs
one, and **explicitly flags what no tool should try to convert** — then verifies
the result against a running app.

Built to answer a real question honestly: *how much of a real-world Cypress
suite can actually be automated away, and what's the irreducible human part?*

---

## Coverage on real suites

Measured on three production specs from
[`cypress-realworld-app`](https://github.com/cypress-io/cypress-realworld-app)
(Cypress's own reference application — code I did not write):

| Layer                              | Statements | Share |
| ---------------------------------- | ---------- | ----- |
| Auto-converted (deterministic)     | 136        | ~56%  |
| LLM-convertible                    | 56         | ~23%  |
| Manual rewrite (app infrastructure)| 52         | ~21%  |
| Crashed                            | 0          | 0%    |

**244 real Cypress statements, zero crashes.** The number that matters isn't the
56% — it's that the tool *classifies* the remaining 44% correctly instead of
pretending it converted them.

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

**3. Run-verify-repair loop (`verify.ts`)** — the point of the whole thing. Runs
the migrated spec against the live app; on failure it feeds the spec + the runner
output back to Claude for a fix, then re-runs, up to a bounded number of attempts.
Static conversion produces code that *looks* right; only running it proves it.

`cy2pw.ts` orchestrates layer 1 across a suite and prints the coverage table.

---

## Usage

```bash
npm install                     # ts-morph, @playwright/test, @anthropic-ai/sdk, tsx
npx playwright install chromium

# whole-suite coverage report (deterministic layer)
npx tsx src/cy2pw.ts samples

# single file, each layer explicitly
npx tsx src/migrate.ts samples/login.cy.ts        # layer 1 -> out/login.spec.ts
export ANTHROPIC_API_KEY=sk-ant-...
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
