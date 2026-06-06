#!/usr/bin/env bun
/**
 * EN → KO translation script for ComfyUI docs.
 *
 * Single-source (EN only). Raw output goes to tmp/raw-ko/ for post-processing.
 * Incremental: stores a source hash in each translated file's frontmatter.
 * On re-run, skips files whose EN source hasn't changed.
 *
 * Usage:
 *   npx tsx .github/scripts/translate-ko.ts              # translate all pending
 *   npx tsx .github/scripts/translate-ko.ts --dry-run    # show what would run
 *   npx tsx .github/scripts/translate-ko.ts --force       # re-translate everything
 *   npx tsx .github/scripts/translate-ko.ts --snippets    # snippets only
 *   npx tsx .github/scripts/translate-ko.ts foo.mdx bar.mdx  # specific files only
 *
 * Environment (.env.local):
 *   TRANSLATE_CJK_API_KEY     - API key (DashScope, etc.)
 *   TRANSLATE_CJK_BASE_URL    - OpenAI-compatible base URL (workspace MaaS host required)
 *   TRANSLATE_CJK_MODEL       - Model ID (default: qwen-mt-turbo)
 *   TRANSLATE_CJK_CONCURRENCY - Parallel requests (default: 3)
 *   DASHSCOPE_API_KEY         - Fallback API key for Qwen-MT
 */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Resolve project root (works with bun and node/tsx)
// ---------------------------------------------------------------------------

const _scriptDir: string =
  (import.meta as any).dir ??
  dirname(fileURLToPath(import.meta.url));
const ROOT = join(_scriptDir, "../..");
const RAW_DIR = join(ROOT, "tmp/raw-ko");

// ---------------------------------------------------------------------------
// Load .env.local
// ---------------------------------------------------------------------------

