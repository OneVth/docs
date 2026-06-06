#!/usr/bin/env bun
/**
 * Fix Korean translation contamination in ko/ + snippets/ko/ files.
 *
 * Steps:
 *   1. frontmatter mode values  (와이드→wide, "프레임"→"frame")
 *   2. frontmatter icon values  (read en original, copy verbatim)
 *   3. frontmatter openapi HTTP method  (삭제→delete, 1 file)
 *   4. component tag names  (참고→Note, 경고→Warning, 팁→Tip, 정보→Info, 단계→Step, 탭→Tab)
 *
 * Usage:
 *   npx tsx .github/scripts/fix-ko-contamination.ts --dry-run          # preview all steps
 *   npx tsx .github/scripts/fix-ko-contamination.ts --dry-run --step 1 # preview step 1 only
 *   npx tsx .github/scripts/fix-ko-contamination.ts --step 1           # apply step 1 only
 *   npx tsx .github/scripts/fix-ko-contamination.ts                    # apply all steps
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const _dir: string =
  (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
const ROOT = join(_dir, "../..");
const KO_DIR = join(ROOT, "ko");
const SNIPPETS_KO_DIR = join(ROOT, "snippets/ko");

// ---------------------------------------------------------------------------
// File collection
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

// Resolve en original path from ko file path
function toEnPath(koPath: string): string {
  const rel = relative(ROOT, koPath).replace(/\\/g, "/");
  if (rel.startsWith("snippets/ko/")) {
    return join(ROOT, "snippets", rel.slice("snippets/ko/".length));
  }
  // ko/X → X
  return join(ROOT, rel.slice("ko/".length));
}

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

// Returns the index of the closing "---" line (> 0), or -1.
function findFmClose(lines: string[]): number {
  if (lines[0] !== "---") return -1;
  return lines.findIndex((l, i) => i > 0 && l === "---");
}

// Apply a replacement function only to the frontmatter key-value lines
// (lines[1..closeIdx-1], not the --- delimiters themselves).
function replaceFmLines(
  lines: string[],
  replacer: (fmLines: string[]) => string[]
): string[] {
  const closeIdx = findFmClose(lines);
  if (closeIdx === -1) return lines;
  const fmInner = lines.slice(1, closeIdx);
  const newFmInner = replacer(fmInner);
  if (newFmInner === fmInner) return lines;
  return [...lines.slice(0, 1), ...newFmInner, ...lines.slice(closeIdx)];
}

// ---------------------------------------------------------------------------
// STEP 1 — mode values in frontmatter
// ---------------------------------------------------------------------------

interface Step1Change {
  from: string;
  to: string;
}

function fixModeValues(lines: string[]): { lines: string[]; change: Step1Change | null } {
  const closeIdx = findFmClose(lines);
  if (closeIdx === -1) return { lines, change: null };

  let change: Step1Change | null = null;

  const newLines = lines.map((line, i) => {
    if (i === 0 || i >= closeIdx) return line;
    // mode: 와이드  →  mode: wide
    if (/^mode:\s*와이드\s*$/.test(line)) {
      change = { from: line.trim(), to: "mode: wide" };
      return line.replace(/와이드/, "wide");
    }
    // mode: "프레임"  →  mode: "frame"
    if (/^mode:\s*"프레임"\s*$/.test(line)) {
      change = { from: line.trim(), to: 'mode: "frame"' };
      return line.replace(/"프레임"/, '"frame"');
    }
    return line;
  });

  if (!change) return { lines, change: null };
  return { lines: newLines, change };
}

// ---------------------------------------------------------------------------
// STEP 2 — icon values in frontmatter (read from en original)
// ---------------------------------------------------------------------------

interface Step2Change {
  from: string;
  to: string;
}

interface Step2Flag {
  reason: string;
  fromLine: string;
}

async function fixIconValue(
  koPath: string,
  lines: string[]
): Promise<{ lines: string[]; change: Step2Change | null; flag: Step2Flag | null }> {
  const closeIdx = findFmClose(lines);
  if (closeIdx === -1) return { lines, change: null, flag: null };

  // Find a Korean icon line
  const iconIdx = lines.findIndex(
    (l, i) => i > 0 && i < closeIdx && /^icon:.*[가-힣]/.test(l)
  );
  if (iconIdx === -1) return { lines, change: null, flag: null };

  const fromLine = lines[iconIdx].trim();

  const enPath = toEnPath(koPath);
  const enContent = await readFileOr(enPath);
  if (!enContent) {
    return { lines, change: null, flag: { reason: "en original not found", fromLine } };
  }

  const enLines = enContent.split("\n");
  const enClose = findFmClose(enLines);
  if (enClose === -1) {
    return { lines, change: null, flag: { reason: "en original has no frontmatter", fromLine } };
  }

  const enIconLine = enLines.find(
    (l, i) => i > 0 && i < enClose && /^icon:/.test(l)
  );
  if (!enIconLine) {
    return { lines, change: null, flag: { reason: "en original has no icon: line", fromLine } };
  }

  const newLines = [...lines];
  newLines[iconIdx] = enIconLine;

  return {
    lines: newLines,
    change: { from: fromLine, to: enIconLine.trim() },
    flag: null,
  };
}

// ---------------------------------------------------------------------------
// STEP 3 — openapi HTTP method in frontmatter (1 specific file)
// ---------------------------------------------------------------------------

const STEP3_TARGET_REL =
  "registry/api-reference/versions/unpublish-delete-a-specific-version-of-a-node.mdx";

interface Step3Change {
  from: string;
  to: string;
}

async function fixOpenapiMethod(
  koPath: string,
  lines: string[]
): Promise<{ lines: string[]; change: Step3Change | null }> {
  const relToKo = relative(KO_DIR, koPath).replace(/\\/g, "/");
  if (relToKo !== STEP3_TARGET_REL) return { lines, change: null };

  const closeIdx = findFmClose(lines);
  if (closeIdx === -1) return { lines, change: null };

  const openapiIdx = lines.findIndex(
    (l, i) => i > 0 && i < closeIdx && /^openapi:.*[가-힣]/.test(l)
  );
  if (openapiIdx === -1) return { lines, change: null };

  const enPath = toEnPath(koPath);
  const enContent = await readFileOr(enPath);
  if (!enContent) return { lines, change: null };

  const enLines = enContent.split("\n");
  const enClose = findFmClose(enLines);
  if (enClose === -1) return { lines, change: null };

  const enOpenapiLine = enLines.find(
    (l, i) => i > 0 && i < enClose && /^openapi:/.test(l)
  );
  if (!enOpenapiLine) return { lines, change: null };

  const fromLine = lines[openapiIdx].trim();
  const newLines = [...lines];
  newLines[openapiIdx] = enOpenapiLine;

  return { lines: newLines, change: { from: fromLine, to: enOpenapiLine.trim() } };
}

// ---------------------------------------------------------------------------
// STEP 4 — component tag names
// ---------------------------------------------------------------------------

interface TagRule {
  koTag: string;
  enTag: string;
  attrRenames?: [string, string][];
}

const TAG_RULES: TagRule[] = [
  { koTag: "참고", enTag: "Note" },
  { koTag: "노트", enTag: "Note" },
  { koTag: "경고", enTag: "Warning" },
  { koTag: "팁", enTag: "Tip" },
  { koTag: "정보", enTag: "Info" },
  { koTag: "단계", enTag: "Step", attrRenames: [["제목", "title"]] },
  { koTag: "탭", enTag: "Tab", attrRenames: [["제목", "title"]] },
  { koTag: "업데이트", enTag: "Update", attrRenames: [["라벨", "label"], ["설명", "description"]] },
];

// Blacklisted Korean "tags" that must NOT be touched (prose, not components)
const TAG_BLACKLIST = new Set([
  "커밋", "작업", "설치", "파일", "태그", "키", "퍼블리셔",
  "쉼표로", "매개변수", "맞춤형", "귀하의", "요구사항",
]);

interface Step4Result {
  changes: { rule: string; count: number }[];
  tabKoreanAttrs: string[];
}

function fixComponentTags(content: string): { content: string; result: Step4Result } {
  let result = content;
  const changes: { rule: string; count: number }[] = [];
  const tabKoreanAttrs: string[] = [];

  for (const rule of TAG_RULES) {
    if (TAG_BLACKLIST.has(rule.koTag)) continue;
    let ruleCount = 0;

    // Opening tags: <koTag> or <koTag attrs...> or <koTag/>
    result = result.replace(
      new RegExp(`<${rule.koTag}([^>]*)>`, "g"),
      (_match, attrs: string) => {
        ruleCount++;
        let fixedAttrs = attrs;
        if (rule.attrRenames) {
          for (const [koAttr, enAttr] of rule.attrRenames) {
            // No \b — Korean chars are not \w, so word boundary doesn't work
            fixedAttrs = fixedAttrs.replace(
              new RegExp(`${koAttr}=`, "g"),
              `${enAttr}=`
            );
          }
        }
        // Flag Tab tags whose attribute NAMES are still Korean after rename
        if (rule.koTag === "탭" && /[가-힣]+=/.test(fixedAttrs)) {
          tabKoreanAttrs.push(`  <Tab${fixedAttrs}> (Korean attr name still present)`);
        }
        return `<${rule.enTag}${fixedAttrs}>`;
      }
    );

    // Closing tags: </koTag>
    result = result.replace(
      new RegExp(`</${rule.koTag}>`, "g"),
      () => {
        ruleCount++;
        return `</${rule.enTag}>`;
      }
    );

    if (ruleCount > 0) {
      changes.push({ rule: `${rule.koTag}→${rule.enTag}`, count: ruleCount });
    }
  }

  return { content: result, result: { changes, tabKoreanAttrs } };
}

// Collect <모델> occurrences with surrounding context for manual inspection
interface ModelOccurrence {
  line: number;
  context: string;
}

function collectModelOccurrences(content: string): ModelOccurrence[] {
  const occurrences: ModelOccurrence[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/<모델[ >/]/.test(lines[i])) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      const ctx = lines
        .slice(start, end)
        .map((l, j) => {
          const lineNum = start + j + 1;
          const arrow = start + j === i ? "→" : " ";
          return `    ${arrow} ${lineNum}: ${l}`;
        })
        .join("\n");
      occurrences.push({ line: i + 1, context: ctx });
    }
  }
  return occurrences;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  // Parse --step N or --step=N
  let stepFilter: number | null = null;
  const stepIdx = args.indexOf("--step");
  if (stepIdx !== -1 && args[stepIdx + 1]) {
    stepFilter = parseInt(args[stepIdx + 1], 10);
  } else {
    const stepEq = args.find((a) => a.startsWith("--step="));
    if (stepEq) stepFilter = parseInt(stepEq.slice(7), 10);
  }

  const runStep = (n: number) => !stepFilter || stepFilter === n;

  console.log(
    `fix-ko-contamination: ${dryRun ? "DRY-RUN — no files written" : "APPLY — writing changes"}`
  );
  if (stepFilter) console.log(`  Step filter: ${stepFilter}`);

  // Collect files
  const koFiles = await collectFiles(KO_DIR);
  const snippetFiles = await collectFiles(SNIPPETS_KO_DIR);
  const allFiles = [...koFiles, ...snippetFiles];
  console.log(
    `  Scanning ${allFiles.length} files (ko: ${koFiles.length}, snippets/ko: ${snippetFiles.length})\n`
  );

  // Tracking
  let totalChanged = 0;
  const step1Changes: { file: string; from: string; to: string }[] = [];
  const step2Changes: { file: string; from: string; to: string }[] = [];
  const step2Flags: { file: string; reason: string; fromLine: string }[] = [];
  const step3Changes: { file: string; from: string; to: string }[] = [];
  const step4Changes: { file: string; changes: string[] }[] = [];
  const step4TabFlags: { file: string; attrs: string[] }[] = [];
  const modelReport: { file: string; occurrences: ModelOccurrence[] }[] = [];

  for (const filePath of allFiles) {
    const original = await readFileOr(filePath);
    if (!original) continue;

    const relPath = relative(ROOT, filePath).replace(/\\/g, "/");
    let lines = original.split("\n");
    let fileChanged = false;

    // ── STEP 1: mode values ──
    if (runStep(1)) {
      const { lines: l1, change } = fixModeValues(lines);
      if (change) {
        lines = l1;
        fileChanged = true;
        step1Changes.push({ file: relPath, from: change.from, to: change.to });
      }
    }

    // ── STEP 2: icon values ──
    if (runStep(2)) {
      const { lines: l2, change, flag } = await fixIconValue(filePath, lines);
      if (change) {
        lines = l2;
        fileChanged = true;
        step2Changes.push({ file: relPath, from: change.from, to: change.to });
      }
      if (flag) {
        step2Flags.push({ file: relPath, reason: flag.reason, fromLine: flag.fromLine });
      }
    }

    // ── STEP 3: openapi method ──
    if (runStep(3)) {
      const { lines: l3, change } = await fixOpenapiMethod(filePath, lines);
      if (change) {
        lines = l3;
        fileChanged = true;
        step3Changes.push({ file: relPath, from: change.from, to: change.to });
      }
    }

    // ── STEP 4: component tags (+ <모델> investigation) ──
    if (runStep(4)) {
      const content = lines.join("\n");

      // Investigate <모델> before replacement
      const mo = collectModelOccurrences(content);
      if (mo.length > 0) modelReport.push({ file: relPath, occurrences: mo });

      const { content: fixed, result } = fixComponentTags(content);
      if (result.changes.length > 0) {
        lines = fixed.split("\n");
        fileChanged = true;
        step4Changes.push({
          file: relPath,
          changes: result.changes.map((c) => `${c.rule}×${c.count}`),
        });
      }
      if (result.tabKoreanAttrs.length > 0) {
        step4TabFlags.push({ file: relPath, attrs: result.tabKoreanAttrs });
      }
    }

    // ── Write ──
    if (fileChanged) {
      totalChanged++;
      if (!dryRun) {
        try {
          await writeFile(filePath, lines.join("\n"), "utf-8");
        } catch (err) {
          console.error(`  ERROR writing ${relPath}: ${err}`);
        }
      }
    }
  }

  // ── Summary Report ──
  console.log("=".repeat(64));
  console.log(
    `${dryRun ? "Would change" : "Changed"}: ${totalChanged} files total\n`
  );

  if (runStep(1)) {
    console.log(`STEP 1 — mode values: ${step1Changes.length} files`);
    for (const c of step1Changes) {
      console.log(`  ${c.file}`);
      console.log(`    ${c.from}  →  ${c.to}`);
    }
    if (step1Changes.length === 0) console.log("  (none)");
    console.log();
  }

  if (runStep(2)) {
    console.log(`STEP 2 — icon values: ${step2Changes.length} files changed`);
    for (const c of step2Changes) {
      console.log(`  ${c.file}`);
      console.log(`    ${c.from}  →  ${c.to}`);
    }
    if (step2Changes.length === 0) console.log("  (none)");
    if (step2Flags.length > 0) {
      console.log(`\n  ⚠ STEP 2 flags (${step2Flags.length} — not changed):`);
      for (const f of step2Flags) {
        console.log(`  ${f.file}: ${f.reason} (${f.fromLine})`);
      }
    }
    console.log();
  }

  if (runStep(3)) {
    console.log(`STEP 3 — openapi method: ${step3Changes.length} files changed`);
    for (const c of step3Changes) {
      console.log(`  ${c.file}`);
      console.log(`    ${c.from}  →  ${c.to}`);
    }
    if (step3Changes.length === 0) console.log("  (none)");
    console.log();
  }

  if (runStep(4)) {
    console.log(`STEP 4 — component tags: ${step4Changes.length} files changed`);
    for (const c of step4Changes) {
      console.log(`  ${c.file}: ${c.changes.join(", ")}`);
    }
    if (step4Changes.length === 0) console.log("  (none)");
    if (step4TabFlags.length > 0) {
      console.log(`\n  ⚠ STEP 4 Tab attr flags (${step4TabFlags.length} — tag renamed, attrs need check):`);
      for (const f of step4TabFlags) {
        console.log(`  ${f.file}:`);
        for (const a of f.attrs) console.log(a);
      }
    }
    if (modelReport.length > 0) {
      const total = modelReport.reduce((s, m) => s + m.occurrences.length, 0);
      console.log(
        `\n  🔍 <모델> 태그 조사 (화이트리스트 제외, ${total}회 등장 — 컴포넌트인지 산문인지 확인 필요):`
      );
      for (const { file, occurrences } of modelReport) {
        console.log(`\n  파일: ${file}`);
        for (const { line, context } of occurrences) {
          console.log(`  (line ${line}):`);
          console.log(context);
        }
      }
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
