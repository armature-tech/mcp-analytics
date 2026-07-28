// The version the SDK reports to Armature ingest (batch `sdk.version` and the
// User-Agent header). The placeholder below is only ever seen by builds made
// from a source checkout; `npm run build` rewrites the compiled
// dist/{esm,cjs}/version.js with the real package version (`build:version`),
// so every published release reports its true semver. Keep this file to a
// single const: the stamp step regenerates the whole compiled file.
export const SDK_VERSION: string = "0.0.0-development";
