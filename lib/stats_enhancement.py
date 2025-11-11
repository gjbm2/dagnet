"""
Statistical Enhancement Library

Provides statistical enhancement methods for time-series aggregation data.
Heavy computations (MCMC, complex Bayesian inference) are implemented here.

Lightweight operations (inverse-variance weighting) are handled in TypeScript.
"""

from typing import Dict, List, Any, Optional, Tuple

# Optional imports for heavy computations
try:
    import numpy as np
    from scipy import stats
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    # Fallback: use basic math for simple operations
    import math


def enhance_aggregation(
    raw_data: Dict[str, Any],
    method: str
) -> Dict[str, Any]:
    """
    Enhance raw aggregation with statistical method.
    
    Args:
        raw_data: RawAggregation dict with:
            - method: 'naive'
            - n: total sample size
            - k: total successes
            - mean: naive mean (k/n)
            - stdev: standard deviation
            - raw_data: List of daily data points [{date, n, k, p}, ...]
            - window: {start, end}
            - days_included: number of days
            - days_missing: number of missing days
        
        method: Enhancement method ('mcmc', 'bayesian-complex', 'trend-aware', 'robust')
    
    Returns:
        EnhancedAggregation dict with enhanced mean, stdev, confidence_interval, trend, etc.
    """
    
    if method == 'mcmc':
        return _enhance_mcmc(raw_data)
    elif method == 'bayesian-complex' or method == 'bayesian':
        return _enhance_bayesian_complex(raw_data)
    elif method == 'trend-aware':
        return _enhance_trend_aware(raw_data)
    elif method == 'robust':
        return _enhance_robust(raw_data)
    else:
        raise ValueError(f"Unknown enhancement method: {method}")


def _enhance_mcmc(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    MCMC sampling for Bayesian inference.
    
    Uses PyMC or similar for MCMC sampling to estimate posterior distribution.
    For now, uses beta distribution (Bayesian conjugate prior).
    """
    if not HAS_SCIPY:
        raise ImportError("scipy is required for MCMC enhancement. Install with: pip install scipy")
    
    n = raw_data['n']
    k = raw_data['k']
    
    if n == 0:
        return {
            'method': 'mcmc',
            'n': n,
            'k': k,
            'mean': 0,
            'stdev': 0,
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'mcmc',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Use beta distribution for binomial proportion (Bayesian conjugate prior)
    # Beta(alpha=1, beta=1) is uniform prior, Beta(alpha=k+1, beta=n-k+1) is posterior
    alpha = k + 1
    beta = n - k + 1
    
    # Calculate mean (mode of beta distribution) and round to 3 decimal places
    mean = round(alpha / (alpha + beta), 3)
    
    # Calculate standard deviation
    variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1))
    stdev = math.sqrt(variance)
    
    # 95% confidence interval, rounded to 3 decimal places
    ci_lower, ci_upper = stats.beta.interval(0.95, alpha, beta)
    
    return {
        'method': 'mcmc',
        'n': n,
        'k': k,
        'mean': float(mean),
        'stdev': float(stdev),
        'confidence_interval': [round(float(ci_lower), 3), round(float(ci_upper), 3)],
        'trend': None,
        'metadata': {
            'raw_method': raw_data['method'],
            'enhancement_method': 'mcmc',
            'data_points': raw_data['days_included'],
        }
    }


def _enhance_bayesian_complex(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Complex Bayesian inference with custom priors and hierarchical models.
    
    TODO: Implement hierarchical Bayesian model with:
    - Prior on conversion rate
    - Day-to-day variation modeling
    - Trend detection
    """
    # For now, same as MCMC (will be enhanced later)
    return _enhance_mcmc(raw_data)


def _enhance_trend_aware(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Trend-aware enhancement using linear regression or ML.
    
    Detects trends in daily data and adjusts mean accordingly.
    """
    if not HAS_SCIPY:
        raise ImportError("scipy is required for trend-aware enhancement. Install with: pip install scipy")
    
    daily_data = raw_data.get('raw_data', [])
    
    if len(daily_data) < 2:
        # Not enough data for trend detection
        return {
            'method': 'trend-aware',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'trend-aware',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Extract daily probabilities
    p_values = [point['p'] for point in daily_data if point['n'] > 0]
    days = list(range(len(p_values)))
    
    if len(p_values) < 2:
        return {
            'method': 'trend-aware',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'trend-aware',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Linear regression to detect trend
    slope, intercept, r_value, p_value, std_err = stats.linregress(days, p_values)
    
    # Determine trend direction
    if abs(slope) < 0.001:  # Essentially flat
        direction = 'stable'
    elif slope > 0:
        direction = 'increasing'
    else:
        direction = 'decreasing'
    
    # Use trend-adjusted mean (project forward or use weighted average)
    # For now, use simple weighted average favoring recent days
    weights = np.linspace(0.5, 1.0, len(p_values))  # More weight to recent
    trend_adjusted_mean = round(np.average(p_values, weights=weights), 3)
    
    # Recalculate k from trend-adjusted mean
    trend_adjusted_k = int(round(trend_adjusted_mean * raw_data['n']))
    
    return {
        'method': 'trend-aware',
        'n': raw_data['n'],
        'k': trend_adjusted_k,
        'mean': float(trend_adjusted_mean),
        'stdev': raw_data['stdev'],  # Keep original stdev
        'confidence_interval': None,
        'trend': {
            'direction': direction,
            'slope': float(slope),
            'significance': float(p_value),  # p-value for trend significance
        },
        'metadata': {
            'raw_method': raw_data['method'],
            'enhancement_method': 'trend-aware',
            'data_points': raw_data['days_included'],
        }
    }


def _enhance_robust(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Robust statistics with outlier detection and resistance.
    
    Uses median-based methods and outlier removal.
    """
    if not HAS_SCIPY:
        raise ImportError("numpy is required for robust enhancement. Install with: pip install numpy")
    
    daily_data = raw_data.get('raw_data', [])
    
    if len(daily_data) == 0:
        return {
            'method': 'robust',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'robust',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Extract daily probabilities
    p_values = np.array([point['p'] for point in daily_data if point['n'] > 0])
    
    if len(p_values) == 0:
        return {
            'method': 'robust',
            'n': raw_data['n'],
            'k': raw_data['k'],
            'mean': raw_data['mean'],
            'stdev': raw_data['stdev'],
            'confidence_interval': None,
            'trend': None,
            'metadata': {
                'raw_method': raw_data['method'],
                'enhancement_method': 'robust',
                'data_points': raw_data['days_included'],
            }
        }
    
    # Use median as robust estimator (less sensitive to outliers), rounded to 3 decimal places
    robust_mean = round(float(np.median(p_values)), 3)
    
    # Use IQR-based standard deviation (more robust than sample std)
    q1, q3 = np.percentile(p_values, [25, 75])
    iqr = q3 - q1
    robust_stdev = float(iqr / 1.35)  # IQR to std approximation for normal-like distributions
    
    # Recalculate k from robust mean
    robust_k = int(round(robust_mean * raw_data['n']))
    
    return {
        'method': 'robust',
        'n': raw_data['n'],
        'k': robust_k,
        'mean': float(robust_mean),
        'stdev': robust_stdev,
        'confidence_interval': None,
        'trend': None,
        'metadata': {
            'raw_method': raw_data['method'],
            'enhancement_method': 'robust',
            'data_points': raw_data['days_included'],
        }
    }

