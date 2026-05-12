# Chrome launch flags for the daily retrieve-all automation

Reference document. Source citations against Chromium source, official Chrome docs, and Microsoft Learn. Every assertion that involves Chrome internals is backed by a primary-source URL; assertions that aren't carry an explicit "no primary source found" note.

## Current test config (12-May-26)

After the investigation in this directory revised several earlier claims, the active configuration under test is:

```
brave.exe \
  --user-data-dir="C:\Users\Greg\AppData\Local\DagNet\scheduled-browser-profile" \
  --disable-background-timer-throttling \
  --disable-features=IntensiveWakeUpThrottling \
  --app="https://dagnet-nine.vercel.app/?retrieveall"
```

What this preserves vs the earlier configuration:

- **Kept**: `--disable-background-timer-throttling` plus `--disable-features=IntensiveWakeUpThrottling`. These two together prevent both tiers of timer throttling — the older 1 Hz baseline clamp and the newer 1/min "intensive" clamp that fires after 5 min hidden. Cheap defence against any timer regression even though the current hot-path timers are all ≥15 s (see §Hot-path timer inventory below).
- **Dropped**: `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`. The renderer is permitted to be demoted to BelowNormal priority when the window is hidden or occluded. On an always-on server-style PC, this is fine: when the user is at the machine, the renderer yields to them; when the PC is idle, BelowNormal is functionally Normal because nothing else is competing.
- **Not added**: `--disable-features=CalculateNativeWinOcclusion,ScreenPowerListenerForNativeWinOcclusion,FreezingOnEnergySaver`. The first two are documented but their effect on this workload is limited — they prevent occlusion *detection*, not the kinds of behaviour that affect HTTP-await loops. `FreezingOnEnergySaver` only triggers when Chrome's user-facing Energy Saver mode is active (`chrome://settings/performance`) and is exempted by active IndexedDB transactions — both of which mean it almost certainly never fires on this workload.

The change is being tested overnight. Confirmation criteria: Windows host does not become catastrophically unresponsive during the run.

## Reference: what each flag and feature actually does

### Switch flags (defined in `content_switches.cc`)

#### `--disable-background-timer-throttling`

- **What**: Disables Blink's first-tier clamping of `setTimeout`/`setInterval` in hidden pages. Without the flag, hidden tabs throttle to ~1 Hz immediately.
- **What disabling does NOT do**: The newer `IntensiveWakeUpThrottling` feature is independent and applies on top; see below.
- **Source**: defined in [content_switches.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc).

#### `--disable-renderer-backgrounding`

- **What**: Prevents the renderer process priority demotion that fires when all tabs in a renderer become hidden. Without this flag, Chromium calls `base::Process::SetProcessBackgrounded(true)` which lowers the Windows process priority to BelowNormal and hints the working set down.
- **What disabling does NOT do**: The renderer-priority demotion path also has side effects on memory pressure listeners, but the *direct* effect of this flag is process priority.
- **Source**: defined in [content_switches.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc), priority side checked in [render_process_host_impl.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/renderer_host/render_process_host_impl.cc).

#### `--disable-backgrounding-occluded-windows`

- **What**: The C++ symbol is `kDisableBackgroundingOccludedWindowsForTesting`. The "ForTesting" suffix is significant — the flag's documented purpose is preventing test flakiness, not production tuning. It blocks the *response* to occlusion (renderer-priority demotion) on the browser-process side, but does not affect the *detection* of occlusion in `ui/aura`.
- **What disabling does NOT do**: occlusion is still detected and the page is still marked OCCLUDED in the tracker, which propagates to `visibilityState: hidden` and stops the compositor regardless of this flag. To prevent occlusion detection entirely, disable `CalculateNativeWinOcclusion` (see below).
- **Source**: defined in [content_switches.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc) with comment *"Disable backgrounding renders for occluded windows. Done for tests to avoid nondeterministic behavior."*

### `--disable-features=` entries

#### `CalculateNativeWinOcclusion`

- **What**: `BASE_FEATURE(kCalculateNativeWinOcclusion, base::FEATURE_ENABLED_BY_DEFAULT)` inside `#if BUILDFLAG(IS_WIN)` in [ui/base/ui_base_features.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/ui_base_features.cc). When disabled, `IsNativeWindowOcclusionTrackingAlwaysEnabled()` in [ui/aura/native_window_occlusion_tracker.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/aura/native_window_occlusion_tracker.cc) returns false. Callers skip `NativeWindowOcclusionTrackerWin::Enable(...)`, so the COM-thread `WindowOcclusionCalculator` never starts. Windows never get marked OCCLUDED, regardless of z-order, monitor power state, or session lock.
- **What the Chromium design doc says** ([windows_native_window_occlusion_tracking.md](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_native_window_occlusion_tracking.md)): *"If a window is occluded, Chromium treats foreground tabs as if they were background tabs; rendering stops, and js is throttled."*
- **Memory side effects**: **No primary source found** for a direct call from the occlusion tracker into `MemoryPressureListener` or any cache-trim path. The documented path is occlusion → renderer priority, not occlusion → memory release.
- **Relation to `--disable-backgrounding-occluded-windows`**: complementary. The feature controls whether the OCCLUDED signal is emitted at all (Windows tracker layer). The switch controls whether the renderer is demoted in response to the signal (browser-process layer). Disabling both is belt-and-braces; neither subsumes the other.
- **Platform**: Windows only.

