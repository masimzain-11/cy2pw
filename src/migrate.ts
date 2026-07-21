/**
 * cy2pw — deterministic Cypress -> Playwright codemod.
 *
 * WHAT THIS DOES (the "deterministic layer"):
 *   It parses a Cypress spec into an AST (Abstract Syntax Tree) with ts-morph,
 *   walks the tree, and rewrites the patterns it KNOWS about. Anything it does
 *   not recognise is left in place with a // TODO(migrate) marker — that marker
 *   is the exact seam where the LLM layer will plug in later.
 *
 * WHY AST AND NOT REGEX:
 *   Cypress code is chained: cy.get('#x').type('a').should('be.visible').
 *   A regex cannot understand that structure. An AST gives us the real shape
 *   (a call, on a call, on a call) so we can unwind it precisely.
 */
import { Project, SyntaxKind, Node, CallExpression, ArrowFunction } from "ts-morph";
import { mkdirSync, writeFileSync } from "fs";
import { basename, join } from "path";

// ---- config: which chainers are ACTIONS vs how they map to Playwright ----
const ACTIONS: Record<string, string> = {
  click: "click",
  type: "fill",        // Cypress .type() -> Playwright .fill() (fill clears+sets)
  clear: "clear",
  check: "check",
  uncheck: "uncheck",
  select: "selectOption",
  focus: "focus",
  blur: "blur",
  dblclick: "dblclick",
  scrollIntoView: "scrollIntoViewIfNeeded",
};

