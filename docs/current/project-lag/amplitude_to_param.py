#!/usr/bin/env python3
"""
Transform Amplitude funnel API response into DAGNet parameter file format.

Usage:
    python amplitude_to_param.py <amplitude_response.json> <step_index> [--output param.yaml]

Where step_index is the edge you want (1 = first edge X→Y in a 2-step funnel)

Handles two Amplitude response formats:
  - Format A (3-step funnel): has stepCounts, dayCounts arrays
  - Format B (2-step funnel): has dayFunnels.series, dayFunnels.xValues
"""

import json
import argparse
from datetime import datetime
from pathlib import Path
import yaml


MS_PER_DAY = 1000 * 60 * 60 * 24


def ms_to_days(ms: float) -> float:
    """Convert milliseconds to days, rounded to 1 decimal place."""
    if ms is None or ms < 0:
        return None
    return round(ms / MS_PER_DAY, 1)


def format_date(date_str: str) -> str:
    """Convert YYYY-MM-DD to d-MMM-yy format (e.g., 1-Sep-25)."""
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.strftime('%-d-%b-%y')  # %-d removes leading zero on day
    except (ValueError, TypeError):
        return date_str  # Return as-is if parsing fails


def detect_format(amplitude_data: dict) -> str:
    """Detect which Amplitude response format we have."""
    if 'stepCounts' in amplitude_data:
        return 'format_a'  # 3-step style with stepCounts array
    elif 'dayFunnels' in amplitude_data:
        return 'format_b'  # 2-step style with dayFunnels dict
    else:
        raise ValueError("Unknown Amplitude response format")


def extract_edge_data_format_a(amplitude_data: dict, step_index: int) -> dict:
    """Extract from Format A (3-step funnel with stepCounts/dayCounts)."""
    step_counts = amplitude_data.get('stepCounts', [])
    n = step_counts[step_index - 1] if step_index > 0 else step_counts[0]
    k = step_counts[step_index] if step_index < len(step_counts) else 0
    
    day_counts = amplitude_data.get('dayCounts', [])
    dates = []
    n_daily = []
    k_daily = []
    
    for day_entry in day_counts:
        date_str = day_entry.get('date', '')
        step_counts_daily = day_entry.get('stepCounts', [])
        
        dates.append(date_str)
        n_daily.append(step_counts_daily[step_index - 1] if step_index > 0 else step_counts_daily[0])
        k_daily.append(step_counts_daily[step_index] if step_index < len(step_counts_daily) else 0)
    
    # Per-cohort median and mean lag times
    day_median_trans = amplitude_data.get('dayMedianTransTimes', {})
    day_avg_trans = amplitude_data.get('dayAvgTransTimes', {})
    median_series = day_median_trans.get('series', [])
    avg_series = day_avg_trans.get('series', [])
    
    median_lag_days = []
    mean_lag_days = []
    for i in range(len(median_series)):
        if step_index < len(median_series[i]):
            median_lag_days.append(ms_to_days(median_series[i][step_index]))
        else:
            median_lag_days.append(None)
        
        if i < len(avg_series) and step_index < len(avg_series[i]):
            mean_lag_days.append(ms_to_days(avg_series[i][step_index]))
        else:
            mean_lag_days.append(None)
    
    # Histogram
    histogram_bins = extract_histogram(amplitude_data, step_index)
    
    # Overall median and mean
    median_trans_times = amplitude_data.get('medianTransTimes', [])
    avg_trans_times = amplitude_data.get('avgTransTimes', [])
    overall_median_days = None
    overall_mean_days = None
    if step_index < len(median_trans_times) and median_trans_times[step_index]:
        overall_median_days = ms_to_days(median_trans_times[step_index])
    if step_index < len(avg_trans_times) and avg_trans_times[step_index]:
        overall_mean_days = ms_to_days(avg_trans_times[step_index])
    
    return {
        'n': n,
        'k': k,
        'dates': dates,
        'n_daily': n_daily,
        'k_daily': k_daily,
        'median_lag_days': median_lag_days,
        'mean_lag_days': mean_lag_days,
        'histogram_bins': histogram_bins['bins'],
        'total_converters': histogram_bins['total'],
        'overall_median_days': overall_median_days,
        'overall_mean_days': overall_mean_days,
    }


