#!/usr/bin/env node
/**
 * Extract a version section from CHANGELOG.md for GitHub Release notes.
 *
 * Usage:
 *   node scripts/extract-changelog.mjs            # Unreleased, else latest version
 *   node scripts/extract-changelog.mjs 0.1.2
 *   node scripts/extract-changelog.mjs v0.1.2
 *
 * Prints markdown to stdout. Exit 1 if no usable section is found.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(root, "CHANGELOG.md");

function normalizeVersion(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/^v/i, "");
}

function extractSection(md, version) {
  const lines = md.split(/\r?\n/);
  // Headings: ## [0.1.2] - 2026-08-04  or  ## [Unreleased]
  const headingRe = /^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?\s*$/;

  let start = -1;
  let targetLabel = version ? normalizeVersion(version) : null;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    const label = m[1].trim();
    const isUnreleased = /^unreleased$/i.test(label);
    const ver = isUnreleased ? "Unreleased" : normalizeVersion(label);

    if (targetLabel) {
      if (
        ver === targetLabel ||
        (targetLabel.toLowerCase() === "unreleased" && isUnreleased)
      ) {
        start = i;
        break;
      }
    } else if (isUnreleased) {
      // Prefer Unreleased only if it has real bullets
      const peek = peekSectionBody(lines, i);
      if (hasContent(peek)) {
        start = i;
        targetLabel = "Unreleased";
        break;
      }
    } else {
      // First version section
      start = i;
      targetLabel = ver;
      break;
    }
  }

  if (start < 0 && version) {
    // Retry: first version section as fallback message is not OK — fail
    return null;
  }
  if (start < 0) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(headingRe);
      if (m && !/^unreleased$/i.test(m[1])) {
        start = i;
        targetLabel = normalizeVersion(m[1]);
        break;
      }
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // Next version heading
    if (/^##\s+\[/.test(lines[i])) {
      end = i;
      break;
    }
    // Keep-a-Changelog footer link refs: [0.1.0]: https://...
    if (/^\[[^\]]+\]:\s*https?:\/\//.test(lines[i])) {
      end = i;
      break;
    }
  }

  const bodyLines = lines.slice(start + 1, end);
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) {
    bodyLines.pop();
  }

  const body = bodyLines.join("\n").trim();
  if (!hasContent(body)) return null;

  const heading = lines[start].replace(/^##\s+/, "").trim();
  const title =
    targetLabel && targetLabel !== "Unreleased"
      ? `## Release v${targetLabel}`
      : `## ${heading.replace(/^\[|\]$/g, "")}`;

  const footer = [
    "",
    "---",
    "",
    "Full history: see [`CHANGELOG.md`](https://github.com/mqjinwon/zotero-paper-ai/blob/main/CHANGELOG.md) in the repository.",
  ].join("\n");

  return `${title}\n\n${body}${footer}\n`;
}

function peekSectionBody(lines, headingIndex) {
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(headingIndex + 1, end).join("\n");
}

function hasContent(text) {
  if (!text || !text.trim()) return false;
  // Ignore HTML comments and empty headings only
  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^###\s+.+$/gm, "")
    .trim();
  return /[-*+]|\d+\./.test(stripped) || stripped.length > 40;
}

function main() {
  const versionArg = process.argv[2] || process.env.RELEASE_VERSION || "";
  let md;
  try {
    md = readFileSync(changelogPath, "utf8");
  } catch (e) {
    console.error(`Cannot read ${changelogPath}: ${e.message}`);
    process.exit(1);
  }

  const notes = extractSection(md, versionArg || null);
  if (!notes) {
    console.error(
      versionArg
        ? `No changelog section found for version ${versionArg}`
        : "No changelog section with content found",
    );
    process.exit(1);
  }
  process.stdout.write(notes);
}

main();
