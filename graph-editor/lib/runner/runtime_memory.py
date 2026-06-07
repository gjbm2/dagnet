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
