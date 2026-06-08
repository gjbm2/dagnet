"""Runtime memory introspection for the cohort-chunk K-solver.

Perimeter utility (not engine math): reads the **actual** memory ceiling of the
container the process runs in, and the memory **currently** resident, so the
selected-cohort projection can size its cohort-chunk count against genuinely
available headroom instead of a hardcoded guess.

Why this lives here and not in ``cohort_forecast_v3.py``: per
``CF_ENGINE_DISCIPLINE.md`` the engine file carries no environment-reading or
defensive I/O. The solver stays pure arithmetic over the two figures this
module supplies; all the OS probing and its fallbacks live here at the
perimeter.

Two figures:

* ``projection_memory_budget_bytes()`` — the absolute peak-RSS ceiling the
  projection must stay under: the detected container memory limit times a
  safety fraction (headroom for allocator fragmentation, the post-projection
  reduce, and Python/NumPy overhead). Overridable for testing/ops.
* ``current_rss_bytes()`` — this process's resident set right now, read fresh
  each call. Captures everything already paid for at the moment the projection
  is about to run: span resolution, earlier per-edge analyses in a whole-graph
  sweep, and accumulated allocator high-water.

The solver's available headroom for the projection is then
``budget - current_rss``.

Environment override (single knob — testing / ops tuning):

* ``DAGNET_COHORT_CHUNK_BUDGET_MB``
    - **unset** → auto: detect the container limit and apply the safety
      fraction (the normal production path).
    - **a positive number** → use exactly that many MiB as the budget,
      bypassing container detection and the safety fraction.
    - **``0`` (or negative)** → no limit: the projection is never chunked
      (the solver always returns one chunk = unbounded).
* ``DAGNET_COHORT_CHUNK_SAFETY_FRACTION`` — fraction of the detected limit to
  treat as the ceiling on the auto path (default ``0.85``).
"""

import os

_MIB = 1024 * 1024
_GIB = 1024 * 1024 * 1024

# Conservative default when the container limit cannot be read (non-Linux dev,
# unusual mounts). 2 GiB matches the Vercel target box; smaller-than-reality is
# the safe direction (it only chunks more aggressively).
_DEFAULT_LIMIT_BYTES = 2 * _GIB

_DEFAULT_SAFETY_FRACTION = 0.85

# cgroup v2 unlimited is the literal string "max"; cgroup v1 unlimited is a huge
# sentinel near INT64_MAX. Anything at or above this is treated as "no container
# limit" and we fall back to physical RAM.
_UNLIMITED_THRESHOLD_BYTES = 1 << 62

# The container memory limit does not change over the process lifetime, so it is
# detected once and cached. The current RSS is always read fresh.
_cached_limit_bytes = None


def _read_int_file(path):
    """Return the integer in a single-value proc/sysfs file, or None."""
    try:
        with open(path) as fh:
            text = fh.read().strip()
    except (OSError, ValueError):
        return None
    if text == 'max':
        return _UNLIMITED_THRESHOLD_BYTES
    try:
        return int(text)
    except ValueError:
        return None


def _parse_float_env(name):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == '':
        return raw, None
    try:
        return raw, float(raw)
    except ValueError:
        return raw, None


def _physical_memory_bytes():
    """Total physical RAM from /proc/meminfo MemTotal (kB), or the default."""
    try:
        with open('/proc/meminfo') as fh:
            for line in fh:
                if line.startswith('MemTotal:'):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return _DEFAULT_LIMIT_BYTES


def _container_memory_limit_bytes():
    """The container/instance memory limit in bytes.

    Resolution order: cgroup v2 → cgroup v1 → AWS Lambda env → physical RAM →
    conservative default. An unlimited cgroup value (``max`` / INT64 sentinel)
    or a limit larger than physical RAM is treated as "no real container cap"
    and resolves to physical RAM.
    """
    candidates = [
        _read_int_file('/sys/fs/cgroup/memory.max'),                  # cgroup v2
        _read_int_file('/sys/fs/cgroup/memory/memory.limit_in_bytes'),  # cgroup v1
    ]
    lambda_mb = os.environ.get('AWS_LAMBDA_FUNCTION_MEMORY_SIZE')
    if lambda_mb:
        try:
            candidates.append(int(lambda_mb) * _MIB)
        except ValueError:
            pass

    physical = _physical_memory_bytes()
    real = [
        c for c in candidates
        if c is not None and 0 < c < _UNLIMITED_THRESHOLD_BYTES
    ]
    # The container cap cannot exceed physical RAM in any meaningful sense; if a
    # reported limit is larger (or absent), physical RAM is the true ceiling.
    real = [min(c, physical) for c in real]
    if real:
        return min(real)
    return physical


