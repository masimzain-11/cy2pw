/**
 * cy2pw.ts — the single entry point. Runs the deterministic migration across a
 * whole suite and prints an honest coverage table.
 *
 *   npx tsx src/cy2pw.ts <dir>        # default: samples
 *
 * The table is the point: it reports not just "how much converted" but the
 * three-way split that reflects reality — mechanically converted, LLM-convertible,
 * and genuine manual-rewrite (app infrastructure no tool should touch).
 *
 * ai-fill and verify stay as separate deliberate steps: the LLM layer costs money
 * and the verify loop needs a running app, so neither should fire automatically.
 */
import { spawnSync } from "child_process";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const dir = process.argv[2] || "samples";
const files = readdirSync(dir).filter((f) => /\.cy\.(t|j)s$/.test(f));
if (files.length === 0) { console.error(`No *.cy.ts files in ${dir}`); process.exit(1); }

type Stat = { file: string; auto: number; llm: number; manual: number; failed: number; total: number };
const rows: Stat[] = [];

for (const f of files) {
  spawnSync("npx", ["tsx", "src/migrate.ts", join(dir, f)], { stdio: "ignore", shell: true });
  const statsPath = join("out", f.replace(/\.cy\.(t|j)s$/, ".stats.json"));
  if (existsSync(statsPath)) rows.push(JSON.parse(readFileSync(statsPath, "utf8")));
}

const sum = (k: keyof Stat) => rows.reduce((n, r) => n + (r[k] as number), 0);
const totals = { auto: sum("auto"), llm: sum("llm"), manual: sum("manual"), failed: sum("failed"), total: sum("total") };
const pct = (n: number) => (totals.total ? Math.round((n / totals.total) * 100) : 0);

const name = (s: string) => s.replace(/\.spec\.ts$/, "").padEnd(26);
const cell = (n: number) => String(n).padStart(5);

console.log("\n" + "\u2500".repeat(64));
console.log(name("SPEC") + cell(0).replace("0", "auto") + cell(0).replace("0", " LLM") + cell(0).replace("0", "manl") + cell(0).replace("0", "fail"));
console.log("\u2500".repeat(64));
for (const r of rows) {
  console.log(name(r.file) + cell(r.auto) + cell(r.llm) + cell(r.manual) + cell(r.failed));
}
console.log("\u2500".repeat(64));
console.log(name("TOTAL (" + rows.length + " specs)") + cell(totals.auto) + cell(totals.llm) + cell(totals.manual) + cell(totals.failed));
console.log("\u2500".repeat(64));
console.log(`\n${totals.total} Cypress statements across ${rows.length} real specs:`);
console.log(`  \u2713 auto-converted (deterministic) : ${totals.auto}  (${pct(totals.auto)}%)`);
console.log(`  \u25c8 LLM-convertible               : ${totals.llm}  (${pct(totals.llm)}%)`);
console.log(`  \u2691 manual rewrite (app infra)     : ${totals.manual}  (${pct(totals.manual)}%)`);
console.log(`  \u2717 crashed                        : ${totals.failed}  (${pct(totals.failed)}%)`);
console.log("");
