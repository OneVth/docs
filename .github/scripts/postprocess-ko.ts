#!/usr/bin/env bun
/**
 * Post-processor for ko translation.
 * Reads raw translated MDX from tmp/raw-ko/, writes clean output to ko/.
 *
 * Steps per file:
 *  1. Strip front leak  — content before first "---" frontmatter line
 *  2. Strip back leak   — last "=== ... ===" marker block (outside code fences)
 *  3. Normalize keys    — Korean frontmatter keys → English equivalents
 *  4. Invariant checks  — (a) starts with ---, (b) title: present, (c) length ≥ 50% of EN
 *     Pass → write to ko/   Fail → flag, leave raw untouched
 *
 * Usage:
 *   npx tsx .github/scripts/postprocess-ko.ts             # process all
 *   npx tsx .github/scripts/postprocess-ko.ts --dry-run   # preview, no writes
 *   npx tsx .github/scripts/postprocess-ko.ts --snippets  # snippets only
 *   npx tsx .github/scripts/postprocess-ko.ts foo.mdx bar.mdx  # specific files
 */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const _dir: string =
  (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
const ROOT = join(_dir, "../..");
const RAW_DIR = join(ROOT, "tmp/raw-ko");
const KO_DIR = join(ROOT, "ko");

// ---------------------------------------------------------------------------
// Frontmatter key normalization map
// ---------------------------------------------------------------------------

const FRONTMATTER_KEY_MAP: Record<string, string> = {
  "제목": "title",
  "설명": "description",
  "사이드바 제목": "sidebarTitle",
  "사이드바제목": "sidebarTitle",
  "아이콘": "icon",
  "모드": "mode",
  "아이콘 유형": "iconType",
  "아이콘유형": "iconType",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readFileOr(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await collectFiles(full)));
      } else if (entry.name.endsWith(".mdx")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

// ---------------------------------------------------------------------------
// Rule 0: Strip meta-only preamble (setTranslationMeta prepend fallback)
//
// When translate-ko.ts can't inject metadata into an existing frontmatter
// (e.g. CRLF line endings cause regex mismatch), it prepends a standalone
// metadata block. Detect and strip it so Rule 1 sees the real frontmatter.
//
// Pattern to detect:
//   ---
//   translationSourceHash: XXXXXXXX
//   translationFrom: some/path.mdx
//   ---
//   ---            ← immediately followed by another frontmatter open
//   (real content)
// ---------------------------------------------------------------------------

function stripMetaPreamble(lines: string[]): { lines: string[]; stripped: boolean } {
  if (lines[0] !== "---") return { lines, stripped: false };
  const closeIdx = lines.findIndex((l, i) => i > 0 && l === "---");
  if (closeIdx === -1) return { lines, stripped: false };

  const fmBody = lines.slice(1, closeIdx);
  const isMeta = fmBody.every(
    (l) =>
      l.trim() === "" ||
      /^translationSourceHash:/.test(l) ||
      /^translationFrom:/.test(l)
  );

  // Only strip if the next line after the closing --- is another ---
  if (isMeta && lines[closeIdx + 1] === "---") {
    return { lines: lines.slice(closeIdx + 1), stripped: true };
  }
  return { lines, stripped: false };
}

// ---------------------------------------------------------------------------
// Rule 1: Strip front leak (content before first frontmatter "---")
// ---------------------------------------------------------------------------

function stripFrontLeak(lines: string[]): { lines: string[]; stripped: boolean } {
  if (lines[0] === "---") {
    return { lines, stripped: false };
  }
  const fmStart = lines.findIndex((l) => l === "---");
  if (fmStart === -1) {
    return { lines, stripped: false }; // will be caught by invariant (a)
  }
  return { lines: lines.slice(fmStart), stripped: true };
}

// ---------------------------------------------------------------------------
// Rule 1b: Fix missing frontmatter closing "---"
//
// Some API outputs open frontmatter (---) but forget to close it.
// Detect this and insert closing --- after the last YAML key line.
// ---------------------------------------------------------------------------

function fixMissingFrontmatterClose(lines: string[]): { lines: string[]; fixed: boolean } {
  if (lines[0] !== "---") return { lines, fixed: false };

  // Already has a closing ---
  if (lines.findIndex((l, i) => i > 0 && l === "---") !== -1) {
    return { lines, fixed: false };
  }

  // Find the last YAML key line before body content begins
  // YAML key pattern: word chars (incl. Korean) followed by ": "
  const YAML_KEY = /^[\w가-힣][^:]*:\s*/;
  let lastKeyIdx = -1;

  for (let i = 1; i < lines.length; i++) {
    if (YAML_KEY.test(lines[i])) {
      lastKeyIdx = i;
    } else if (lines[i].trim() !== "") {
      break; // non-empty, non-key line = body started
    }
  }

  if (lastKeyIdx === -1) return { lines, fixed: false };

  const newLines = [
    ...lines.slice(0, lastKeyIdx + 1),
    "---",
    ...lines.slice(lastKeyIdx + 1),
  ];
  return { lines: newLines, fixed: true };
}

// ---------------------------------------------------------------------------
// Rule 2: Strip back leak (last "=== ... ===" block outside code fences)
// ---------------------------------------------------------------------------

function stripBackLeak(lines: string[]): { lines: string[]; stripped: boolean } {
  let inFence = false;
  let lastSafeIdx: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Track fenced code blocks (``` or ~~~)
    if (/^```/.test(l) || /^~~~/.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^=== .+ ===$/.test(l)) {
      // Safety check: nothing after this marker should look like MDX structure
      const after = lines.slice(i + 1);
      const hasMdxStructure = after.some(
        (al) =>
          al === "---" ||              // frontmatter boundary
          /^<[A-Z]/.test(al) ||        // JSX component open tag
          /^\|.+\|/.test(al)           // table row
      );
      if (!hasMdxStructure) {
        lastSafeIdx = i;
      }
    }
  }

  if (lastSafeIdx !== null) {
    // Trim trailing blank lines before the marker
    let end = lastSafeIdx;
    while (end > 0 && lines[end - 1].trim() === "") end--;
    return { lines: lines.slice(0, end), stripped: true };
  }

  // Fallback: unclosed code block may have kept inFence=true throughout.
  // Scan the last 30 lines for a === marker followed only by prose instructions.
  const tailStart = Math.max(0, lines.length - 30);
  for (let i = tailStart; i < lines.length; i++) {
    if (/^=== .+ ===$/.test(lines[i])) {
      const after = lines.slice(i + 1);
      const hasMdxStructure = after.some(
        (al) => al === "---" || /^<[A-Z]/.test(al) || /^\|.+\|/.test(al)
      );
      if (!hasMdxStructure) {
        let end = i;
        while (end > 0 && lines[end - 1].trim() === "") end--;
        return { lines: lines.slice(0, end), stripped: true };
      }
    }
  }

  return { lines, stripped: false };
}

