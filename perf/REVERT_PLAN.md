# Revert Plan: Performance Diagnostic Session

**Date**: November 16, 2025  
**Purpose**: Revert all code changes from diagnostic session, preserve perf/ documentation  
**Target**: Reset to commit `927a39b` (Beading heck)

---

## Overview

During this diagnostic session, we modified multiple files to:
- Add logging and instrumentation
- Test diagnostic flags (`?nobeads`, `?nochevrons`, `?minimal`)
- Implement pan/zoom suppression solutions
- Add incremental restoration logic

**Now**: Revert all code changes, keep only the documentation in `perf/` for reference.

---

## Modified Files (To Be Reverted)

From `git status --short`:

### Application Code
```
M TODO.md
M graph-editor/src/AppShell.tsx
M graph-editor/src/components/ChevronClipPaths.tsx
M graph-editor/src/components/GraphCanvas.tsx
M graph-editor/src/components/canvas/buildScenarioRenderEdges.ts
M graph-editor/src/components/edges/ConversionEdge.tsx
M graph-editor/src/components/edges/EdgeBeads.tsx
M graph-editor/src/components/edges/edgeBeadHelpers.tsx
M graph-editor/src/components/editors/GraphEditor.tsx
M graph-editor/src/components/nodes/ConversionNode.tsx
M graph-editor/src/components/panels/ScenariosPanel.tsx
M graph-editor/src/contexts/DialogContext.tsx
M graph-editor/src/contexts/NavigatorContext.tsx
M graph-editor/src/contexts/ScenariosContext.tsx
M graph-editor/src/contexts/TabContext.tsx
M graph-editor/src/contexts/ValidationContext.tsx
```

**Total**: 16 modified files

---

## Preserved Files (perf/ directory)

### Diagnostic Reports
- `DIAGNOSTIC_FINDINGS.md` - Main diagnostic report (what we learned)
- `SOLUTION_IMPLEMENTATIONS.md` - Solution details and implementation guide
- `INCREMENTAL_RESTORATION_IMPLEMENTATION.md` - Incremental restoration approach
- `BEADS_CHEVRONS_ROOT_CAUSE.md` - Root cause analysis
- `DEFINITIVE_DIAGNOSIS.md` - Earlier diagnostic notes
- `DEVTOOLS_PROFILING_GUIDE.md` - How to use Chrome DevTools
- `FINDINGS.md` - Initial findings
- `REACT_PROFILER_FINDINGS.md` - React profiler analysis
- `RENDER_FORENSICS_PLAN.md` - Forensic investigation plan

### Analysis Scripts
- `analyze_trace.py` - Trace file analyzer
- `deep_analyze_trace.py` - Deep trace analyzer
- `timeline_correlator.py` - Correlate timeline events
- `console_trace_correlator.py` - Console log correlation
- `continuous_work_detector.py` - Detect continuous work patterns
- `frame_by_frame_analysis.py` - Frame-by-frame breakdown
- `gpu_compositor_analysis.py` - GPU compositor analysis
- `manual_correlation.py` - Manual event correlation
- `nested_work_analyzer.py` - Nested work detection
- `react_profiler_analyzer.py` - React profiler data parser
- `react_scheduler_analysis.py` - React scheduler investigation
- `reactflow_events_analyzer.py` - ReactFlow event tracking
- `raw_event_dumper.py` - Raw event dump tool
- `timing_pattern_analyzer.py` - Timing pattern analysis
- `event_args_inspector.py` - Event argument inspector

### Analysis Output Files
- `analysis_report.txt` - Initial analysis report
- `analysis_report_new.txt` - Updated analysis report
- `deep_analysis_report_new.txt` - Deep analysis results
- `timeline_correlation_report.txt` - Timeline correlation results
- `gpu_compositor_report.txt` - GPU compositor findings
- `react_profiler_analysis.txt` - React profiler results
- `react_scheduler_report.txt` - React scheduler findings

### Glitch Data Files
- `analysis_glitch.txt`
- `console_correlation_glitch.txt`
- `continuous_work_glitch.txt`
- `deep_analysis_glitch.txt`
- `event_args_glitch.txt`
- `frame_analysis_glitch.txt`
- `gpu_glitch.txt`
- `manual_correlation_glitch.txt`
- `nested_work_glitch.txt`
- `raw_events_glitch.txt`
- `react_scheduler_glitch.txt`
- `reactflow_events_glitch.txt`
- `timeline_glitch.txt`