def extract_edge_data_format_b(amplitude_data: dict, step_index: int) -> dict:
    """Extract from Format B (2-step funnel with dayFunnels)."""
    day_funnels = amplitude_data.get('dayFunnels', {})
    dates = day_funnels.get('xValues', [])
    series = day_funnels.get('series', [])  # Each entry is [n, k] for that day
    
    n_daily = []
    k_daily = []
    
    for day_data in series:
        # day_data is [step0_count, step1_count, ...]
        n_daily.append(day_data[step_index - 1] if step_index > 0 and len(day_data) > step_index - 1 else 0)
        k_daily.append(day_data[step_index] if len(day_data) > step_index else 0)
    
    n = sum(n_daily)
    k = sum(k_daily)
    
    # Per-cohort median and mean lag times
    day_median_trans = amplitude_data.get('dayMedianTransTimes', {})
    day_avg_trans = amplitude_data.get('dayAvgTransTimes', {})
    median_series = day_median_trans.get('series', [])
    avg_series = day_avg_trans.get('series', [])
    
    median_lag_days = []
    mean_lag_days = []
    for i in range(len(median_series)):
        # median_series[i] is [median_to_step0, median_to_step1, ...]
        # For step_index=1, we want median_to_step1 (which is the lag for edge 0→1)
        if step_index < len(median_series[i]):
            median_lag_days.append(ms_to_days(median_series[i][step_index]))
        else:
            median_lag_days.append(None)
        
        if i < len(avg_series) and step_index < len(avg_series[i]):
            mean_lag_days.append(ms_to_days(avg_series[i][step_index]))
        else:
            mean_lag_days.append(None)
    
    # Histogram
    histogram_bins = extract_histogram(amplitude_data, step_index)
    
    # Overall median and mean
    median_trans_times = amplitude_data.get('medianTransTimes', [])
    avg_trans_times = amplitude_data.get('avgTransTimes', [])
    overall_median_days = None
    overall_mean_days = None
    if step_index < len(median_trans_times) and median_trans_times[step_index]:
        overall_median_days = ms_to_days(median_trans_times[step_index])
    if step_index < len(avg_trans_times) and avg_trans_times[step_index]:
        overall_mean_days = ms_to_days(avg_trans_times[step_index])
    
    return {
        'n': n,
        'k': k,
        'dates': dates,
        'n_daily': n_daily,
        'k_daily': k_daily,
        'median_lag_days': median_lag_days,
        'mean_lag_days': mean_lag_days,
        'histogram_bins': histogram_bins['bins'],
        'total_converters': histogram_bins['total'],
        'overall_median_days': overall_median_days,
        'overall_mean_days': overall_mean_days,
    }


def extract_histogram(amplitude_data: dict, step_index: int) -> dict:
    """
    Extract lag histogram from stepTransTimeDistribution, consolidated to whole days.
    
    Amplitude provides hourly bins up to ~10 days, then a catch-all bucket.
    We consolidate to:
      - Days 0-10: one bin per whole day (floor of start_ms)
      - Day 10+: single "10+" catch-all bucket
    
    Note: For edges with median lag >10 days, the histogram tail is unreliable.
    Use medianTransTimes as the primary lag estimate in those cases.
    See design.md Appendix A.1 for details.
    """
    step_trans_dist = amplitude_data.get('stepTransTimeDistribution', {})
    step_bins_list = step_trans_dist.get('step_bins', [])
    
    # Accumulate counts by whole day (0-10) plus a 10+ bucket
    day_counts = {}  # day (int 0-10) -> count
    tail_count = 0   # everything >= 10 days
    tail_max_day = 10  # will track the actual max day in tail
    total_converters = 0
    
    if step_index < len(step_bins_list):
        step_bin_data = step_bins_list[step_index]
        raw_bins = step_bin_data.get('bins', [])
        
        for bin_entry in raw_bins:
            start_ms = bin_entry.get('start', 0)
            end_ms = bin_entry.get('end', 0)
            bin_dist = bin_entry.get('bin_dist', {})
            count = bin_dist.get('uniques', 0)
            
            if count > 0:
                total_converters += count
                start_days = start_ms / MS_PER_DAY
                end_days = end_ms / MS_PER_DAY
                
                if start_days >= 10:
                    # Everything 10+ goes into tail
                    tail_count += count
                    tail_max_day = max(tail_max_day, end_days)
                else:
                    # Assign to whole day bucket (floor)
                    day_key = int(start_days)
                    day_counts[day_key] = day_counts.get(day_key, 0) + count
    
    # Build output bins
    histogram_bins = []
    for day in sorted(day_counts.keys()):
        histogram_bins.append({'day': day, 'count': day_counts[day]})
    
    # Add tail bucket if any
    if tail_count > 0:
        histogram_bins.append({
            'day_range': [10, int(tail_max_day)],
            'count': tail_count
        })
    
    return {'bins': histogram_bins, 'total': total_converters}