// ---------------------------------------------------------------------------
// Rule 3: Normalize frontmatter keys (Korean → English)
// ---------------------------------------------------------------------------

function normalizeFrontmatterKeys(lines: string[]): {
  lines: string[];
  normalized: string[];
} {
  // Find frontmatter block: lines[0] === "---", next "---" closes it
  if (lines[0] !== "---") return { lines, normalized: [] };
  const closeIdx = lines.findIndex((l, i) => i > 0 && l === "---");
  if (closeIdx === -1) return { lines, normalized: [] };

  const normalized: string[] = [];
  const newLines = [...lines];

  for (let i = 1; i < closeIdx; i++) {
    const line = newLines[i];
    for (const [koKey, enKey] of Object.entries(FRONTMATTER_KEY_MAP)) {
      // Match "koKey:" at line start (with optional leading whitespace)
      const re = new RegExp(`^(\\s*)${koKey}(\\s*:)`);
      if (re.test(line)) {
        newLines[i] = line.replace(re, `$1${enKey}$2`);
        normalized.push(`  ${koKey}: → ${enKey}:`);
        break;
      }
    }
  }

  return { lines: newLines, normalized };
}

// ---------------------------------------------------------------------------
// Invariant checks (run after all rules, before writing)
// ---------------------------------------------------------------------------

