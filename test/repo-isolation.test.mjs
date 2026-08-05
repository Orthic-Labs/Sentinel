// Plan 6.4: test-hygiene guard.
//
// Prevents the regression that codex-profile.test.mjs was: a Sentinel test
// reading another repo's prose. This guard reads every sentinel/test/*.mjs
// and fails on any path literal escaping the repo (../../, /Volumes/, or an
// absolute workspace path). No allowlist today — if one becomes necessary it
// carries an inline comment naming the evidence for it.

import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTINEL_ROOT = resolve(HERE, "..");

// Patterns that indicate a path escaping the sentinel repo into the
// workspace or filesystem — exactly the failure mode codex-profile.test.mjs had.
// The ../../ pattern is the strongest signal (going up two levels from test/).
// /Volumes/ and absolute paths only matter when combined with file I/O calls.
const ESCAPE_PATTERNS = [
  /\.\.\/\.\.\//,                                        // ../../ (two levels up from test/)
  /(?:readFileSync|require|import)\s*\(?\s*['"]\/Volumes\//, // I/O call with absolute macOS path
  /(?:readFileSync|require|import)\s*\(?\s*['"]\/Users\//,   // I/O call with absolute home path
  /(?:readFileSync|require|import)\s*\(?\s*['"]\/(home|tmp)\//, // I/O call with Linux absolute
];

test("no Sentinel test file contains path literals that escape the repo", () => {
  const testFiles = readdirSync(HERE).filter(
    (f) => f.endsWith(".test.mjs") && f !== "repo-isolation.test.mjs",
  );
  assert.ok(testFiles.length > 0, "must find at least one test file to scan");

  for (const file of testFiles) {
    const content = readFileSync(join(HERE, file), "utf8");
    for (const pattern of ESCAPE_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        assert.fail(
          `${file}: contains path escape pattern ${pattern} (${match[0]}) — ` +
            "Sentinel tests must read only their own repo; external prose becomes frozen local fixtures",
        );
      }
    }
  }
});
