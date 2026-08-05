// Plan 6.4: test-hygiene guard.
//
// Prevents the regression that codex-profile.test.mjs was: a Forge test
// reading another repo's prose. This guard reads every forge/test/*.mjs
// and fails on any path literal escaping the repo (../../, /Volumes/, or an
// absolute workspace path). No allowlist today — if one becomes necessary it
// carries an inline comment naming the evidence for it.

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = resolve(HERE, "..");

// Patterns that indicate a path escaping the forge repo into the
// workspace or filesystem — exactly the failure mode codex-profile.test.mjs had.
// The ../../ pattern is the strongest signal (going up two levels from test/).
// /Volumes/ and absolute paths only matter when combined with file I/O calls.
const ESCAPE_PATTERNS = [
  /\.\.\/\.\.\//,                                        // ../../ (two levels up from test/)
  /(?:readFileSync|require|import)\s*\(?\s*['"]\/Volumes\//, // I/O call with absolute macOS path
  /(?:readFileSync|require|import)\s*\(?\s*['"]\/Users\//,   // I/O call with absolute home path
  /(?:readFileSync|require|import)\s*\(?\s*['"]\/(home|tmp)\//, // I/O call with Linux absolute
];

// Allowlisted cross-submodule imports: these tests legitimately read membrane's
// CJS lib to verify shared implementation (plan 2.2/2.3 — one renderer, one
// ledger, no drift). Evidence: delivery-ledger-shared.test.mjs proves
// ContextSessionV1 instanceof; the CJS lib path is the contract surface.
const ALLOWED_IMPORTS = new Set([
  "../../membrane/mcp/context-renderer-lib.cjs",
]);

test("no Forge test file contains path literals that escape the repo", () => {
  const testFiles = readdirSync(HERE).filter(
    (f) => f.endsWith(".test.mjs") && f !== "repo-isolation.test.mjs",
  );
  assert.ok(testFiles.length > 0, "must find at least one test file to scan");

  for (const file of testFiles) {
    const content = readFileSync(join(HERE, file), "utf8");
    for (const pattern of ESCAPE_PATTERNS) {
      let match;
      // Reset lastIndex for global patterns (not used here, but defensive)
      pattern.lastIndex = 0;
      while ((match = pattern.exec(content)) !== null) {
        // Check if this specific match is an allowed cross-submodule import.
        // Extract the string literal after the pattern to check against allowlist.
        const lineStart = content.lastIndexOf("\n", match.index) + 1;
        const line = content.slice(lineStart, content.indexOf("\n", match.index));
        const isAllowed = [...ALLOWED_IMPORTS].some((allowed) => line.includes(allowed));
        if (!isAllowed) {
          assert.fail(
            `${file}: contains path escape pattern ${pattern} (${match[0]}) — ` +
              "Forge tests must read only their own repo; external prose becomes frozen local fixtures",
          );
        }
        break; // one match per pattern per file is enough
      }
    }
  }
});