// Convert a Cypress selector arg into the best Playwright locator.
// [data-test="x"] -> getByTestId('x')  (requires testIdAttribute: 'data-test')
function locatorFromSelector(selArg: string): string {
  const inner = selArg.replace(/^['"`]|['"`]$/g, "");
  const m = inner.match(/^\[data-test=["']([^"']+)["']\]$/);
  if (m) return `page.getByTestId('${m[1]}')`;
  return `page.locator(${selArg})`;
}

// Map a Cypress .should(...) into a Playwright expect() line.
function shouldToExpect(base: string, args: string[]): string {
  let chainer = args[0]?.replace(/^['"`]|['"`]$/g, "") ?? "";
  const val = args[1];
  let neg = "";
  if (chainer.startsWith("not.")) { neg = ".not"; chainer = chainer.slice(4); }

  const map: Record<string, string> = {
    "be.visible": `toBeVisible()`,
    "be.hidden": `toBeHidden()`,
    "exist": `toBeAttached()`,
    "be.checked": `toBeChecked()`,
    "be.disabled": `toBeDisabled()`,
    "be.enabled": `toBeEnabled()`,
    "have.text": `toHaveText(${val})`,
    "contain": `toContainText(${val})`,
    "contain.text": `toContainText(${val})`,
    "have.value": `toHaveValue(${val})`,
    "have.class": `toHaveClass(${val})`,
    "have.attr": `toHaveAttribute(${val})`,
  };
  const matcher = map[chainer];
  if (!matcher) {
    return `// TODO(migrate): unmapped .should(${args.join(", ")}) on ${base}`;
  }
  return `await expect(${base})${neg}.${matcher};`;
}

// Unwind a cy.a().b().c() chain into ordered segments [{name, args}, ...].
function getChain(outer: CallExpression): { name: string; args: string[] }[] {
  const segs: { name: string; args: string[] }[] = [];
  let current: Node = outer;
  while (Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    segs.push({
      name: callee.getName(),
      args: current.getArguments().map((a) => a.getText()),
    });
    current = callee.getExpression();
  }
  return segs.reverse(); // now root-first: cy.get(...) comes before .type(...)
}

// Convert one cy.* statement into one-or-more Playwright lines.
function convertCyChain(outer: CallExpression, indent: string): string {
  const segs = getChain(outer);
  if (segs.length === 0) return outer.getText();
  const root = segs[0];

  // cy.visit(url) -> await page.goto(url)
  if (root.name === "visit") return `await page.goto(${root.args[0]});`;

  // cy.wait(1000)      -> delete (Playwright auto-waits).
  // cy.wait('@alias')  -> NOT a dumb wait; it waits for a network call, so it
  //                       must become page.waitForResponse(...). Hand to Layer 2.
  if (root.name === "wait") {
    const arg = root.args[0] ?? "";
    if (/^\d+$/.test(arg.trim())) {
      return `// TODO(migrate): removed cy.wait(${arg}) — Playwright auto-waits; assert on a state change instead`;
    }
    return `// TODO(migrate): could not auto-convert -> ${outer.getText()}`;
  }

  // Establish the base locator/expression.
  let base = "";
  let isUrl = false;
  if (root.name === "get") base = locatorFromSelector(root.args[0]);
  else if (root.name === "contains") base = `page.getByText(${root.args[0]})`;
  // Custom commands common in real suites. getBySel('x') wraps get('[data-test=x]');
  // getBySelLike('x') is a PARTIAL data-test match -> getByTestId with a regex.
  else if (root.name === "getBySel") base = `page.getByTestId(${root.args[0]})`;
  else if (root.name === "getBySelLike") base = `page.getByTestId(new RegExp(${root.args[0]}))`;
  else if (root.name === "url" || root.name === "location") { base = "page"; isUrl = true; }
  else return `// TODO(migrate): could not auto-convert -> ${outer.getText()}`;

  const actionOps: { name: string; args: string[] }[] = [];
  const shouldOps: string[][] = [];
  for (const seg of segs.slice(1)) {
    // .and() is a chained assertion — an alias for a follow-up .should().
    if (seg.name === "should" || seg.name === "and") shouldOps.push(seg.args);
    else if (ACTIONS[seg.name]) actionOps.push(seg);
    else return `// TODO(migrate): could not auto-convert -> ${outer.getText()}`;
  }

  const lines: string[] = [];

  // cy.url().should('include', '/account') -> expect(page).toHaveURL(/account/)
  if (isUrl) {
    for (const sArgs of shouldOps) {
      const chainer = sArgs[0]?.replace(/^['"`]|['"`]$/g, "");
      if (chainer === "include") lines.push(`await expect(page).toHaveURL(new RegExp(${sArgs[1]}));`);
      else lines.push(`// TODO(migrate): unmapped url assertion .should(${sArgs.join(", ")})`);
    }
  } else {
    if (actionOps.length) {
      const chain = actionOps.map((o) => `.${ACTIONS[o.name]}(${o.args.join(", ")})`).join("");
      lines.push(`await ${base}${chain};`);
    }
    for (const sArgs of shouldOps) lines.push(shouldToExpect(base, sArgs));
  }

  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

// ---- main ----
//
// ROBUST DESIGN: use ts-morph ONLY to ANALYSE (find nodes + their positions),
// then MUTATE by splicing the original source string. Never manipulate the
// ts-morph tree in place — that is what crashed on real multi-line statements.
// String splicing cannot corrupt a tree because there is no tree to corrupt.
const inputPath = process.argv[2];
if (!inputPath) { console.error("usage: tsx src/migrate.ts <file.cy.ts>"); process.exit(1); }

const project = new Project({ useInMemoryFileSystem: false });
const sf = project.addSourceFileAtPath(inputPath);
const src = sf.getFullText();

type Edit = { start: number; end: number; text: string };
const edits: Edit[] = [];
const stats = { converted: 0, needsLlm: 0, crashed: 0 };

// ANALYSE 1: every cy.* expression statement.
sf.getDescendantsOfKind(SyntaxKind.ExpressionStatement).forEach((stmt) => {
  const expr = stmt.getExpression();
  if (!Node.isCallExpression(expr)) return;
  if (!stmt.getText().trimStart().startsWith("cy.")) return;
  try {
    const out = convertCyChain(expr, stmt.getIndentationText());
    edits.push({ start: stmt.getStart(), end: stmt.getEnd(), text: out });
    if (out.includes("could not auto-convert")) stats.needsLlm++; else stats.converted++;
  } catch {
    // A statement we can't transform must NOT kill the run. Leave the original
    // in place and flag it. Graceful degradation over crashing, always.
    stats.crashed++;
    edits.push({ start: stmt.getStart(), end: stmt.getStart(),
      text: `// TODO(migrate): transform failed, left original below\n${stmt.getIndentationText()}` });
  }
});

// ANALYSE 2: describe / it / hooks -> rename + inject async ({ page }).
const RENAME: Record<string, string> = {
  describe: "test.describe", context: "test.describe",
  it: "test", specify: "test",
  beforeEach: "test.beforeEach", afterEach: "test.afterEach",
  before: "test.beforeAll", after: "test.afterAll",
};
const NEEDS_PAGE = new Set(["it", "specify", "beforeEach", "afterEach"]);

sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return;
  const name = callee.getText();
  if (!RENAME[name]) return;
  edits.push({ start: callee.getStart(), end: callee.getEnd(), text: RENAME[name] });

  if (NEEDS_PAGE.has(name)) {
    // Handle BOTH arrow (() => {}) and function-expression (function () {})
    // callbacks — real suites use both. Replace everything from the callback
    // start up to its body's opening brace with `async ({ page }) => `.
    const cb = call.getArguments().find(
      (a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
    if (cb) {
      const body = (cb as ArrowFunction).getBody();
      edits.push({ start: cb.getStart(), end: body.getStart(), text: "async ({ page }) => " });
    }
  }
});

// APPLY: splice edits into the original string, right-to-left so positions
// don't shift. Skip any edit that overlaps one already applied.
edits.sort((a, b) => b.start - a.start);
let output = src;
let lastStart = Infinity;
for (const e of edits) {
  if (e.end > lastStart) continue; // overlap guard
  output = output.slice(0, e.start) + e.text + output.slice(e.end);
  lastStart = e.start;
}
output = `import { test, expect } from '@playwright/test';\n` + output;

const outName = basename(inputPath).replace(/\.cy\.(t|j)s$/, ".spec.ts");
mkdirSync("out", { recursive: true });
const outPath = join("out", outName);
writeFileSync(outPath, output);

// ---- classify what did NOT convert, honestly ----
// MANUAL = no mechanical Playwright equivalent (app infrastructure / tooling).
// Everything else unconverted is assumed LLM-convertible: a real Playwright path
// exists, it just needs whole-test understanding the deterministic layer lacks.
const MANUAL_BUILTINS = new Set([
  "task", "exec", "readFile", "writeFile", "fixture",
  "getCookie", "setCookie", "clearCookie", "clearCookies", "clearLocalStorage",
  "visualSnapshot",
]);
const isManual = (cy: string): boolean => {
  const name = cy.match(/cy\.(\w+)/)?.[1] ?? "";
  if (MANUAL_BUILTINS.has(name)) return true;
  if (/xstate/i.test(name)) return true;                       // loginByXstate, switchUserByXstate
  if (/^(login|logout|register|seed|switchUser|createTransaction|createBankAccount)/i.test(name)) return true;
  if (/Cypress\./.test(cy)) return true;                       // Cypress.* globals
  return false;
};

const unconverted = [...output.matchAll(/could not auto-convert -> (.+)/g)].map((m) => m[1]);
let llm = 0, manual = 0;
for (const cy of unconverted) (isManual(cy) ? manual++ : llm++);

const report = {
  file: outName, auto: stats.converted, llm, manual, failed: stats.crashed,
  total: stats.converted + llm + manual + stats.crashed,
};
writeFileSync(outPath.replace(/\.spec\.ts$/, ".stats.json"), JSON.stringify(report, null, 2));

const pct = report.total ? Math.round((report.auto / report.total) * 100) : 0;
console.log(`\u2713 wrote ${outPath}`);
console.log(`  ${report.total} cy statements | auto ${report.auto} (${pct}%) | LLM ${report.llm} | manual ${report.manual} | failed ${report.failed}`);
