# Test Suite Triage

**Date**: 2025-11-21  
**Status**: 663 passing / 34 failing (95% pass rate)  
**Test Files**: 40 passing / 7 failing

---

## ✅ WORKING (663 tests, 40 files)

### High-Value Tests (127 tests)
- ✅ **Unit tests** (116 tests) - Query DSL, UUIDs, Parsing, Signatures
- ✅ **Integration tests** (11 tests) - Query-to-graph pipeline
- ✅ **Smoke tests** (18 tests) - Infrastructure validation

### Legacy Tests (536 tests)
- ✅ **src/** tests (536 tests) - Pre-existing component/service tests
  - ConversionEdge tests
  - Various service tests
  - Component tests

**All working tests can run with**: `npm run test:unit` + integration

---

## ❌ FAILING (34 tests, 7 files)

### Category 1: ESM Import Issues (EASY FIX)
**Problem**: Using CommonJS `require()` for ESM modules

| File | Tests | Error | Fix Effort |
|------|-------|-------|------------|
| `tests/pipeline-integrity/simple-query-flow.test.ts` | 9 | `Cannot find module 'dataOperationsService'` | 🟢 EASY |
| `tests/pipeline-integrity/composite-query-flow.test.ts` | 6 | `Cannot find module 'dataOperationsService'` | 🟢 EASY |
| `tests/validation/input-sanitization.test.ts` | 6 | `Cannot find module 'queryDSL'` | 🟢 EASY |
| `tests/context-propagation/flag-threading.test.ts` | ? | Likely same issue | 🟢 EASY |
| `tests/identity/signature-consistency.test.ts` | ? | Likely same issue | 🟢 EASY |

**Fix**: Replace `require()` with dynamic `import()` or fix mocking approach

```typescript
// BEFORE (broken):
beforeEach(() => {
  dataOperationsService = require('../../src/services/dataOperationsService').dataOperationsService;
});

// AFTER (working):
beforeEach(async () => {
  const module = await import('../../src/services/dataOperationsService');
  dataOperationsService = module.dataOperationsService;
});
```

**Estimated fix time**: 1 hour

---

### Category 2: Missing Methods (MEDIUM FIX)
**Problem**: Tests expect methods that don't exist on UpdateManager

| File | Tests | Error | Fix Effort |
|------|-------|-------|------------|
| `tests/state-sync/multi-source-truth.test.ts` | 8 | `updateManager.updateEdge is not a function` | 🟡 MEDIUM |

**Issue**: Tests call `updateManager.updateEdge()` but UpdateManager doesn't have this method.

**Options**:
1. Remove these tests (they test non-existent functionality)
2. Implement `updateEdge()` method on UpdateManager
3. Rewrite tests to use existing methods

**Estimated fix time**: 2-4 hours (depending on approach)

---

### Category 3: Bad Test Logic (EASY FIX)
**Problem**: Test has incorrect assertions

| File | Tests | Error | Fix Effort |
|------|-------|-------|------------|
| `tests/validation/input-sanitization.test.ts` | 1 | XSS test expects wrong behavior | 🟢 EASY |

**Issue**: Test expects sanitized output not to contain "onerror" but it does (escaped)
```typescript
// Test expects: '<img src=x>'
// Actually got: '&lt;img src=x onerror=alert(1)&gt;'
// This is CORRECT behavior (escaped), test is wrong
```

**Fix**: Update test assertion

**Estimated fix time**: 5 minutes

---

### Category 4: Mock Hoisting Issues (MEDIUM FIX)
**Problem**: Vitest mock hoisting with variables

| File | Tests | Error | Fix Effort |
|------|-------|-------|------------|
| `tests/state-sync/multi-source-truth.test.ts` | 1 | `mockFileRegistry is not defined` | 🟡 MEDIUM |

**Issue**: Mock factory uses variable defined outside, but Vitest hoists mocks

**Fix**: Use `vi.doMock()` instead of `vi.mock()` or move variable inside factory

**Estimated fix time**: 30 minutes

---

### Category 5: Pre-existing Failure (IGNORE FOR NOW)
**Problem**: Unrelated to our test suite work

| File | Tests | Error | Fix Effort |
|------|-------|-------|------------|
| `src/services/__tests__/conflictResolutionService.test.ts` | 1 | `default is not a function` | ⚪ N/A |

**Note**: This is a pre-existing test failure, not related to our new test suite

---

## 📊 Triage Summary

| Category | Tests | Effort | Priority |
|----------|-------|--------|----------|
| ESM imports | ~21 | 🟢 1h | 🔴 HIGH |
| Missing methods | 8 | 🟡 2-4h | 🟡 MEDIUM |
| Bad assertions | 1 | 🟢 5m | 🟢 LOW |
| Mock hoisting | 1 | 🟡 30m | 🟡 MEDIUM |
| Pre-existing | 1 | ⚪ N/A | ⚫ IGNORE |
| **TOTAL** | **34** | **4-6h** | |

---

## 🎯 Recommended Action Plan

### Option A: Quick Fix (1-2 hours)
1. ✅ Fix ESM imports in 5 test files (~1h)
2. ✅ Fix bad assertion (~5m)
3. ⏭️ Skip/comment out tests with missing methods
4. **Result**: ~30 tests passing, 8 skipped

### Option B: Comprehensive Fix (4-6 hours)
1. ✅ Fix ESM imports (~1h)
2. ✅ Fix bad assertion (~5m)
3. ✅ Fix mock hoisting (~30m)
4. ✅ Implement `updateEdge()` or rewrite tests (~2-4h)
5. **Result**: All 34 tests passing

### Option C: Pragmatic Approach (30 minutes)
1. ✅ Move broken tests to `tests/TODO/` directory
2. ✅ Update test scripts to exclude `tests/TODO/`
3. ✅ Keep working tests (663) passing
4. ⏭️ Fix broken tests incrementally when needed
5. **Result**: 663 tests passing immediately, clean build

---

## 🚀 Immediate Solution for release.sh

### Current State:
```bash
npm test -- --run  # Runs ALL tests, 34 fail
```

### Fix Options:

**Option 1: Run only working tests**
```bash
# In release.sh, change to:
npm run test:unit && npm run test:integration
# Result: 127 tests pass ✅
```

**Option 2: Exclude broken test directories**
```bash
# Add to package.json:
"test:release": "vitest run --exclude '**/pipeline-integrity/**' --exclude '**/state-sync/**' ..."
# Result: 663 tests pass ✅
```

**Option 3: Fix the 34 broken tests**
```bash
# Estimated: 4-6 hours work
# Result: 697 tests pass ✅
```

---

## 💡 Recommendation

**For immediate release (`./release.sh --runtests`):**
- Use Option 1: Run `test:unit` + `test:integration` (127 tests)
- These are our new, high-value tests
- 100% pass rate guaranteed

**For comprehensive testing:**
- Spend 1-2 hours on "Quick Fix" approach
- Gets us to ~690 passing tests
- Can fix remaining 8 tests later if needed

**My vote**: Option 1 for immediate release, then spend 1-2 hours on Quick Fix when you have time.

---

## 📋 Detailed Fix Checklist

### 🟢 Easy Fixes (1-2 hours)
- [ ] Fix ESM imports in `simple-query-flow.test.ts`
- [ ] Fix ESM imports in `composite-query-flow.test.ts`
- [ ] Fix ESM imports in `input-sanitization.test.ts`
- [ ] Fix ESM imports in `flag-threading.test.ts`
- [ ] Fix ESM imports in `signature-consistency.test.ts`
- [ ] Fix XSS assertion in `input-sanitization.test.ts`

### 🟡 Medium Fixes (2-4 hours)
- [ ] Fix mock hoisting in `multi-source-truth.test.ts`
- [ ] Implement `updateEdge()` method OR
- [ ] Rewrite 8 tests to use existing methods

### ⚫ Ignore
- [ ] `conflictResolutionService.test.ts` - pre-existing issue

---

**Next step**: Choose an option and I'll implement it. What's your preference?