interface InvariantResult {
  pass: boolean;
  violations: string[];
}

function checkInvariants(
  lines: string[],
  enContent: string,
  opts: { isSnippet?: boolean; minLengthRatio?: number } = {}
): InvariantResult {
  const { isSnippet = false, minLengthRatio = 0.5 } = opts;
  const violations: string[] = [];
  const content = lines.join("\n");

  if (!isSnippet) {
    // (a) must start with ---
    if (lines[0] !== "---") {
      violations.push("(a) Does not start with frontmatter '---'");
    }

    // (b) must have title: or openapi: in frontmatter (openapi pages auto-generate title)
    const closeIdx = lines.findIndex((l, i) => i > 0 && l === "---");
    if (closeIdx !== -1) {
      const fmBlock = lines.slice(1, closeIdx).join("\n");
      if (!/^title\s*:/m.test(fmBlock) && !/^openapi\s*:/m.test(fmBlock)) {
        violations.push("(b) No 'title:' or 'openapi:' found in frontmatter");
      }
    } else {
      violations.push("(b) No closing frontmatter '---' found");
    }
  }

  // (c) processed content length >= minLengthRatio * EN source length
  if (enContent.length > 0) {
    const ratio = content.length / enContent.length;
    if (ratio < minLengthRatio) {
      violations.push(
        `(c) Content too short: ${content.length} chars vs EN ${enContent.length} (ratio ${ratio.toFixed(2)} < ${minLengthRatio})`
      );
    }
  }

  return { pass: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Process a single file
// ---------------------------------------------------------------------------

interface FileResult {
  status: "written" | "flagged" | "skipped" | "dry-run";
  normalizedKeys: string[];
  violations: string[];
  frontStripped: boolean;
  backStripped: boolean;
}

async function processFile(
  rawPath: string,
  koPath: string,
  enPath: string,
  dryRun: boolean
): Promise<FileResult> {
  const rawContent = await readFileOr(rawPath);
  if (!rawContent) return { status: "skipped", normalizedKeys: [], violations: [], frontStripped: false, backStripped: false };

  const enContent = await readFileOr(enPath);
  const isSnippet = rawPath.replace(/\\/g, "/").includes("/raw-ko/snippets/");
  let lines = rawContent.split("\n");

  // Rule 0: strip meta-only preamble (setTranslationMeta prepend fallback)
  const { lines: l0 } = stripMetaPreamble(lines);
  lines = l0;

  // Rule 1: front leak
  const { lines: l1, stripped: frontStripped } = stripFrontLeak(lines);
  lines = l1;

  // Rule 1b: fix missing frontmatter close
  const { lines: l1b } = fixMissingFrontmatterClose(lines);
  lines = l1b;

  // Rule 2: back leak
  const { lines: l2, stripped: backStripped } = stripBackLeak(lines);
  lines = l2;

  // Rule 3: frontmatter key normalization (skip for snippets — no frontmatter)
  const { lines: l3, normalized } = isSnippet
    ? { lines, normalized: [] as string[] }
    : normalizeFrontmatterKeys(lines);
  lines = l3;

  // Invariant checks
  const { pass, violations } = checkInvariants(lines, enContent, { isSnippet });

  if (!pass) {
    return { status: "flagged", normalizedKeys: normalized, violations, frontStripped, backStripped };
  }

  if (dryRun) {
    return { status: "dry-run", normalizedKeys: normalized, violations: [], frontStripped, backStripped };
  }

  // Write to ko/
  const output = lines.join("\n");
  await mkdir(dirname(koPath), { recursive: true });
  await writeFile(koPath, output);

  return { status: "written", normalizedKeys: normalized, violations: [], frontStripped, backStripped };
}

// ---------------------------------------------------------------------------
// Resolve output paths from raw path
// ---------------------------------------------------------------------------

function resolvePaths(rawPath: string): { koPath: string; enPath: string } {
  const rel = relative(RAW_DIR, rawPath).replace(/\\/g, "/");

  if (rel.startsWith("snippets/")) {
    // tmp/raw-ko/snippets/foo.mdx → snippets/ko/foo.mdx, EN: snippets/foo.mdx
    const inner = rel.slice("snippets/".length);
    return {
      koPath: join(ROOT, "snippets/ko", inner),
      enPath: join(ROOT, "snippets", inner),
    };
  }

  // tmp/raw-ko/foo.mdx → ko/foo.mdx, EN: foo.mdx
  return {
    koPath: join(KO_DIR, rel),
    enPath: join(ROOT, rel),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const snippetsOnly = args.includes("--snippets");
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  console.log(`postprocess-ko: ${dryRun ? "DRY-RUN — no files written" : "writing to ko/"}`);

  // Collect raw files to process
  let rawFiles: string[];

  if (fileArgs.length > 0) {
    // Specific files given as relative paths (e.g. "foo.mdx" or "snippets/foo.mdx")
    rawFiles = fileArgs.map((f) => {
      const norm = f.replace(/\\/g, "/").replace(/^(ko\/|ja\/|zh\/)/, "");
      return join(RAW_DIR, norm);
    });
  } else if (snippetsOnly) {
    rawFiles = await collectFiles(join(RAW_DIR, "snippets"));
  } else {
    const all = await collectFiles(RAW_DIR);
    rawFiles = all.filter((f) => {
      const rel = relative(RAW_DIR, f).replace(/\\/g, "/");
      return !snippetsOnly || rel.startsWith("snippets/");
    });
    if (snippetsOnly) {
      rawFiles = rawFiles.filter((f) =>
        relative(RAW_DIR, f).replace(/\\/g, "/").startsWith("snippets/")
      );
    }
  }

  if (rawFiles.length === 0) {
    console.log("No raw files found in tmp/raw-ko/. Run translate-ko.ts first.");
    return;
  }

  console.log(`Processing ${rawFiles.length} raw files...`);

  let written = 0;
  let flagged = 0;
  let skipped = 0;
  const flagList: { file: string; violations: string[] }[] = [];
  const keyNormList: { file: string; keys: string[] }[] = [];

  for (const rawPath of rawFiles) {
    const rel = relative(RAW_DIR, rawPath).replace(/\\/g, "/");
    const { koPath, enPath } = resolvePaths(rawPath);

    const result = await processFile(rawPath, koPath, enPath, dryRun);

    switch (result.status) {
      case "written":
        written++;
        if (result.normalizedKeys.length > 0) {
          keyNormList.push({ file: rel, keys: result.normalizedKeys });
          console.log(`  NORM  ${rel} (keys: ${result.normalizedKeys.join(", ")})`);
        } else {
          console.log(`  OK    ${rel}`);
        }
        break;

      case "dry-run":
        written++;
        const notes: string[] = [];
        if (result.frontStripped) notes.push("front-leak stripped");
        if (result.backStripped) notes.push("back-leak stripped");
        if (result.normalizedKeys.length > 0) notes.push(`keys: ${result.normalizedKeys.join(", ")}`);
        console.log(`  DRY   ${rel}${notes.length ? ` (${notes.join("; ")})` : ""}`);
        break;

      case "flagged":
        flagged++;
        flagList.push({ file: rel, violations: result.violations });
        console.log(`  FLAG  ${rel}`);
        for (const v of result.violations) console.log(`        ${v}`);
        break;

      case "skipped":
        skipped++;
        break;
    }
  }

  console.log(
    `\nDone: ${written} ${dryRun ? "would write" : "written"}, ${flagged} flagged, ${skipped} skipped`
  );

  if (keyNormList.length > 0) {
    console.log(`\nFrontmatter keys normalized in ${keyNormList.length} files:`);
    for (const { file, keys } of keyNormList) {
      console.log(`  ${file}: ${keys.join(", ")}`);
    }
  }

  if (flagList.length > 0) {
    console.log(`\n⚠️  Flagged files (raw preserved, not written to ko/):`);
    for (const { file, violations } of flagList) {
      console.log(`  ${file}`);
      for (const v of violations) console.log(`    ${v}`);
    }
    console.log("\nFor flagged files: inspect raw, fix the issue, or re-translate with --force.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