### Raw Data
- `Trace-20251115T201251.json` - Chrome DevTools trace
- `profiling-data.16-11-2025.10-43-50.json` - React Profiler data
- `profiling-data.16-11-2025.10-37-24.json:Zone.Identifier` - Windows zone file
- `profiling-data.16-11-2025.10-43-50.json:Zone.Identifier` - Windows zone file

**Total**: 46 files in perf/ directory (to be preserved)

---

## Revert Procedure

### Step 1: Stage perf/ directory

**Goal**: Ensure perf/ directory is staged so it doesn't get lost during revert.

```bash
cd /home/reg/dev/dagnet
git add perf/
```

**Verification**:
```bash
git status
# Should show:
# - new file: perf/DIAGNOSTIC_FINDINGS.md
# - new file: perf/SOLUTION_IMPLEMENTATIONS.md
# - ... (all perf/ files)
```

---

### Step 2: Revert modified files

**Goal**: Reset all modified files to last commit state.

```bash
cd /home/reg/dev/dagnet
git checkout HEAD -- TODO.md
git checkout HEAD -- graph-editor/src/AppShell.tsx
git checkout HEAD -- graph-editor/src/components/ChevronClipPaths.tsx
git checkout HEAD -- graph-editor/src/components/GraphCanvas.tsx
git checkout HEAD -- graph-editor/src/components/canvas/buildScenarioRenderEdges.ts
git checkout HEAD -- graph-editor/src/components/edges/ConversionEdge.tsx
git checkout HEAD -- graph-editor/src/components/edges/EdgeBeads.tsx
git checkout HEAD -- graph-editor/src/components/edges/edgeBeadHelpers.tsx
git checkout HEAD -- graph-editor/src/components/editors/GraphEditor.tsx
git checkout HEAD -- graph-editor/src/components/nodes/ConversionNode.tsx
git checkout HEAD -- graph-editor/src/components/panels/ScenariosPanel.tsx
git checkout HEAD -- graph-editor/src/contexts/DialogContext.tsx
git checkout HEAD -- graph-editor/src/contexts/NavigatorContext.tsx
git checkout HEAD -- graph-editor/src/contexts/ScenariosContext.tsx
git checkout HEAD -- graph-editor/src/contexts/TabContext.tsx
git checkout HEAD -- graph-editor/src/contexts/ValidationContext.tsx
```

**Alternative (bulk revert)**:
```bash
cd /home/reg/dev/dagnet
git checkout HEAD -- TODO.md graph-editor/
```

**Verification**:
```bash
git status
# Should show:
# Changes to be committed:
#   new file: perf/* (all perf files)
# (no modified files should be listed)
```

---

### Step 3: Verify no stale changes

**Goal**: Ensure working directory is clean except for staged perf/ files.

```bash
git diff
# Should output nothing (no unstaged changes)

git diff --cached
# Should show only additions in perf/ directory
```

---

### Step 4: Commit perf/ directory

**Goal**: Commit documentation for future reference.

```bash
git commit -m "docs(perf): Add pan/zoom performance diagnostic findings

Added comprehensive diagnostic reports and analysis tools:
- DIAGNOSTIC_FINDINGS.md: Root cause analysis (chevrons + beads during pan)
- SOLUTION_IMPLEMENTATIONS.md: Implementation guide for pan suppression
- INCREMENTAL_RESTORATION_IMPLEMENTATION.md: Incremental restoration approach
- Analysis scripts and raw data for future reference

Key findings:
- Chevron clipPaths cost 10-15ms per pan frame (GPU composite)
- Edge beads cost 8-12ms per pan frame (React portal reconciliation)
- Solution: Suppress during pan, restore incrementally after

This commit contains ONLY documentation. Code remains unchanged."
```

**Verification**:
```bash
git log -1 --stat
# Should show commit with only perf/ files added

git status
# Should show "working tree clean"
```

---

### Step 5: Verify application state

**Goal**: Ensure application runs correctly after revert.

```bash
cd /home/reg/dev/dagnet/graph-editor
npm run dev
```

**Manual testing**:
1. Load a graph with 100+ edges
2. Pan/zoom canvas - should see baseline performance (jank expected)
3. Verify no console errors
4. Verify no TypeScript errors: `npm run typecheck`
5. Verify no ESLint errors: `npm run lint`

---

## What Gets Reverted (Summary)

### Diagnostic Instrumentation
- ❌ `console.log` statements for render tracking
- ❌ `renderFrameRef` counters
- ❌ `performance.now()` timing instrumentation
- ❌ Dependency tracking logs

