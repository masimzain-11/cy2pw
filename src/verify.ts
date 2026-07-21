/**
 * verify.ts — cy2pw Layer 3 (the run-verify-repair loop). The heart of the tool.
 *
 * THE LOOP:
 *   1. Run the migrated Playwright spec.
 *   2. Exit code 0? -> green, done.
 *   3. Otherwise, capture the failure output, send it + the current spec to
 *      Claude, get a corrected spec, write it, and go back to step 1.
 *   4. Give up after MAX_ATTEMPTS so a stubborn test can't loop forever.
 *
 * WHY THIS IS THE WHOLE POINT:
 *   Layers 1 and 2 produce code that *looks* right. Only actually running it
 *   against the live app proves it. Static conversion cannot know that
 *   cy.contains() maps to an ambiguous getByText() until the DOM says so.
 *   This loop closes that gap: real failure in, real fix out.
 *
 * DRY RUN (CY2PW_DRY_RUN=1): does ONE pass using a canned failure, prints the
 *   prompt it WOULD send, and does NOT run Playwright, call the API, or modify
 *   your file. Proves the plumbing for free.
 */
import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

const spec = process.argv[2];
if (!spec) { console.error("usage: tsx src/verify.ts <out/file.spec.ts>"); process.exit(1); }
const dryRun = process.env.CY2PW_DRY_RUN === "1";
const MAX_ATTEMPTS = 4;

const SYSTEM = `You repair failing Playwright tests (TypeScript). You are given the FULL current spec file and the test-runner failure output.
Rules:
- Return the ENTIRE corrected spec file. No explanation, no markdown fences, no backticks.
- Change ONLY what the failure requires. Leave passing tests untouched.
- Respect Playwright best practices: prefer getByTestId / getByRole over ambiguous getByText; when a locator is ambiguous (strict-mode violation), pick the specific element named in the error; arm waitForResponse BEFORE the action that triggers it.
- Keep the existing import and structure.`;

// Run the spec once. Returns pass/fail plus the runner output for context.
function runPlaywright(): { passed: boolean; output: string } {
  const res = spawnSync("npx", ["playwright", "test", spec, "--reporter=list"], {
    encoding: "utf8",
    shell: true,
  });
  return { passed: res.status === 0, output: (res.stdout || "") + (res.stderr || "") };
}

async function repair(specText: string, failure: string): Promise<string> {
  if (dryRun) return specText; // don't modify anything in dry run
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `CURRENT SPEC (${spec}):\n\n${specText}\n\n---\n\nFAILURE OUTPUT:\n\n${failure}`,
    }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text).join("")
    .replace(/```[a-z]*\n?|```/g, "").trim();
}

const CANNED_FAILURE = `Error: strict mode violation: getByText('My account') resolved to 2 elements:
  1) <a data-test="nav-my-account">My account</a>
  2) <h1 data-test="page-title">My account</h1>`;

(async () => {
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set. Set it, or use CY2PW_DRY_RUN=1 to test the loop for free.");
    process.exit(1);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n\u2500\u2500 attempt ${attempt}/${MAX_ATTEMPTS} \u2500\u2500`);

    const { passed, output } = dryRun
      ? { passed: false, output: CANNED_FAILURE }
      : runPlaywright();

    if (passed) {
      console.log("\u2705 all tests green — migration verified.");
      return;
    }

    console.log("\u2717 failing. Sending failure + spec to Claude for repair...");
    if (dryRun) {
      console.log("\n[dry-run] would send this failure:\n" + CANNED_FAILURE);
      console.log("\n[dry-run] stopping without calling the API or editing the file.");
      return;
    }

    const specText = readFileSync(spec, "utf8");
    const fixed = await repair(specText, output);
    if (!fixed || fixed === specText) {
      console.log("Claude returned no usable change. Stopping.");
      return;
    }
    writeFileSync(spec, fixed);
    console.log("\u2713 wrote a repaired spec. Re-running to verify...");
  }

  console.log(`\nStill failing after ${MAX_ATTEMPTS} attempts. This one needs a human — the loop isn't magic.`);
})();
