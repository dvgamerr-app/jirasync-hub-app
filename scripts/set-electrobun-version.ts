import { readFileSync, writeFileSync } from "node:fs";

const nextVersion = process.argv[2]?.trim();

if (!nextVersion) {
  throw new Error("Usage: bun scripts/set-electrobun-version.ts <version>");
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  throw new Error(`Invalid version "${nextVersion}"`);
}

const configPath = "electrobun.config.ts";
const source = readFileSync(configPath, "utf8");
const updated = source.replace(/version:\s*"[^"]+"/, `version: "${nextVersion}"`);

if (updated === source) {
  throw new Error(`Could not update version in ${configPath}`);
}

writeFileSync(configPath, updated, "utf8");
console.log(`Updated ${configPath} to version ${nextVersion}`);
