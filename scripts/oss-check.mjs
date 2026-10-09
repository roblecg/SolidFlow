import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const allowed = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "MPL-2.0"
]);

const forbidden = /\b(AGPL|GPL|LGPL|SSPL|EUPL|BUSL|Commons-Clause|UNLICENSED|Proprietary)\b/i;

const listed = spawnSync("pnpm", ["licenses", "list"], {
  encoding: "utf8",
  shell: true,
  cwd: root
});
if (listed.status !== 0) {
  console.error(listed.stderr || listed.stdout);
  process.exit(listed.status ?? 1);
}

const rows = [];
for (const line of listed.stdout.split(/\r?\n/)) {
  const match = /^\│\s+(.+?)\s+│\s+(.+?)\s+│$/.exec(line) ?? /^\|\s+(.+?)\s+\|\s+(.+?)\s+\|$/.exec(line);
  if (!match) continue;
  const name = match[1].trim();
  const license = match[2].trim();
  if (name === "Package" || name.startsWith("─") || name.startsWith("-")) continue;
  rows.push({ name, license });
}

if (!rows.length) {
  console.error("No licenses were reported. Refusing to treat that as a pass.");
  process.exit(1);
}

const failures = [];
for (const row of rows) {
  if (forbidden.test(row.license) || !licenseAllowed(row.license)) {
    failures.push(`${row.name}: ${row.license}`);
  }
}

const nuget = readWebViewLicense();
if (nuget && (forbidden.test(nuget.license) || !licenseAllowed(nuget.license))) {
  failures.push(`Microsoft.Web.WebView2: ${nuget.license}`);
}

if (failures.length) {
  console.error("OSS check failed. These packages are not on the free/open-source allow list:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`OSS check passed for ${rows.length} npm packages.`);
const mpl = rows.filter(row => row.license.includes("MPL-2.0"));
if (mpl.length) {
  console.log("MPL-2.0 (file-level, dev-only, not shipped in SolidFlow.exe):");
  for (const row of mpl) console.log(`  ${row.name}`);
}
if (nuget) console.log(`Microsoft.Web.WebView2 ${nuget.version}: ${nuget.license}`);
else console.log("Microsoft.Web.WebView2 has not been restored yet. Run dotnet build desktop/SolidFlow.csproj, then pnpm oss again.");

function licenseAllowed(license) {
  const orBranches = license.split(/\s+OR\s+/i);
  return orBranches.some(branch =>
    branch
      .split(/\s+AND\s+/i)
      .every(part => allowed.has(part.replace(/[()]/g, "").trim()))
  );
}

function readWebViewLicense() {
  const assets = join(root, "desktop", "obj", "project.assets.json");
  if (!existsSync(assets)) return null;
  const json = JSON.parse(readFileSync(assets, "utf8"));
  const folders = Object.keys(json.packageFolders ?? {});
  const folder = folders[0];
  if (!folder) return null;
  const packageDir = join(folder, "microsoft.web.webview2");
  if (!existsSync(packageDir)) return null;
  const versions = readdirSync(packageDir).sort();
  const version = versions.at(-1);
  if (!version) return null;
  const nuspec = join(packageDir, version, "microsoft.web.webview2.nuspec");
  if (!existsSync(nuspec)) return null;
  const xml = readFileSync(nuspec, "utf8");
  const declared = /<license[^>]*>([^<]+)<\/license>/i.exec(xml)?.[1]?.trim();
  if (!declared) return null;
  if (declared !== "LICENSE.txt") return { version, license: declared };
  const licenseFile = join(packageDir, version, "LICENSE.txt");
  if (!existsSync(licenseFile)) return { version, license: declared };
  const text = readFileSync(licenseFile, "utf8");
  const bsd =
    text.includes("Redistribution and use in source and binary forms") &&
    text.includes("AS IS") &&
    !/\b(AGPL|GPL|LGPL)\b/.test(text);
  return { version, license: bsd ? "BSD-3-Clause" : declared };
}