def extract_upstream_lag(amplitude_data: dict, step_index: int) -> dict:
    """
    Extract upstream lag data (all steps before step_index).
    
    For a 3-step funnel A→X→Y where we want X→Y (step_index=2),
    this extracts the A→X lag data (step_index=1) for convolution.
    
    Returns dict with:
      - upstream_median_days: overall median for upstream edge
      - upstream_mean_days: overall mean for upstream edge
      - upstream_histogram: lag histogram for upstream edge
      - upstream_events: list of upstream event names
      - anchor_n_daily: per-cohort anchor entries (users entering A)
      - anchor_median_lag_daily: per-cohort A→X median lag
      - anchor_mean_lag_daily: per-cohort A→X mean lag
    """
    if step_index <= 1:
        # No upstream for first edge
        return None
    
    # Get upstream step (the one immediately before our edge)
    upstream_step = step_index - 1
    
    # Extract histogram for upstream step
    upstream_histogram = extract_histogram(amplitude_data, upstream_step)
    
    # Get upstream median and mean (overall)
    median_trans_times = amplitude_data.get('medianTransTimes', [])
    avg_trans_times = amplitude_data.get('avgTransTimes', [])
    upstream_median_days = None
    upstream_mean_days = None
    if upstream_step < len(median_trans_times) and median_trans_times[upstream_step]:
        upstream_median_days = ms_to_days(median_trans_times[upstream_step])
    if upstream_step < len(avg_trans_times) and avg_trans_times[upstream_step]:
        upstream_mean_days = ms_to_days(avg_trans_times[upstream_step])
    
    # Get event names for context
    events = amplitude_data.get('events', [])
    upstream_events = events[:step_index] if events else []
    
    # Get per-cohort anchor data (users entering step 0, i.e., A)
    # and per-cohort A→X lag times
    anchor_n_daily = []
    anchor_median_lag_daily = []
    anchor_mean_lag_daily = []
    
    # dayFunnels.series[i] = [step0_count, step1_count, ...]
    day_funnels = amplitude_data.get('dayFunnels', {})
    series = day_funnels.get('series', [])
    
    # dayMedianTransTimes.series[i] = [median_to_step0, median_to_step1, ...]
    day_median_trans = amplitude_data.get('dayMedianTransTimes', {})
    median_series = day_median_trans.get('series', [])
    
    # dayAvgTransTimes.series[i] = [avg_to_step0, avg_to_step1, ...]
    day_avg_trans = amplitude_data.get('dayAvgTransTimes', {})
    avg_series = day_avg_trans.get('series', [])
    
    for i in range(len(series)):
        # Anchor n = step 0 count
        anchor_n_daily.append(series[i][0] if len(series[i]) > 0 else 0)
        
        # A→X median lag (upstream_step = 1 for A→X)
        if i < len(median_series) and upstream_step < len(median_series[i]):
            anchor_median_lag_daily.append(ms_to_days(median_series[i][upstream_step]))
        else:
            anchor_median_lag_daily.append(None)
        
        # A→X mean lag
        if i < len(avg_series) and upstream_step < len(avg_series[i]):
            anchor_mean_lag_daily.append(ms_to_days(avg_series[i][upstream_step]))
        else:
            anchor_mean_lag_daily.append(None)
    
    return {
        'upstream_median_days': upstream_median_days,
        'upstream_mean_days': upstream_mean_days,
        'upstream_histogram': upstream_histogram,
        'upstream_events': upstream_events,
        'anchor_n_daily': anchor_n_daily,
        'anchor_median_lag_daily': anchor_median_lag_daily,
        'anchor_mean_lag_daily': anchor_mean_lag_daily,
    }


