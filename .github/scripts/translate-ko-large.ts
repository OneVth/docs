#!/usr/bin/env bun
/**
 * Translate large EN MDX files to KO by splitting into sections.
 * Designed for files that exceed qwen-mt-turbo's single-call token limit.
 *
 * Split strategies:
 *   'update' — split on <Update ...> blocks  (changelog/index.mdx)
 *   'h2'     — split on ## H2 headers        (tutorials/partner-nodes/pricing.mdx)
 *
 * Output: tmp/raw-ko/<relPath>  (same as translate-ko.ts)
 * After this script, run postprocess-ko.ts on the output file.
 *
 * Usage:
 *   npx tsx .github/scripts/translate-ko-large.ts --dry-run changelog/index.mdx
 *   npx tsx .github/scripts/translate-ko-large.ts changelog/index.mdx
 *   npx tsx .github/scripts/translate-ko-large.ts tutorials/partner-nodes/pricing.mdx
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const _scriptDir: string =
  (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
const ROOT = join(_scriptDir, "../..");
const RAW_DIR = join(ROOT, "tmp/raw-ko");

// ---------------------------------------------------------------------------
// Env loading
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
      const val = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}

let BASE_URL = "";
let API_KEY = "";
let MODEL = "";
let IS_QWEN_MT = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceHash(en: string): string {
  return createHash("sha256").update(en).digest("hex").slice(0, 8);
}

function getExistingHash(content: string): string | null {
  const match = content.match(/translationSourceHash:\s*"?([a-f0-9]{8})"?/);
  return match?.[1] ?? null;
}

function setTranslationMeta(content: string, hash: string, enPath: string): string {
  const metaLines = [`translationSourceHash: ${hash}`, `translationFrom: ${enPath}`];
  const metaBlock = metaLines.join("\n");

  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    return `---\n${metaBlock}\n---\n${content}`;
  }
  const [, open, body, close] = fmMatch;
  const rest = content.slice(fmMatch[0].length);
  const cleaned = body
    .replace(/\ntranslationSourceHash:.*/, "")
    .replace(/\ntranslationFrom:.*/, "")
    .replace(/^translationSourceHash:.*\n?/, "")
    .replace(/^translationFrom:.*\n?/, "");
  return `${open}${cleaned}\n${metaBlock}${close}${rest}`;
}

async function readFileOr(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// API calls (with 429 exponential backoff retry)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callApi(
  messages: { role: string; content: string }[],
  maxRetries = 5
): Promise<string> {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 8192,
    ...(IS_QWEN_MT
      ? { translation_options: { source_lang: "English", target_lang: "Korean" } }
      : {}),
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body,
    });

    if (response.status === 429) {
      if (attempt === maxRetries) {
        const err = await response.text();
        throw new Error(`API 429 (rate limit, exhausted ${maxRetries} retries): ${err}`);
      }
      // Respect Retry-After if present, otherwise exponential backoff with jitter
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * 2 ** attempt + Math.random() * 500, 60_000);
      process.stderr.write(
        `\n  [429] rate-limited, retry ${attempt + 1}/${maxRetries} in ${Math.round(waitMs / 1000)}s...\n`
      );
      await sleep(waitMs);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API ${response.status}: ${err}`);
    }

    const data = (await response.json()) as any;
    return data.choices?.[0]?.message?.content ?? "";
  }

  throw new Error("callApi: unreachable");
}

function buildPrompt(chunkText: string): { role: string; content: string }[] {
  const content = [
    "=== English Source ===",
    chunkText,
    "",
    "=== Instructions ===",
    "Translate the English source to Korean.",
    "Preserve all MDX/JSX syntax, component tags, code blocks, URLs, and frontmatter structure exactly.",
    "Do NOT translate: component names (e.g. <Card>, <Update>, <Step>, <Tab>), attribute names, import statements, code identifiers, URLs, href values.",
    "DO translate: title, description, sidebarTitle in frontmatter; all prose text; alt text; list items; table text.",
  ].join("\n");

  if (IS_QWEN_MT) {
    return [{ role: "user", content }];
  }

  const system = `You are an expert translator specializing in Korean technical documentation for ComfyUI (a node-based AI image generation tool).
