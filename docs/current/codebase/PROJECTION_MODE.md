# Projection Mode

How DagNet projects future conversions from historical data and fitted lag distributions.

## What Projection Mode Does

Given historical entry counts (`n_daily`), observed conversions (`k_daily`), and a fitted log-normal lag distribution (p_inf, mu, sigma, onset), computes expected conversions for each date T via convolution:

```
k_expected[T] = sum over D <= T of: n_daily[D] * p_inf * [F(T-D-onset) - F(T-D-1-onset)]
```

where F = log-normal CDF.

## Output

Array of ProjectionPoints with:
- Observed k (for past dates)
- Expected k (projected)
- Flag indicating future dates

Pure functions only -- no side effects, no API calls.

## Default horizon

60 days forward from the latest data point.

## UI Control

Toggle via URL param `?projection=1` and context state. Last selected edge key persists across open/close.

## Key Files

| File | Role |
|------|------|
| `src/contexts/ProjectionModeContext.tsx` | Projection state management |
| `src/services/projectionService.ts` | Convolution computation |
| `src/components/Projection/` | Projection UI components |
