# Known Issues

## Test Suite

### prepareManagedHarness.test.ts - Vitest Import Error

**Status:** Open (pre-existing from Codex commit 22a43bb)  
**Severity:** Low (functionality works, only test execution blocked)  
**Baseline impact:** Test count is 1546 passed (not 1554) because this file's 8 tests never ran

**Symptom:**
```
SyntaxError: Invalid or unexpected token
 ❯ tests/prepareManagedHarness.test.ts:8:1
   import {
   ^
```

**Root cause:** Vitest's ESM transformer fails to parse the import of `probe-managed-capabilities.mjs` from the test file, despite:
- The file having valid syntax (no BOM, no non-ASCII, CRLF line endings)
- Plain Node successfully importing the module (`node --input-type=module` works)
- The imported `.mjs` file exporting the functions correctly
- 143 other test files passing successfully

**Investigation summary:**
1. Attempted static import (original): fails at parse time
2. Attempted single-line import: fails at parse time
3. Attempted dynamic import with `await` at top level: fails at parse time
4. Attempted `beforeAll` dynamic import: fails at parse time
5. Hex dump shows clean ASCII, no hidden characters
6. TypeScript parses the file (with unrelated vite/vitest type errors)
7. The module is ESM (`.mjs`), the test file is `.ts` compiled to ESM

**Hypothesis:** Vitest 3.2.7 + Vite 6.4.3 ESM transformation has an edge case when a `.test.ts` file imports from `../runtime/**/*.mjs` outside the standard source tree. The transformer may be applying incorrect resolution or transformation rules to the `.mjs` import.

**Workaround attempted and rejected:** Excluding the file from vitest.config.ts was flagged by the security classifier as removing test coverage without authorization.

**Recommended fix:** 
1. Move `probe-managed-capabilities.mjs` and related runtime probing to `src/main/services/` as `.ts` files
2. OR add explicit vitest configuration for `.mjs` imports from the `runtime/` directory
3. OR upgrade vitest/vite to newer versions that may handle this case

**Test coverage:** The 8 tests in this file cover the managed DeepSeek Harness security policy (capability probing, npm script sandboxing, preset verification, integrity checking). The underlying functionality works (runtime preparation scripts use these functions successfully), only the vitest execution is blocked.

**Commit history:** File was added in commit 22a43bb as part of v2.0.0 DSH/Cordis integration, already in this broken state.
