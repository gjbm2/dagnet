# Host-freeze mechanism — Windows System Commit exhaustion (hypothesis)

**Status: leading hypothesis, not confirmed.** One Task Manager snapshot taken mid-pathology settles it.

## The specific symptom this is trying to explain

Not "browser slow" — the **entire Windows 11 desktop** becomes unresponsive while the daily retrieve-all is running:

- Mouse cursor barely updates when dragged.
- Keys take 20+ seconds to register.
- Other long-running cron jobs on the same machine are unaffected.
- **Killing the Chromium process tree restores the desktop instantly.** No reboot.

The pathology develops over ~8 hours into the run, not from the start.

## What sysdiag cannot see, and why

The SysDiag entries in the automation log are based on `performance.memory.usedJSHeapSize`. That measures the v8 heap **inside one renderer process only**. Every overnight run for the last month shows this number stable at 85–105 MB. **This rules out a JS-heap leak — but it does not rule out the catastrophe described above**, because the process group has at least four other processes the renderer's `performance.memory` doesn't see:

- **Browser process** — Mojo IPC buffers, the disk cache, IndexedDB SQLite caches, net-stack buffers, response buffers from ~900 Vercel fetches per run, GitHub-REST commit payloads every 10 min.
- **GPU process** — ANGLE/D3D11 texture cache, DirectComposition swap chains for whatever the compositor decides to keep alive.
- **Network process** — socket buffers, DNS cache.
- **Utility processes** — Mojo brokers, various sandboxed helpers.

All of these grow in **private commit**, not just working set. The renderer's v8 heap stays flat at 100 MB while the rest of the process tree could grow by gigabytes. This is well-attested in long-running Puppeteer / headed-automation deployments (e.g. [Puppeteer issue #9283](https://github.com/puppeteer/puppeteer/issues/9283), reporting ~0.5 MB/s leak rate over hours).

## The mechanism for OS-wide freeze (Microsoft-documented)