def extract_edge_data(amplitude_data: dict, step_index: int) -> dict:
    """Extract edge-level data from Amplitude funnel response (auto-detect format)."""
    fmt = detect_format(amplitude_data)
    if fmt == 'format_a':
        edge_data = extract_edge_data_format_a(amplitude_data, step_index)
    else:
        edge_data = extract_edge_data_format_b(amplitude_data, step_index)
    
    # Also extract upstream lag data for convolution (if multi-step)
    upstream = extract_upstream_lag(amplitude_data, step_index)
    if upstream:
        edge_data['upstream_lag'] = upstream
    
    return edge_data


def build_param_file(
    edge_data: dict,
    edge_id: str,
    edge_name: str,
    description: str,
    maturity_days: int = 30,
    query_date: str = None,
    anchor_node_id: str = None,
    conversion_window_days: int = 45,
) -> dict:
    """Build a complete parameter file structure from extracted edge data."""
    dates = edge_data['dates']
    
    if not query_date:
        query_date = datetime.now().strftime('%Y-%m-%d')
    
    cohort_start = min(dates) if dates else query_date
    cohort_end = max(dates) if dates else query_date
    
    # Calculate completeness
    completeness = 0
    if dates and edge_data['overall_median_days']:
        query_dt = datetime.strptime(query_date, '%Y-%m-%d')
        mature_weight = 0
        total_weight = 0
        median_days = edge_data['overall_median_days']
        
        for i, date_str in enumerate(dates):
            cohort_dt = datetime.strptime(date_str, '%Y-%m-%d')
            age_days = (query_dt - cohort_dt).days
            n_i = edge_data['n_daily'][i]
            
            progress = min(1.0, age_days / median_days) if median_days > 0 else 1.0
            mature_weight += n_i * progress
            total_weight += n_i
        
        completeness = round(mature_weight / total_weight, 2) if total_weight > 0 else 0
    
    # Build per-cohort data rows
    cohort_data = []
    has_anchor = 'upstream_lag' in edge_data and 'anchor_median_lag_daily' in edge_data.get('upstream_lag', {})
    
    for i, date_str in enumerate(dates):
        # Convert date to d-MMM-yy format
        formatted_date = format_date(date_str)
        row = {'date': formatted_date}
        
        # Anchor data (if available from multi-step funnel)
        # anchor_n = users who entered A on this date (useful for convolution weighting)
        # anchor lags = how long it took them to reach X (for distribution fitting)
        if has_anchor:
            upstream = edge_data['upstream_lag']
            row['anchor_n'] = upstream['anchor_n_daily'][i] if i < len(upstream.get('anchor_n_daily', [])) else None
            row['anchor_median_lag'] = upstream['anchor_median_lag_daily'][i] if i < len(upstream.get('anchor_median_lag_daily', [])) else None
            row['anchor_mean_lag'] = upstream['anchor_mean_lag_daily'][i] if i < len(upstream.get('anchor_mean_lag_daily', [])) else None
        
        # Edge data
        row['n'] = edge_data['n_daily'][i] if i < len(edge_data['n_daily']) else None
        row['k'] = edge_data['k_daily'][i] if i < len(edge_data['k_daily']) else None
        row['median_lag'] = edge_data['median_lag_days'][i] if i < len(edge_data.get('median_lag_days', [])) else None
        row['mean_lag'] = edge_data['mean_lag_days'][i] if i < len(edge_data.get('mean_lag_days', [])) else None
        
        cohort_data.append(row)
    
    # Build totals (simple n/k for this edge)
    totals = {
        'n': edge_data['n'],
        'k': edge_data['k'],
    }
    
    # Format dates for label
    cohort_start_fmt = format_date(cohort_start)
    cohort_end_fmt = format_date(cohort_end)
    query_date_fmt = format_date(query_date)
    
    # Build value entry
    value_entry = {
        'label': f"Cohorts {cohort_start_fmt} to {cohort_end_fmt}",
        'query_date': query_date_fmt,
        'conversion_window_days': conversion_window_days,
        'totals': totals,
        'latency': {
            'median_days': edge_data['overall_median_days'],
            'mean_days': edge_data.get('overall_mean_days'),
            'completeness': completeness,
            'histogram': {
                'total_converters': edge_data['total_converters'],
                'bins': edge_data['histogram_bins'],
            },
        },
        'cohort_data': cohort_data,
    }
    
    # Add anchor latency if available
    if 'upstream_lag' in edge_data:
        upstream = edge_data['upstream_lag']
        value_entry['anchor_latency'] = {
            'median_days': upstream['upstream_median_days'],
            'mean_days': upstream['upstream_mean_days'],
            'histogram': {
                'total_converters': upstream['upstream_histogram']['total'],
                'bins': upstream['upstream_histogram']['bins'],
            },
        }
    
    # Build param structure
    param = {
        'id': edge_id,
        'name': edge_name,
        'type': 'probability',
        'source': 'amplitude:funnel',
        'description': description,
        'latency': {
            'track': True,
            'maturity_days': maturity_days,
        },
    }
    
    # Add anchor node reference if provided
    if anchor_node_id:
        param['anchor'] = {
            'node_id': anchor_node_id,
            'description': 'Graph node used as cohort anchor (resolved to event at query time)',
        }
    
    param['values'] = [value_entry]
    
    return param