def projection_memory_budget_bytes():
    """The peak-RSS ceiling the selected-cohort projection must stay under.

    ``DAGNET_COHORT_CHUNK_BUDGET_MB`` overrides everything: a positive value is
    the absolute budget in MiB; ``0`` (or negative) means "no limit" and returns
    an effectively-infinite budget so the solver never chunks. Unset → detected
    container limit × safety fraction. The safety fraction leaves headroom for
    allocator fragmentation, the post-projection reduce, and interpreter
    overhead — none of which the per-cohort cost model counts.
    """
    global _cached_limit_bytes

    override = os.environ.get('DAGNET_COHORT_CHUNK_BUDGET_MB')
    if override is not None and override.strip() != '':
        try:
            mb = float(override)
        except ValueError:
            mb = None
        if mb is not None:
            if mb <= 0:
                # Explicit "no limit": never chunk.
                return _UNLIMITED_THRESHOLD_BYTES
            return int(mb * _MIB)

    if _cached_limit_bytes is None:
        _cached_limit_bytes = _container_memory_limit_bytes()

    fraction = _DEFAULT_SAFETY_FRACTION
    frac_override = os.environ.get('DAGNET_COHORT_CHUNK_SAFETY_FRACTION')
    if frac_override:
        try:
            fraction = float(frac_override)
        except ValueError:
            pass

    return int(_cached_limit_bytes * fraction)


def _status_memory_bytes(field_name):
    """Read one kB memory field from /proc/self/status as bytes."""
    prefix = f'{field_name}:'
    try:
        with open('/proc/self/status') as fh:
            for line in fh:
                if line.startswith(prefix):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    return 0


def current_rss_bytes():
    """This process's resident set size right now, in bytes.

    Read fresh from /proc/self/statm (resident pages × page size). Returns 0
    when unreadable (non-Linux dev) — which makes the solver assume the whole
    budget is free and therefore chunk less; acceptable on an unconstrained dev
    box, never the case on the Linux container the limit detection targets.
    """
    try:
        with open('/proc/self/statm') as fh:
            resident_pages = int(fh.read().split()[1])
    except (OSError, ValueError, IndexError):
        return 0
    return resident_pages * os.sysconf('SC_PAGE_SIZE')


def current_hwm_bytes():
    """This process's high-water resident set size, in bytes."""
    return _status_memory_bytes('VmHWM')


def memory_budget_diagnostics():
    """Flat diagnostics for the projection memory-budget decision.

    This is telemetry-only perimeter data: raw cgroup/env/proc inputs, the
    resolved detected limit, the final projection budget, and live RSS/HWM. It
    intentionally returns plain scalar fields so callers can print one
    kill-survivable line before a heavy allocation.
    """
    global _cached_limit_bytes

    override_raw, override_mb = _parse_float_env('DAGNET_COHORT_CHUNK_BUDGET_MB')
    fraction_raw, fraction_value = _parse_float_env('DAGNET_COHORT_CHUNK_SAFETY_FRACTION')
    if fraction_value is None:
        fraction_value = _DEFAULT_SAFETY_FRACTION

    cgroup_v2 = _read_int_file('/sys/fs/cgroup/memory.max')
    cgroup_v1 = _read_int_file('/sys/fs/cgroup/memory/memory.limit_in_bytes')
    lambda_raw = os.environ.get('AWS_LAMBDA_FUNCTION_MEMORY_SIZE')
    lambda_bytes = None
    if lambda_raw:
        try:
            lambda_bytes = int(lambda_raw) * _MIB
        except ValueError:
            lambda_bytes = None

    physical = _physical_memory_bytes()
    detected_limit = _cached_limit_bytes
    if detected_limit is None:
        detected_limit = _container_memory_limit_bytes()

    if override_mb is not None:
        if override_mb <= 0:
            budget_source = 'override_unlimited'
        else:
            budget_source = 'override_mb'
    elif override_raw is not None and override_raw.strip() != '':
        budget_source = 'auto_invalid_override'
    else:
        budget_source = 'auto_detected_limit'

    return {
        'budget_source': budget_source,
        'budget_bytes': int(projection_memory_budget_bytes()),
        'detected_limit_bytes': int(detected_limit),
        'safety_fraction': float(fraction_value),
        'safety_fraction_raw': fraction_raw or '',
        'override_mb_raw': override_raw or '',
        'cgroup_v2_memory_max_bytes': int(cgroup_v2 or 0),
        'cgroup_v1_memory_limit_bytes': int(cgroup_v1 or 0),
        'aws_lambda_memory_size_mb': lambda_raw or '',
        'aws_lambda_memory_bytes': int(lambda_bytes or 0),
        'physical_memory_bytes': int(physical),
        'current_rss_bytes': int(current_rss_bytes()),
        'current_hwm_bytes': int(current_hwm_bytes()),
    }