Critical detail that's often missed: **on Windows the trigger for catastrophic system freeze is the Commit Limit, not physical RAM.** Per [Microsoft's own perf docs](https://technet2.github.io/Wiki/articles/2248.perfguide-out-of-system-committed-memory.html), the Commit Limit is "installed RAM + total page-file capacity". Once Committed memory approaches the limit, **every new allocation by every process** triggers a hard page fault. Hard faults are ~400× slower than RAM on SSD. That cost is paid not just by the bloated process but by **DWM compositing**, the **Win32k cursor and input handlers** in the kernel, `csrss.exe`, `explorer.exe`, and anti-virus — every process needs RAM, every allocation now hits disk.

That is the "mouse barely moves, keystrokes lag 20 seconds" pattern. The input thread is in the kernel; it does not care about renderer CPU; it is being page-faulted on its own code pages.

Task Manager's main view shows "RAM available" which can read healthy while Commit is 200 MB from the cliff — most people miss the actual signal.

## How the mechanism fits every observation

| Observation | Mechanism fit |
|---|---|
| Catastrophic OS-wide freeze, not "just browser slow" | Commit pressure starves every process. DWM, Win32k input, anti-virus — every kernel allocation page-faults. |
| Mouse cursor lag, 20-second keystrokes | Input and cursor threads block on disk waiting for paged-out kernel code. |
| Develops over ~8 hours | Commit grows linearly through the run; the cliff is at ~95% of the Commit Limit. |
| **Instant recovery on Chromium kill** | Terminating the process tree releases GBs of commit pages atomically. The page-fault servicing queue drains in seconds. This single fact rules out most alternative mechanisms. |
| Other crons on the same box are unaffected | Their committed memory doesn't grow unboundedly. They never approach the limit. |
| Renderer JS heap stays flat | Heap is one process. Growth is in the *other* Chromium processes — invisible to `performance.memory`. |
| Cache reads (`GET_FROM_FILE`) stay at 10–20 ms | Renderer thread itself is fine. The pathology is OS-level. |

GPU-VRAM exhaustion is a tempting alternate hypothesis but on Windows 11 it collapses into the same mechanism: WDDM 2.0+ pages VRAM through system commit, so a GPU-process texture leak *also* manifests as commit pressure. The single mechanism subsumes it.

## What this hypothesis does NOT pin on a specific Chrome flag

An earlier framing in this investigation claimed `--disable-backgrounding-occluded-windows` specifically caused the growth by suppressing Chromium's memory-purge path. **That specific causal chain is not supported by primary source.** No call from the occlusion tracker into `MemoryPressureListener` or any cache-trim path was found in Chromium source (see [browser-flags-analysis.md](browser-flags-analysis.md) §Reference for the actual flag behaviours).

The more honest framing: **long-running headed Chrome accumulates non-heap memory regardless of flags.** The 8-hour duration is the relevant variable; flag tuning is at best a secondary lever. If commit growth still happens under the 12-May-26 test config (which drops the two flags previously suspected), that confirms the duration-driven model. If it stops, the flag set mattered after all.

## The one diagnostic

While the run is in pathology, **before** killing the process:

1. Open Task Manager → **Performance** tab → **Memory** pane.
2. Look at the line "**Committed: X / Y GB**".
3. If X is within ~500 MB of Y, hypothesis confirmed.

For belt-and-braces, the [PowerShell capture script](perf-capture-windows.md) records `CommittedMB`, `CommitLimitMB`, `PagesPerSec`, `DiskQueueLen`, and per-Brave-process private/working-set memory every 60 seconds. The signature is:

- `CommitPct` sustained over 95%
- `PagesPerSec` sustained over 1000 (hard page faults)
- `DiskQueueLen` sustained over 2

If Commit is comfortably below the Limit but the desktop is still frozen, the mechanism is something else — handle exhaustion, a kernel-side bug, GPU TDR. Those are less likely but rule out via:

- Task Manager → Details tab → add columns "GDI objects", "USER objects", "Handles". Sort by handle count. Any Brave process approaching 10 000 GDI or 10 000 USER is a handle leak.
- `dxdiag` → Display → "Display Memory". GPU memory near adapter cap is a clue but on WDDM 2.0+ this collapses into commit anyway.

## If the diagnostic confirms commit-exhaustion: candidate fixes

In order of expected impact:

1. **Periodic process restart** (60–90 min). Reliable regardless of which sub-component is leaking. Standard practice for long Puppeteer / headed-automation jobs. Requires per-slice resumability so a restart doesn't lose progress.
2. **`--use-angle=swiftshader`** — eliminates the GPU process's D3D11 texture-cache path entirely. CPU rasterises instead. Costs rendering performance, irrelevant for an unwatched automation tab.
3. **`--disk-cache-size=0`** — disables Chromium's on-disk cache for HTTP responses. Costs zero for this workload (we manage caching ourselves via IDB).
4. **`--headless=new`** — no compositor at all, no GPU pipeline, no window manager. Architecturally the right answer for a cron job that uses a browser. Needs a one-day compatibility test for boot/IDB/`window.close()`.

The fix is independent of the flag-set question. Even with the "correct" flag set, a long-enough run can still hit Commit-exhaustion; restart is the only reliable safety net.

## Sources

- [Out of System Committed Memory — Microsoft TechNet](https://technet2.github.io/Wiki/articles/2248.perfguide-out-of-system-committed-memory.html) — the canonical "RAM looks fine but the system is frozen" explanation
- [The Basics of Page Faults — Microsoft Tech Community](https://techcommunity.microsoft.com/t5/ask-the-performance-team/the-basics-of-page-faults/ba-p/373120)
- [Finding Windows HANDLE leaks in Chromium and others — Bruce Dawson](https://randomascii.wordpress.com/2021/07/25/finding-windows-handle-leaks-in-chromium-and-others/)
- [Puppeteer issue #9283 — Chrome leaks ~0.5 MB/s in long-running headed automation](https://github.com/puppeteer/puppeteer/issues/9283)
- [Chromium issue 470234 — Large memory leak in GPU process](https://bugs.chromium.org/p/chromium/issues/detail?id=470234)
- [Chromium issue 403471 — GPU process memory usage too high](https://bugs.chromium.org/p/chromium/issues/detail?id=403471)
- [WDDM Timeout Detection and Recovery — Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)
