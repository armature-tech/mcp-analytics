// Rewrite the compiled dist/{esm,cjs}/version.js with the real package
// version so published builds report their true semver in `sdk.version` and
// the User-Agent header. Runs as part of `npm run build`, which npm invokes
// during publish (prepublishOnly) after the release version has been written
// to package.json — npm_package_version is therefore the released version.
//
// src/version.ts keeps the 0.0.0-development placeholder on purpose: a build
// made straight from a source checkout is a development build and must say so
// rather than impersonate a release.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.npm_package_version
  ?? JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("stamp-version: could not determine the package version");
}

const literal = JSON.stringify(version);
writeFileSync(
  join(packageRoot, "dist/esm/version.js"),
  `export const SDK_VERSION = ${literal};\n`,
);
writeFileSync(
  join(packageRoot, "dist/cjs/version.js"),
  `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.SDK_VERSION = ${literal};\n`,
);
console.log(`stamped SDK_VERSION ${version} into dist/esm and dist/cjs`);
