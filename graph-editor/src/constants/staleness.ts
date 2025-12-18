/**
 * Staleness / safety nudge thresholds (time-based).
 *
 * Centralised here so all nudges and related UX use consistent timings.
 */
export const STALENESS_NUDGE_RELOAD_AFTER_MS = 12 * 60 * 60 * 1000; // 12h
export const STALENESS_NUDGE_GIT_PULL_AFTER_MS = 12 * 60 * 60 * 1000; // 12h
export const STALENESS_NUDGE_RETRIEVE_ALL_SLICES_AFTER_MS = 20 * 60 * 60 * 1000; // 20h (tentative)

/** User snooze duration for nudges. */
export const STALENESS_NUDGE_SNOOZE_MS = 60 * 60 * 1000; // 1h

/**
 * Guardrail: even if conditions persist, don't re-prompt immediately after a user action.
 * This is separate from snooze, and helps avoid spam if checks run on focus + visibility.
 */
export const STALENESS_NUDGE_MIN_REPEAT_MS = 10 * 60 * 1000; // 10m

/**
 * After a user chooses "Reload" plus other actions, we persist a pending plan to run
 * immediately after reload. This is a safety cap to avoid executing stale pending plans.
 */
export const STALENESS_PENDING_PLAN_MAX_AGE_MS = 30 * 60 * 1000; // 30m

/**
 * Default state for the "Automatic mode" toggle in the staleness update modal.
 * When enabled, DagNet will run the due update actions without prompting (except pull conflicts).
 */
export const STALENESS_AUTOMATIC_MODE_DEFAULT = false;