#### `ScreenPowerListenerForNativeWinOcclusion`

- **Status (current Chromium)**: The string `ScreenPowerListenerForNativeWinOcclusion` is **NOT present** in `ui/base/ui_base_features.cc` on [main](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/ui_base_features.cc) or at [tag 138.0.7204.184](https://chromium.googlesource.com/chromium/src/+/refs/tags/138.0.7204.184/ui/base/ui_base_features.cc). It was present at [tag 130.0.6723.117](https://chromium.googlesource.com/chromium/src/+/refs/tags/130.0.6723.117/ui/base/ui_base_features.cc). The feature appears to have been removed between M130 and M138; **no primary source found** for the removal commit.
- **What it controlled (historical)**: when enabled, registered for `GUID_SESSION_DISPLAY_STATUS` notifications so that monitor power-off (DPMS) marked all tracked windows as OCCLUDED, via the `OnDisplayStateChanged(bool display_on)` path in [native_window_occlusion_tracker_win.h](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/aura/native_window_occlusion_tracker_win.h).
- **Practical implication**: passing this feature in `--disable-features=` on a current build is most likely a silent no-op. Chromium ignores unknown feature names — harmless to include, don't expect effect. On M138+ the monitor-off → occluded behaviour is unconditional within the tracker, and is only stopped by disabling `CalculateNativeWinOcclusion` itself.

#### `IntensiveWakeUpThrottling`

- **What**: `BASE_FEATURE(kIntensiveWakeUpThrottling, base::FEATURE_ENABLED_BY_DEFAULT)` in [third_party/blink/common/features.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/common/features.cc). Comment: *"When enabled, wake ups from throttleable TaskQueues are limited to 1 per minute in a page that has been backgrounded for 5 minutes. Intensive wake up throttling is enforced in addition to other throttling mechanisms: - 1 wake up per second in a background page or hidden cross-origin frame - 1% CPU time in a page that has been backgrounded for 10 seconds"*.
- **What disabling does**: `PageSchedulerImpl::GetIntensiveWakeUpThrottlingInterval()` in [page_scheduler_impl.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.cc) returns the default 1 s interval instead of the 1 min interval after the grace period.
- **Tier relationship**: distinct from `--disable-background-timer-throttling`. That older switch covers the first tier (1 Hz baseline floor in hidden pages). `IntensiveWakeUpThrottling` is a second tier sitting on top, dropping to 1/min after 5 min hidden + 30 s silent + no WebRTC. Disabling one does not disable the other.
- **Chained-timer 4 ms clamp**: this is a *separate* Blink mechanism (timeout clamped to 4 ms minimum after chain count ≥ 5, per the [Chrome 88 blog](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). It is not part of `kIntensiveWakeUpThrottling` and is not disabled by this feature.
- **Memory side effects**: **no primary source found**.
- **Platform**: all platforms. Chrome Status: [feature/5580139453743104](https://chromestatus.com/feature/5580139453743104).

#### `FreezingOnEnergySaver` (internal name: `FreezingOnBatterySaver`)

- **Important naming caveat**: the public name is "Freezing on Energy Saver" but the Finch / `BASE_FEATURE` name appears to be `FreezingOnBatterySaver`, per the [intent-to-ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/Xu1C7WhoGm4). **The exact `BASE_FEATURE` declaration was NOT located** in `components/performance_manager/public/features.h` or its neighbours in our search. If you pass the string `FreezingOnEnergySaver` to `--disable-features=`, it may be silently ignored because Chromium expects `FreezingOnBatterySaver`. Verify the exact string before relying on this flag.
- **What it does (when active)**: gating in [components/performance_manager/freezing/freezing_policy.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/performance_manager/freezing/freezing_policy.cc). Conditions for freeze per the [official Chrome blog](https://developer.chrome.com/blog/freezing-on-energy-saver): hidden + silent > 5 min AND a same-origin frame subgroup exceeds a CPU threshold AND none of the opt-outs apply (audio/video conferencing, WebUSB/Bluetooth/HID/Serial, Web Locks, **active IndexedDB transactions**, etc.).
- **When frozen**: per the blog, *"Freezing suspends task execution on a web page. This includes: Event handlers..., Timers, Promise resolvers."* JS execution stops. `await fetch` and `setTimeout` callbacks do not fire. This is the only feature in the list that can genuinely halt the overnight loop.
- **"Energy Saver" is a Chrome setting, not a Windows OS state**: configured via `chrome://settings/performance`, controlled by the [BatterySaverModeAvailability enterprise policy](https://chromeenterprise.google/policies/battery-saver-mode-availability/). Default behaviour is "activate when device is on battery power and battery level is low". On an always-on AC-powered server-class box, this almost certainly never activates.
- **IndexedDB opt-out**: active IDB transactions are listed in the blog as an opt-out condition. The retrieve-all loop writes to IDB on every fetched item — so even if Energy Saver were active, the freeze conditions would likely not hold for this workload.
- **Shipped**: Chrome 133 (Feb 2025). Chrome Status: [feature/5158599457767424](https://chromestatus.com/feature/5158599457767424).

## Hot-path timer inventory (12-May-26 source check)

Every recurring timer in the retrieve-all path. This list is the basis for the claim that the loop does not need timer-throttling protections.

| Location | Interval | Throttled in hidden tab? | Effect on loop |
|---|---|---|---|
| [rateLimiter.ts:137](../../../graph-editor/src/services/rateLimiter.ts#L137) | 0 ms (both providers have `minDelayMs: 0`) | n/a | none |
| [retrieveAllSlicesService.ts:970](../../../graph-editor/src/services/retrieveAllSlicesService.ts#L970) | 30 000–300 000 ms (timeout backoff) | No — far above 1 Hz floor | none |
| [fetchDataService.ts:1443](../../../graph-editor/src/services/fetchDataService.ts#L1443) | 15 000–30 000 ms (internal timeout retry) | No | none |
| [fetchDataService.ts:2677](../../../graph-editor/src/services/fetchDataService.ts#L2677) | 500 ms (CF race deadline) | Yes — clamps to 1000 ms | CF fast-path gets 1 s instead of 500 ms before FE fallback. No stall. |
| [dailyAutomationJob.ts:473](../../../graph-editor/src/services/dailyAutomationJob.ts#L473) | 60 000 ms (progressive flush) | No | none |
| [dailyAutomationJob.ts:519](../../../graph-editor/src/services/dailyAutomationJob.ts#L519) | 250 ms (startup readiness poll) | Yes — clamps to 1000 ms | Adds ~3 s to startup once. |
| [dailyAutomationJob.ts:530–536](../../../graph-editor/src/services/dailyAutomationJob.ts#L530-L536) (log commit loop) | 600 000 ms via `sleepUntilDeadline` | No — explicitly designed via absolute deadlines to resist throttling (see comment at line 527–529) | none |

Two sub-second timers in the entire hot path, both with cosmetic-only consequences. Every cooldown is minute-scale. `await fetch(...)` is never throttled by Chrome regardless of tab state.

## Hypotheses tested and revised

The conversation that produced this document went through several theories about what these flags did and why the host was freezing. For future agents working on similar issues, the corrections matter as much as the conclusions:

- **Disproved: 9-Apr-26 "v8 heap pressure crashes the host"** — 196 sysdiag snapshots across 8–12 May show the v8 heap stable at 85–105 MB, `growthFromBaselineMB` negative, DOM/IDB/fileRegistry flat. The renderer's JS heap is verifiably not the cause.

- **Disproved: "renderer thread is saturated and fetches abort because IPC isn't being serviced"** — cache reads (`GET_FROM_FILE`, pure renderer-thread work: IDB read + JSON.parse) stay at 10–20 ms throughout the 8-hour run. The renderer's main thread is not starved.

- **Not supported by source: "`--disable-backgrounding-occluded-windows` suppresses memory purge → commit growth → freeze"** — no primary source found for occlusion-tracker calls into `MemoryPressureListener` or cache-trim paths. The flag's documented effect is renderer-priority-demotion, not memory release. The earlier framing of this flag as "the specific cause" of commit growth was speculation that should not have been put forward as confidently as it was.

- **Refined and still plausible: "Windows System Commit exhaustion driven by long-running browser + GPU processes"** — the *mechanism* fits the symptom (mouse cursor lag, slow keystrokes, instant recovery on kill = textbook page-fault thrashing from commit pressure, per [Microsoft's perf docs](https://technet2.github.io/Wiki/articles/2248.perfguide-out-of-system-committed-memory.html)). The growth is in the browser process and GPU process, not the renderer's v8 heap. But the specific causal role of any one flag is less clear than originally claimed; the underlying cause may be "long-running headed Chrome accumulates cache memory" generically rather than one specific flag's behaviour. See [host-freeze-mechanism.md](host-freeze-mechanism.md).

- **Confirmed: Issue B (timeouts) is decoupled from Issue A (host freeze)** — per-edge analysis ([timeout-pattern-analysis.md](timeout-pattern-analysis.md)) shows timeouts cluster on 12 specific edges of graph 3 (`li-energy-simple-v1`) on specific big-cohort slices (`immediate-proposals-v2/v3`, `low-intent-v9`, `other`). This is consistent with Amplitude query latency for those specific queries exceeding the hard-coded 30 s client `AbortController` deadline in [BrowserHttpExecutor.ts:62](../../../graph-editor/src/lib/das/BrowserHttpExecutor.ts#L62). Independent of any flag question.

## Open questions

1. **Does the current test config produce a stable run?** The 12-May-26 test will tell us.
2. **If commit grows even under the test config**, that confirms the growth is intrinsic to long-running headed Chrome, not flag-specific. Remediation options: periodic process restart, `--use-angle=swiftshader`, or `--headless=new` mode.
3. **Is the 30 s client timeout on `BrowserHttpExecutor` the right fix for graph 3?** The retry path eventually succeeds, but at the cost of 5-minute cooldowns and an 8-hour run. Plumbing a longer per-request timeout through the automation path would let those queries complete on first attempt.
4. **Is the Vercel `python-api.py` `maxDuration` set?** Flagged in [handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md](../handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md) — default is 10 s on Hobby, 60 s on Pro. If 10 s, no client-side timeout change helps.
5. **The `cached=0, fetched=80` observation on graph 1** — every morning the same. The cache key/signature logic is the suspect. Fix here turns the 80-fetch graph-1 segment from 5 min to seconds and may apply to graph 3 too.

## Where the flags are defined

The three `--disable-*` switch flags the user has been adding are **NOT in any committed code**. [setup-daily-retrieve.ps1:484](../../../graph-editor/scripts/scheduling/setup-daily-retrieve.ps1#L484) only generates `--user-data-dir=... --app=...`. The flags were added downstream via Task Scheduler GUI edit or task-XML modification. Changes can be made by editing the task action without changing any source file.

## Sources

Primary (Chromium / Microsoft):
- [content_switches.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_switches.cc)
- [ui/base/ui_base_features.cc (main)](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/ui_base_features.cc)
- [ui/aura/native_window_occlusion_tracker.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/aura/native_window_occlusion_tracker.cc)
- [ui/aura/native_window_occlusion_tracker_win.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/aura/native_window_occlusion_tracker_win.cc)
- [docs/windows_native_window_occlusion_tracking.md](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_native_window_occlusion_tracking.md)
- [content/browser/renderer_host/render_process_host_impl.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/renderer_host/render_process_host_impl.cc)
- [third_party/blink/common/features.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/common/features.cc)
- [third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/scheduler/main_thread/page_scheduler_impl.cc)
- [components/performance_manager/freezing/freezing_policy.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/performance_manager/freezing/freezing_policy.cc)
- [Out of System Committed Memory — Microsoft TechNet](https://technet2.github.io/Wiki/articles/2248.perfguide-out-of-system-committed-memory.html)
- [The Basics of Page Faults — Microsoft Tech Community](https://techcommunity.microsoft.com/t5/ask-the-performance-team/the-basics-of-page-faults/ba-p/373120)

Official Chrome (developer.chrome.com / Chromium Blog):
- [Timer throttling in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
- [Freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver)
- [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [Chrome on Windows performance — Native Window Occlusion (Dec 2021)](https://blog.chromium.org/2021/12/chrome-windows-performance-improvements-native-window-occlusion.html)

Chrome Status entries:
- [IntensiveWakeUpThrottling — feature/5580139453743104](https://chromestatus.com/feature/5580139453743104)
- [Freezing on Energy Saver — feature/5158599457767424](https://chromestatus.com/feature/5158599457767424)
- [Intent-to-implement IntensiveWakeUpThrottling — blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/8En_5DqV_fU/m/I8e9vaecAgAJ)
- [Intent-to-ship FreezingOnBatterySaver — blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/Xu1C7WhoGm4)

Other:
- [WDDM Timeout Detection and Recovery (TDR) — Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)
- [`WM_WTSSESSION_CHANGE` — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/termserv/wm-wtssession-change)
- [Finding Windows HANDLE leaks in Chromium and others — Bruce Dawson](https://randomascii.wordpress.com/2021/07/25/finding-windows-handle-leaks-in-chromium-and-others/)
- [crbug.com/1024837 — Occlusion on Citrix/RDP](https://bugs.chromium.org/p/chromium/issues/detail?id=1024837)
- [chrome-launcher chrome-flags-for-tools](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md)
- [Peter Beverloo — Chromium command line switches](https://peter.sh/experiments/chromium-command-line-switches/)
