/**
 * ai-fill.ts — cy2pw Layer 2 (the LLM layer).
 *
 * WHAT THIS DOES:
 *   Reads a migrated spec produced by migrate.ts, finds every
 *   `// TODO(migrate): could not auto-convert -> <cypress code>` marker,
 *   asks Claude to convert JUST that snippet to Playwright, and splices the
 *   answer back in. The deterministic layer already did the easy 70%; this
 *   only pays for the hard bits it couldn't handle.
 *
 * WHY A SEPARATE SCRIPT:
 *   Keeping the deterministic codemod pure (no network, no cost, fully testable)
 *   and the AI step separate means you can run migrate.ts a thousand times for
 *   free and only reach for the LLM when there's genuinely something unknown.
 *
 * DRY RUN:
 *   Set CY2PW_DRY_RUN=1 to test the plumbing with NO API call and NO cost — it
 *   just shows which snippets WOULD be sent. Use this until you trust it.
 */
import { readFileSync, writeFileSync } from "fs";
import Anthropic from "@anthropic-ai/sdk";

const filePath = process.argv[2];
if (!filePath) { console.error("usage: tsx src/ai-fill.ts <out/file.spec.ts>"); process.exit(1); }
const dryRun = process.env.CY2PW_DRY_RUN === "1";

const SYSTEM = `You convert individual Cypress commands into Playwright (TypeScript).
Rules:
- The Playwright Page is available as \`page\`. Use \`expect\` from @playwright/test for assertions.
- Return ONLY the Playwright code. No explanation, no markdown fences, no backticks.
- Prefer web-first assertions and auto-waiting. Convert cy.intercept -> page.route, cy.wait('@alias') -> page.waitForResponse, cy.request -> page.request.
- If the command spans setup + wait (e.g. intercept then wait on alias), return the single most faithful Playwright equivalent for the line given.
- Keep it to the minimal correct code for the one command provided.`;

const original = readFileSync(filePath, "utf8");
const lines = original.split("\n");
const marker = /^(\s*)\/\/ TODO\(migrate\): could not auto-convert -> (.+)$/;

// Collect the work first so we can report and (optionally) skip the API.
const jobs: { lineIndex: number; indent: string; cy: string }[] = [];
lines.forEach((line, i) => {
  const m = line.match(marker);
  if (m) jobs.push({ lineIndex: i, indent: m[1], cy: m[2] });
});

if (jobs.length === 0) { console.log("No LLM markers to fill. Nothing to do."); process.exit(0); }
console.log(`Found ${jobs.length} snippet(s) needing conversion:`);
jobs.forEach((j) => console.log(`  - ${j.cy}`));

async function convert(cy: string): Promise<string> {
  if (dryRun) return `/* [dry-run] would convert: ${cy} */`;
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const msg = await client.messages.create({
    model: "claude-sonnet-5",   // cheap+capable; swap to claude-haiku-4-5 to save more
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: cy }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```[a-z]*\n?|```/g, "") // strip stray fences if the model adds them
    .trim();
}

(async () => {
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error("\nANTHROPIC_API_KEY is not set. Set it, or run with CY2PW_DRY_RUN=1 to test for free.");
    process.exit(1);
  }
  for (const job of jobs) {
    const pw = await convert(job.cy);
    // Re-indent multi-line answers and leave a breadcrumb of the original.
    const body = pw.split("\n").map((l) => job.indent + l).join("\n");
    lines[job.lineIndex] = `${job.indent}// migrated from: ${job.cy}\n${body}`;
    console.log(`\u2713 ${job.cy}  ->  ${pw.replace(/\n/g, " ")}`);
  }
  writeFileSync(filePath, lines.join("\n"));
  console.log(`\nWrote ${filePath}`);
})();
