// One-off validator for Phase 2 formulation output JSON.
// Loads the most recent docs/phase-2-formulation-test-*.json file and
// runs ClaudeOutputSchema.safeParse against it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClaudeOutputSchema } from "../prompts/output-schema";

const docsDir = resolve(__dirname, "..", "docs");

function findLatestFormulationFile(): string {
  const candidates = readdirSync(docsDir)
    .filter((name) => /^phase-2-formulation-test-.*\.json$/.test(name))
    .map((name) => {
      const fullPath = join(docsDir, name);
      return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    console.error("No files matching docs/phase-2-formulation-test-*.json found.");
    process.exit(1);
  }

  return candidates[0].fullPath;
}

function main(): void {
  const filePath = findLatestFormulationFile();
  console.log(`Validating: ${filePath}`);

  const raw = readFileSync(filePath, "utf8");
  if (raw.trim().length === 0) {
    console.error(`File is empty: ${filePath}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    const envelope = JSON.parse(raw);

    // If this is a raw Anthropic API response envelope, extract the text block
    if (envelope && typeof envelope === "object" && "content" in envelope && Array.isArray(envelope.content)) {
      const textBlock = (envelope.content as Array<{ type: string; text?: string }>)
        .find((b) => b.type === "text");
      if (!textBlock?.text) {
        console.error("API response envelope found but no text block present.");
        process.exit(1);
      }
      // Strip markdown code fences if present
      const text = textBlock.text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
      parsed = JSON.parse(text);
    } else {
      parsed = envelope;
    }
  } catch (err) {
    console.error(`Failed to parse JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = ClaudeOutputSchema.safeParse(parsed);

  if (result.success) {
    console.log("VALID against schema v0.2.0");
    process.exit(0);
  }

  console.error("INVALID — Zod errors:");
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    console.error(`  - path: ${path}`);
    console.error(`    reason: ${issue.message}`);
    console.error(`    code: ${issue.code}`);
  }
  process.exit(1);
}

main();