Output ONLY the translated Korean MDX content. Preserve ALL MDX/JSX syntax. Do not add code fences around your output.`;
  return [
    { role: "system", content: system },
    { role: "user", content },
  ];
}

// ---------------------------------------------------------------------------
// Per-chunk leak stripping
// ---------------------------------------------------------------------------

function stripChunkLeaks(text: string): string {
  let lines = text.split("\n");

  // Strip front leak: first line matching === ... ===
  if (lines.length > 0 && /^=== .+ ===$/.test(lines[0])) {
    lines = lines.slice(1);
    // Also strip any leading blank lines after the marker
    while (lines.length > 0 && lines[0].trim() === "") lines = lines.slice(1);
  }

  // Strip back leak: last === ... === block outside code fences
  let inFence = false;
  let lastMarkerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i]) || /^~~~/.test(lines[i])) inFence = !inFence;
    if (!inFence && /^=== .+ ===$/.test(lines[i])) {
      const after = lines.slice(i + 1);
      const hasMdxStructure = after.some(
        (al) => al === "---" || /^<[A-Z]/.test(al) || /^\|.+\|/.test(al)
      );
      if (!hasMdxStructure) lastMarkerIdx = i;
    }
  }
  if (lastMarkerIdx !== -1) {
    let end = lastMarkerIdx;
    while (end > 0 && lines[end - 1].trim() === "") end--;
    lines = lines.slice(0, end);
  }

  return lines.join("\n");
}

// Add /ko/ prefix to internal hrefs
function fixHrefs(text: string): string {
  return text.replace(
    /href="\/(?!ko\/|ja\/|zh\/|logo\/|images\/|snippets\/)([^"]*?)"/g,
    'href="/ko/$1"'
  );
}

// Strip code fence wrapper that some models add around the entire output
function stripCodeFenceWrapper(text: string): string {
  return text.replace(/^```(?:mdx|markdown)?\n/, "").replace(/\n```$/, "");
}

// Strip thinking tags
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
}

async function translateChunk(
  chunkText: string,
  label: string
): Promise<string> {
  const raw = await callApi(buildPrompt(chunkText));
  let output = raw;
  output = stripThinkTags(output);
  output = stripCodeFenceWrapper(output);
  output = stripChunkLeaks(output);
  output = fixHrefs(output);
  output = output.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return output;
}

// ---------------------------------------------------------------------------
// Split strategies
// ---------------------------------------------------------------------------

type SplitStrategy = "update" | "h2";

function detectStrategy(content: string): SplitStrategy {
  if (/^<Update /m.test(content)) return "update";
  if (/^## /m.test(content)) return "h2";
  throw new Error("Cannot detect split strategy: no <Update> blocks or ## headers found");
}

interface Chunk {
  label: string;
  text: string;
}

function splitByUpdate(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentLabel = "frontmatter";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^<Update /.test(line)) {
      if (currentLines.length > 0) {
        chunks.push({ label: currentLabel, text: currentLines.join("\n") });
      }
      const labelMatch = line.match(/label="([^"]+)"/);
      currentLabel = labelMatch ? `Update:${labelMatch[1]}` : "Update";
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    chunks.push({ label: currentLabel, text: currentLines.join("\n") });
  }

  return chunks;
}

function splitByH2(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentLabel = "preamble";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^## /.test(line)) {
      if (currentLines.length > 0) {
        chunks.push({ label: currentLabel, text: currentLines.join("\n") });
      }
      currentLabel = `H2:${line.slice(3).trim()}`;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    chunks.push({ label: currentLabel, text: currentLines.join("\n") });
  }

  return chunks;
}

function splitContent(content: string, strategy: SplitStrategy): Chunk[] {
  return strategy === "update" ? splitByUpdate(content) : splitByH2(content);
}

// ---------------------------------------------------------------------------
// Translate a large file
// ---------------------------------------------------------------------------

async function translateLargeFile(
  relPath: string,
  dryRun: boolean,
  force: boolean
): Promise<void> {
  const enPath = join(ROOT, relPath);
  const rawPath = join(RAW_DIR, relPath);

  const enContent = await readFileOr(enPath);
  if (!enContent) {
    console.error(`  SKIP: ${relPath} — source file not found`);
    return;
  }

  const hash = sourceHash(enContent);

  if (!force) {
    const existing = await readFileOr(rawPath);
    if (existing && getExistingHash(existing) === hash) {
      console.log(`  UP-TO-DATE: ${relPath}`);
      return;
    }
  }

  const strategy = detectStrategy(enContent);
  const chunks = splitContent(enContent, strategy);

  console.log(
    `  ${relPath}: strategy=${strategy}, ${chunks.length} chunks (${Math.round(enContent.length / 1024)}KB)`
  );
  for (const c of chunks) {
    const lines = c.text.split("\n").length;
    console.log(`    [${c.label}] ${lines} lines`);
  }

  if (dryRun) {
    console.log("  DRY-RUN: no API calls made");
    return;
  }

  const CONCURRENCY = 3;
  const translatedChunks: (string | null)[] = new Array(chunks.length).fill(null);
  const failedChunks: { idx: number; label: string; err: string }[] = [];
  let completed = 0;

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (chunk, j) => {
        const idx = i + j;
        const result = await translateChunk(chunk.text, chunk.label);
        return { idx, result };
      })
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const idx = i + j;
      if (s.status === "fulfilled") {
        translatedChunks[idx] = s.value.result;
        completed++;
        process.stdout.write(`\r  Progress: ${completed}/${chunks.length} OK, ${failedChunks.length} failed`);
      } else {
        failedChunks.push({ idx, label: chunks[idx].label, err: String(s.reason) });
        process.stderr.write(`\n  FAIL chunk ${idx} [${chunks[idx].label}]: ${s.reason}\n`);
      }
    }
  }
  console.log(""); // newline after progress

  if (failedChunks.length > 0) {
    console.error(`\n  ⚠ ${failedChunks.length} chunk(s) failed — aborting reassembly:`);
    for (const f of failedChunks) {
      console.error(`    [${f.idx}] ${f.label}: ${f.err}`);
    }
    console.error("  Fix: re-run with --force to retry all chunks.");
    return;
  }

  // Reassemble — all chunks confirmed non-null at this point
  const assembled = (translatedChunks as string[])
    .map((c, i) => {
      if (i < translatedChunks.length - 1) return c.trimEnd();
      return c;
    })
    .join("\n\n");

  // Inject translation metadata
  const withMeta = setTranslationMeta(assembled, hash, relPath);

  // Write to tmp/raw-ko/
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, withMeta, "utf-8");

  console.log(`  Written: ${rawPath}`);
  console.log(`  Next: npx tsx .github/scripts/postprocess-ko.ts ${relPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await loadEnvLocal();

  BASE_URL =
    process.env.TRANSLATE_CJK_BASE_URL ??
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  API_KEY =
    process.env.TRANSLATE_CJK_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "";
  MODEL = process.env.TRANSLATE_CJK_MODEL ?? "qwen-mt-turbo";
  IS_QWEN_MT = MODEL.startsWith("qwen-mt");

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  if (fileArgs.length === 0) {
    console.error("Usage: translate-ko-large.ts [--dry-run] [--force] <relPath> [...]");
    console.error("Example: translate-ko-large.ts changelog/index.mdx tutorials/partner-nodes/pricing.mdx");
    process.exit(1);
  }

  if (!dryRun && !API_KEY) {
    console.error("No API key. Set TRANSLATE_CJK_API_KEY or DASHSCOPE_API_KEY in .env.local");
    process.exit(1);
  }

  console.log(
    `translate-ko-large: model=${MODEL} ${dryRun ? "[DRY-RUN]" : "[TRANSLATE]"}`
  );

  for (const relPath of fileArgs) {
    const normalized = relPath.replace(/\\/g, "/").replace(/^ko\//, "");
    await translateLargeFile(normalized, dryRun, force);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
