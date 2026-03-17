import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const sourcePath = path.resolve(
  process.cwd(),
  process.argv[2] || ".github/scripts/sync-recent-activity.mjs",
);
const outputPath = path.resolve(
  process.cwd(),
  process.argv[3] || ".github/scripts/sync-recent-activity.obf.mjs",
);

const source = await readFile(sourcePath, "utf8");
const payload = Buffer.from(source, "utf8").toString("base64");
const wrapper = `import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = Buffer.from("${payload}", "base64").toString("utf8");
const tempDir = await mkdtemp(path.join(os.tmpdir(), "sync-recent-activity-"));
const tempPath = path.join(tempDir, "sync-recent-activity.mjs");

try {
  await writeFile(tempPath, source, { encoding: "utf8", mode: 0o600 });
  await import(pathToFileURL(tempPath).href);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
`;

await writeFile(outputPath, wrapper, "utf8");
console.log(`Obfuscated ${path.relative(process.cwd(), sourcePath)} -> ${path.relative(process.cwd(), outputPath)}`);
