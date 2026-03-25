import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const version = tag.replace(/^v/, "");

if (!tag) {
  throw new Error("Missing tag. Pass a tag like v1.2.3 or set GITHUB_REF_NAME.");
}

if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    version,
  )
) {
  throw new Error(`Invalid semver tag: ${tag}`);
}

const rootDir = resolve(import.meta.dirname, "..");

updateJsonVersion(resolve(rootDir, "package.json"), version);
updateJsonVersion(resolve(rootDir, "src-tauri", "tauri.conf.json"), version);
updateCargoTomlVersion(resolve(rootDir, "src-tauri", "Cargo.toml"), version);

console.log(`Synchronized app version to ${version}`);

function updateJsonVersion(filePath, nextVersion) {
  const content = readFileSync(filePath, "utf8");
  const data = JSON.parse(content);
  data.version = nextVersion;
  const nextContent = formatText(JSON.stringify(data, null, 2), content);

  if (content !== nextContent) {
    writeFileSync(filePath, nextContent, "utf8");
  }
}

function updateCargoTomlVersion(filePath, nextVersion) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  let inPackageSection = false;
  let updated = false;

  const nextLines = lines.map((line) => {
    if (/^\[package\]\s*$/.test(line)) {
      inPackageSection = true;
      return line;
    }

    if (inPackageSection && /^\[.+\]\s*$/.test(line)) {
      inPackageSection = false;
    }

    if (inPackageSection && /^version\s*=\s*"[^"]+"\s*$/.test(line)) {
      updated = true;
      return `version = "${nextVersion}"`;
    }

    return line;
  });

  if (!updated) {
    throw new Error(`Could not find [package] version in ${filePath}`);
  }

  const nextContent = formatText(nextLines.join("\n"), content);

  if (content !== nextContent) {
    writeFileSync(filePath, nextContent, "utf8");
  }
}

function formatText(nextContent, currentContent) {
  const eol = currentContent.includes("\r\n") ? "\r\n" : "\n";
  const normalized = nextContent.replace(/\n/g, eol);

  if (currentContent.endsWith("\r\n") || currentContent.endsWith("\n")) {
    return `${normalized}${eol}`;
  }

  return normalized;
}