def main():
    parser = argparse.ArgumentParser(
        description='Transform Amplitude funnel response to DAGNet param file'
    )
    parser.add_argument('input_file', help='Amplitude JSON response file')
    parser.add_argument('step_index', type=int, help='Step index (1 = first edge, 2 = second, etc.)')
    parser.add_argument('--output', '-o', help='Output YAML file (default: stdout)')
    parser.add_argument('--edge-id', default='edge-unnamed', help='Edge ID for param file')
    parser.add_argument('--edge-name', default='Unnamed Edge', help='Edge name')
    parser.add_argument('--description', default='Converted from Amplitude funnel data.', help='Description')
    parser.add_argument('--maturity-days', type=int, default=30, help='Maturity threshold in days')
    parser.add_argument('--query-date', help='Query date (default: today)')
    parser.add_argument('--anchor-node-id', help='Graph node_id for cohort anchor (e.g., household-created)')
    parser.add_argument('--conversion-window-days', type=int, default=45, help='Conversion window in days (default: 45)')
    
    args = parser.parse_args()
    
    # Load Amplitude response
    with open(args.input_file, 'r') as f:
        amplitude_response = json.load(f)
    
    data_array = amplitude_response.get('data', [])
    if not data_array:
        print("Error: No 'data' array in Amplitude response")
        return 1
    
    amplitude_data = data_array[0]
    
    # Extract edge data
    edge_data = extract_edge_data(amplitude_data, args.step_index)
    
    # Build param file
    param = build_param_file(
        edge_data=edge_data,
        edge_id=args.edge_id,
        edge_name=args.edge_name,
        description=args.description,
        maturity_days=args.maturity_days,
        query_date=args.query_date,
        anchor_node_id=args.anchor_node_id,
        conversion_window_days=args.conversion_window_days,
    )
    
    # Custom YAML representer for None
    def represent_none(dumper, _):
        return dumper.represent_scalar('tag:yaml.org,2002:null', 'null')
    yaml.add_representer(type(None), represent_none)
    
    # Output
    yaml_output = yaml.dump(param, default_flow_style=False, sort_keys=False, allow_unicode=True)
    
    if args.output:
        with open(args.output, 'w') as f:
            f.write(f"# Auto-generated from {args.input_file}\n")
            f.write(f"# Step index: {args.step_index}\n")
            f.write(f"# Generated: {datetime.now().isoformat()}\n\n")
            f.write(yaml_output)
        print(f"Written to {args.output}")
    else:
        print(yaml_output)
    
    return 0


if __name__ == '__main__':
    exit(main())