### Diagnostic Flags
- ❌ `?minimal` mode implementation
- ❌ `?nobeads` flag checks
- ❌ `?nochevrons` flag checks
- ❌ `(window as any).NO_BEADS_MODE` globals
- ❌ `(window as any).NO_CHEVRONS_MODE` globals

### Pan/Zoom Suppression
- ❌ `isPanningOrZooming` state
- ❌ `activeBundleCount` state for incremental restoration
- ❌ `shouldSuppressBeads` derived state
- ❌ `restorationRafRef` RAF loop
- ❌ Movement detection logic (`hasMovedRef`, `moveStartViewportRef`)
- ❌ `isPanningOrZooming` prop in edge data
- ❌ Conditional rendering based on pan state

### Context Changes
- ❌ Any context identity churn fixes
- ❌ Memoization adjustments
- ❌ Effect dependency changes

### All Other Changes
- ❌ Any other experimental code added during diagnostic session

---

## What Gets Preserved (Summary)

### ✅ Documentation in perf/
- Diagnostic findings and root cause analysis
- Solution implementation guides
- Analysis scripts and raw data
- Reference for future clean implementation

### ✅ Git History
- All commits remain in git history
- Can cherry-pick or reference later if needed
- This diagnostic session is documented

---

## Post-Revert Status

After executing this plan:

**Working directory**: Clean, matches commit `927a39b` + new `perf/` directory

**Application behavior**: 
- Baseline performance (jank during pan expected)
- No diagnostic flags active
- No suppression logic

**Documentation**: 
- Comprehensive diagnostic findings preserved
- Solution approaches documented
- Reference implementation available

**Next steps**:
- Review documentation
- Plan clean implementation based on findings
- Implement in focused, reviewable commits

---

## Rollback (If Something Goes Wrong)

If revert procedure has issues:

### Before committing perf/:
```bash
# Unstage everything
git reset HEAD

# Restore modified files to current state
git stash
```

### After committing perf/:
```bash
# Undo last commit but keep files
git reset --soft HEAD~1

# Or: completely undo commit and changes
git reset --hard HEAD~1
# (Warning: this loses perf/ files - only use if they're backed up)
```

---

## Verification Checklist

After revert, verify:

- [ ] `git status` shows clean working tree
- [ ] `git log -1` shows new commit with only perf/ files
- [ ] `git diff HEAD~1` shows only additions in perf/ directory
- [ ] Application starts without errors (`npm run dev`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] ESLint passes (`npm run lint`)
- [ ] All perf/ files present and readable
- [ ] Modified files reverted (spot-check `GraphCanvas.tsx` has no `isPanningOrZooming`)
- [ ] No diagnostic flags active (spot-check `ConversionEdge.tsx` has no `NO_BEADS_MODE` check)

---

## Future Implementation Plan

When ready to implement the solution cleanly:

1. **Read documentation**: Review `SOLUTION_IMPLEMENTATIONS.md`
2. **Create feature branch**: `git checkout -b feat/pan-zoom-performance`
3. **Implement in phases**:
   - Phase 1: Pan detection and state management
   - Phase 2: Chevron suppression (simple)
   - Phase 3: Bead suppression via edge data
   - Phase 4: Incremental restoration (if needed)
4. **Test each phase** before proceeding
5. **Small, focused commits** with clear messages
6. **Pull request** with reference to diagnostic docs

---

## Notes

- This revert is **intentional** - we want a clean slate for production implementation
- The diagnostic session was **valuable** - we learned what the problem is and how to solve it
- Documentation is **comprehensive** - contains everything needed for clean implementation
- Code changes were **exploratory** - appropriate to revert rather than clean up
- Future implementation will be **focused** - based on proven approach from diagnostics

---

## Summary Commands (Quick Reference)

```bash
# Full revert procedure
cd /home/reg/dev/dagnet

# Stage perf/ directory
git add perf/

# Revert all modified files
git checkout HEAD -- TODO.md graph-editor/

# Verify
git status  # Should show only perf/ staged
git diff    # Should be empty

# Commit
git commit -m "docs(perf): Add pan/zoom performance diagnostic findings"

# Verify final state
git status  # Should be clean
git log -1 --stat  # Should show only perf/ files
```

---

## Contact / Questions

If issues arise during revert:
1. Check "Rollback" section above
2. Review git status at each step
3. Don't force-push if in doubt
4. Can always restore from this diagnostic session's commits

---

**End of Revert Plan**