async function loadEnvLocal(): Promise<void> {
  try {
    const content = await readFile(join(ROOT, ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const raw = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes if present
      const val = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Config (populated in main() after loadEnvLocal)
// ---------------------------------------------------------------------------

let BASE_URL = "";
let API_KEY = "";
let MODEL = "";
let CONCURRENCY = 3;
let IS_QWEN_MT = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hash of EN source, truncated to 8 hex chars */
function sourceHash(en: string): string {
  return createHash("sha256").update(en).digest("hex").slice(0, 8);
}

/** Extract translationSourceHash from an MDX file's frontmatter */
function getExistingHash(content: string): string | null {
  const match = content.match(/translationSourceHash:\s*"?([a-f0-9]{8})"?/);
  return match?.[1] ?? null;
}

/** Inject or update translation metadata in frontmatter */
function setTranslationMeta(
  content: string,
  hash: string,
  enPath: string
): string {
  const metaLines = [
    `translationSourceHash: ${hash}`,
    `translationFrom: ${enPath}`,
  ];
  const metaBlock = metaLines.join("\n");

  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    return `---\n${metaBlock}\n---\n${content}`;
  }
  const [, open, body, close] = fmMatch;
  const rest = content.slice(fmMatch[0].length);

  // Remove old translation meta lines if present
  const cleaned = body
    .replace(/\ntranslationSourceHash:.*/, "")
    .replace(/\ntranslationFrom:.*/, "")
    .replace(/^translationSourceHash:.*\n?/, "")
    .replace(/^translationFrom:.*\n?/, "");

  return `${open}${cleaned}\n${metaBlock}${close}${rest}`;
}

/** Read file, return empty string on missing */
async function readFileOr(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return fallback;
  }
}

/** Collect all .mdx files under a directory recursively */
async function collectMdx(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectMdx(full)));
    } else if (entry.name.endsWith(".mdx")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Translation API calls
// ---------------------------------------------------------------------------

async function callApi(
  messages: { role: string; content: string }[],
  extraBody: Record<string, any> = {}
): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 8192,
      ...extraBody,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API ${response.status}: ${err}`);
  }
  const data = (await response.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

async function translateWithQwenMT(enText: string): Promise<string> {
  const content = [
    "=== English Source ===",
    enText,
    "",
    "=== Instructions ===",
    "Translate the English source to Korean.",
    "Preserve all MDX/JSX syntax, component tags, code blocks, URLs, and frontmatter structure exactly.",
    "Do NOT translate: component names (e.g. <Card>, <CardGroup>), import statements, code identifiers, URLs, href values.",
    "DO translate: title, description, sidebarTitle in frontmatter; all prose text; alt text; Card title/children text.",
  ].join("\n");

  return await callApi(
    [{ role: "user", content }],
    { translation_options: { source_lang: "English", target_lang: "Korean" } }
  );
}

async function translateWithLLM(
  enText: string,
  relPath: string
): Promise<string> {
  const systemPrompt = `You are an expert translator specializing in Korean technical documentation for software (ComfyUI - a node-based AI image generation tool).

Your task: Translate the provided English documentation to natural, professional Korean.

Rules:
- Output ONLY the translated Korean MDX content
- Preserve ALL MDX/JSX syntax exactly: component tags (<Card>, <CardGroup>, <Tabs>, etc.), import statements, code blocks, URLs, href attributes, frontmatter YAML structure
- DO translate: title/description/sidebarTitle in frontmatter, all prose, Card title and children text, table content, list items
- Do NOT translate: component names, import paths, code identifiers, parameter names in backticks, URLs, anchor IDs
- Use standard Korean technical writing conventions
- NEVER use HTML comments (<!-- -->) in your output`;

  const userPrompt = `File: ${relPath}

=== English Source ===
${enText}

Translate the English source to Korean. Output only the translated MDX.`;

  return await callApi([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);
}

// ---------------------------------------------------------------------------
// Translate a single file
// ---------------------------------------------------------------------------

interface PathMapping {
  enPath: string;
  koRawPath: string;
  enRel: string;
}

function defaultMapping(relPath: string): PathMapping {
  return {
    enPath: join(ROOT, relPath),
    koRawPath: join(RAW_DIR, relPath),
    enRel: relPath,
  };
}

function snippetMapping(relPath: string): PathMapping {
  // relPath is relative inside snippets/, e.g. "install/foo.mdx"
  return {
    enPath: join(ROOT, "snippets", relPath),
    koRawPath: join(RAW_DIR, "snippets", relPath),
    enRel: `snippets/${relPath}`,
  };
}

async function translateFile(
  relPath: string,
  force: boolean,
  mapping: (r: string) => PathMapping = defaultMapping
): Promise<{ status: "translated" | "skipped" | "up-to-date" }> {
  const { enPath, koRawPath, enRel } = mapping(relPath);

  // Read EN source
  const enContent = await readFileOr(enPath);
  if (!enContent) {
    return { status: "skipped" };
  }

  // Skip tiny files (likely just frontmatter redirects)
  if (enContent.length < 50) {
    await mkdir(dirname(koRawPath), { recursive: true });
    await writeFile(koRawPath, enContent);
    return { status: "skipped" };
  }

  // Check if already translated with same source hash
  const hash = sourceHash(enContent);
  if (!force) {
    const existingKo = await readFileOr(koRawPath);
    if (existingKo && getExistingHash(existingKo) === hash) {
      return { status: "up-to-date" };
    }
  }

  // Translate
  const translated = IS_QWEN_MT
    ? await translateWithQwenMT(enContent)
    : await translateWithLLM(enContent, relPath);

  // Clean up LLM artifacts
  let output = translated;
  // Remove thinking tags
  output = output.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  // Remove code fence wrappers
  output = output.replace(/^```(?:mdx|markdown)?\n/, "").replace(/\n```$/, "");

  // Post-process: add /ko/ prefix to internal href links
  output = output.replace(
    /href="\/(?!ko\/|ja\/|zh\/|logo\/|images\/|snippets\/)([^"]*?)"/g,
    'href="/ko/$1"'
  );

  // Normalize line endings (API may return CRLF on Windows)
  output = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Strip front leak (=== ... === on first line) so setTranslationMeta can find frontmatter
  const firstLine = output.split("\n")[0];
  if (/^=== .+ ===$/.test(firstLine)) {
    output = output.slice(firstLine.length + 1);
  }

  // Inject translation metadata into frontmatter (skip for snippets — inline fragments)
  const isSnippet = enRel.startsWith("snippets/");
  if (!isSnippet) {
    output = setTranslationMeta(output, hash, enRel);
  }

  // Write raw output (pre-postprocessing)
  await mkdir(dirname(koRawPath), { recursive: true });
  await writeFile(koRawPath, output);

  return { status: "translated" };
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Load env first so config picks up .env.local values
  await loadEnvLocal();

  BASE_URL =
    process.env.TRANSLATE_CJK_BASE_URL ??
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  API_KEY =
    process.env.TRANSLATE_CJK_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "";
  MODEL = process.env.TRANSLATE_CJK_MODEL ?? "qwen-mt-turbo";
  CONCURRENCY = Number(process.env.TRANSLATE_CJK_CONCURRENCY ?? "3");
  IS_QWEN_MT = MODEL.startsWith("qwen-mt");

  if (!API_KEY) {
    console.error(
      "No API key. Set TRANSLATE_CJK_API_KEY or DASHSCOPE_API_KEY in .env.local"
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const snippetsMode = args.includes("--snippets");
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  const mapFn = snippetsMode ? snippetMapping : defaultMapping;
  console.log(
    `Config: model=${MODEL} concurrency=${CONCURRENCY} mode=${IS_QWEN_MT ? "qwen-mt" : "llm"}${snippetsMode ? " [snippets]" : ""}`
  );
  console.log(`Raw output dir: ${RAW_DIR}`);

  // Collect files
  let files: string[];
  if (fileArgs.length > 0) {
    files = fileArgs.map((f) =>
      f.replace(/\\/g, "/").replace(/^(ko\/|ja\/|zh\/|snippets\/(ko|ja|zh)\/)/, "")
    );
  } else if (snippetsMode) {
    const all = await collectMdx(join(ROOT, "snippets"));
    files = all
      .map((f) => relative(join(ROOT, "snippets"), f).replace(/\\/g, "/"))
      .filter(
        (f) =>
          !f.startsWith("zh/") && !f.startsWith("ja/") && !f.startsWith("ko/")
      );
  } else {
    const all = await collectMdx(ROOT);
    files = all
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .filter(
        (f) =>
          !f.startsWith("zh/") &&
          !f.startsWith("ja/") &&
          !f.startsWith("ko/") &&
          !f.startsWith("snippets/") &&
          !f.startsWith("node_modules/") &&
          !f.startsWith(".github/") &&
          !f.startsWith("tmp/")
      );
  }

  // Pre-scan: check which files need translation
  if (!force && !dryRun) {
    console.log(`Scanning ${files.length} files for changes...`);
  }

  const pending: string[] = [];
  const upToDate: string[] = [];

  for (const relPath of files) {
    if (force) {
      pending.push(relPath);
      continue;
    }
    const paths = mapFn(relPath);
    const enContent = await readFileOr(paths.enPath);
    if (!enContent || enContent.length < 50) {
      upToDate.push(relPath);
      continue;
    }
    const hash = sourceHash(enContent);
    const existingKo = await readFileOr(paths.koRawPath);
    if (existingKo && getExistingHash(existingKo) === hash) {
      upToDate.push(relPath);
    } else {
      pending.push(relPath);
    }
  }

  console.log(
    `Files: ${files.length} total, ${upToDate.length} up-to-date, ${pending.length} pending`
  );

  if (dryRun) {
    console.log("\nWould translate:");
    for (const f of pending.slice(0, 30)) console.log(`  ${f}`);
    if (pending.length > 30)
      console.log(`  ... and ${pending.length - 30} more`);
    return;
  }

  if (pending.length === 0) {
    console.log("Everything up-to-date. Use --force to re-translate.");
    return;
  }

  // Translate
  await mkdir(RAW_DIR, { recursive: true });
  let translated = 0;
  let skipped = 0;
  let failed = 0;
  const failedFiles: string[] = [];
  const startTime = Date.now();

  await pool(pending, CONCURRENCY, async (relPath, idx) => {
    const tag = `[${idx + 1}/${pending.length}]`;
    try {
      const result = await translateFile(relPath, force, mapFn);
      if (result.status === "translated") {
        translated++;
        console.log(`${tag} OK   ${relPath}`);
      } else {
        skipped++;
        console.log(`${tag} SKIP ${relPath}`);
      }
    } catch (err: any) {
      failed++;
      failedFiles.push(relPath);
      console.error(`${tag} FAIL ${relPath}: ${err.message}`);
    }
  });

  if (failedFiles.length > 0) {
    console.log(`\nFailed files (${failedFiles.length}):`);
    for (const f of failedFiles) console.log(`  ${f}`);
    console.log(
      "Re-run to retry failed files (hash not stored on failure, so they will be retried)."
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\nDone in ${elapsed}s: ${translated} translated, ${skipped} skipped, ${failed} failed`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
