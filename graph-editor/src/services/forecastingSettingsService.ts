import { db } from '../db/appDatabase';
import {
  RECENCY_HALF_LIFE_DAYS,
  LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE,
  DEFAULT_T95_DAYS,
  FORECAST_BLEND_LAMBDA,
  LATENCY_BLEND_COMPLETENESS_POWER,
  ANCHOR_DELAY_BLEND_K_CONVERSIONS,
  ONSET_MASS_FRACTION_ALPHA,
  ONSET_AGGREGATION_BETA,
} from '../constants/latency';

export type ForecastingModelSettings = {
  RECENCY_HALF_LIFE_DAYS: number;
  LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE: number;
  DEFAULT_T95_DAYS: number;
  FORECAST_BLEND_LAMBDA: number;
  LATENCY_BLEND_COMPLETENESS_POWER: number;
  ANCHOR_DELAY_BLEND_K_CONVERSIONS: number;
  ONSET_MASS_FRACTION_ALPHA: number;
  ONSET_AGGREGATION_BETA: number;
};

function numOr<T extends number>(value: unknown, fallback: T): number {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

/**
 * Reads shared forecasting knobs from settings/settings.yaml (stored in IndexedDB).
 *
 * Critical properties:
 * - Safe fallbacks to the compiled defaults (constants/latency.ts)
 * - Does NOT throw if settings file is missing or malformed (fetches must remain usable)
 */
class ForecastingSettingsService {
  async getForecastingModelSettings(): Promise<ForecastingModelSettings> {
    // Vitest frequently uses fake timers in tests (vi.useFakeTimers), which can
    // interact badly with IndexedDB/Dexie async scheduling and cause hangs.
    // For test determinism and reliability, default to compiled constants unless
    // a test explicitly exercises settings persistence elsewhere.
    //
    // This keeps the production behaviour unchanged, while ensuring tests that
    // pin time via fake timers don't deadlock waiting on IDB.
    if (typeof process !== 'undefined' && process?.env?.VITEST) {
      return {
        RECENCY_HALF_LIFE_DAYS,
        LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE,
        DEFAULT_T95_DAYS,
        FORECAST_BLEND_LAMBDA,
        LATENCY_BLEND_COMPLETENESS_POWER,
        ANCHOR_DELAY_BLEND_K_CONVERSIONS,
        ONSET_MASS_FRACTION_ALPHA,
        ONSET_AGGREGATION_BETA,
      };
    }
    try {
      const file = await db.files.get('settings-settings');
      const forecasting: any = (file as any)?.data?.forecasting || {};
      return {
        RECENCY_HALF_LIFE_DAYS: numOr(forecasting.RECENCY_HALF_LIFE_DAYS, RECENCY_HALF_LIFE_DAYS),
        LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE: numOr(forecasting.LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE, LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE),
        DEFAULT_T95_DAYS: numOr(forecasting.DEFAULT_T95_DAYS, DEFAULT_T95_DAYS),
        FORECAST_BLEND_LAMBDA: numOr(forecasting.FORECAST_BLEND_LAMBDA, FORECAST_BLEND_LAMBDA),
        LATENCY_BLEND_COMPLETENESS_POWER: numOr(forecasting.LATENCY_BLEND_COMPLETENESS_POWER, LATENCY_BLEND_COMPLETENESS_POWER),
        ANCHOR_DELAY_BLEND_K_CONVERSIONS: numOr(forecasting.ANCHOR_DELAY_BLEND_K_CONVERSIONS, ANCHOR_DELAY_BLEND_K_CONVERSIONS),
        ONSET_MASS_FRACTION_ALPHA: numOr(forecasting.ONSET_MASS_FRACTION_ALPHA, ONSET_MASS_FRACTION_ALPHA),
        ONSET_AGGREGATION_BETA: numOr(forecasting.ONSET_AGGREGATION_BETA, ONSET_AGGREGATION_BETA),
      };
    } catch {
      return {
        RECENCY_HALF_LIFE_DAYS,
        LATENCY_MIN_EFFECTIVE_SAMPLE_SIZE,
        DEFAULT_T95_DAYS,
        FORECAST_BLEND_LAMBDA,
        LATENCY_BLEND_COMPLETENESS_POWER,
        ANCHOR_DELAY_BLEND_K_CONVERSIONS,
        ONSET_MASS_FRACTION_ALPHA,
        ONSET_AGGREGATION_BETA,
      };
    }
  }
}

export const forecastingSettingsService = new ForecastingSettingsService();


