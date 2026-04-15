"""Tests for ChainStallDetector — sustained crawl detection.

The detector should ONLY fire when a chain is genuinely crawling
(< crawl_floor draws/s AND < crawl_ratio of peak) for a sustained
period (grace_s).  It must NOT fire on:
- Brief slow patches that recover
- End-of-run slowdown with draws still progressing at reasonable rates
- Slow-but-steady models
- Finished chains
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from compiler.inference import ChainStallDetector


def _feed(detector: ChainStallDetector, chain: int,
          segments: list[tuple[float, float, float]]) -> dict | None:
    """Feed a sequence of (duration_s, rate_draws_per_s, dt_step) segments.

    Each segment runs for duration_s, producing draws at rate_draws_per_s,
    with updates every dt_step seconds.

    Returns the first stall info dict, or None.
    """
    t = 0.0
    total_draws = 0.0
    for duration, rate, dt in segments:
        steps = int(duration / dt)
        for _ in range(steps):
            total_draws += rate * dt
            result = detector.update(chain, int(total_draws), t)
            if result is not None:
                return result
            t += dt
    return None


class TestNoFalsePositives:
    """These must NEVER trigger a stall."""

    def test_steady_fast(self):
        """Chain cruising at 50 draws/s — no stall."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (120.0, 50.0, 0.5),  # 2 min at 50 draws/s
        ])
        assert result is None

    def test_steady_slow(self):
        """Chain at 8 draws/s — above crawl_floor, no stall."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (120.0, 8.0, 0.5),
        ])
        assert result is None

    def test_brief_dip_and_recovery(self):
        """Cruises at 50, dips to 2 for 10s, recovers. Not a stall."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),   # establish peak
            (10.0, 2.0, 0.5),    # brief dip — under 30s grace
            (60.0, 50.0, 0.5),   # recover
        ])
        assert result is None

    def test_moderate_slowdown(self):
        """Cruises at 50, slows to 20. That's 40% of peak — not crawling."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),
            (60.0, 20.0, 0.5),  # slow but >10% of peak and >crawl_floor
        ])
        assert result is None

    def test_five_draws_per_second(self):
        """Cruises at 50, drops to 5. That's above crawl_floor of 3. Not a stall."""
        d = ChainStallDetector(grace_s=30, crawl_floor=3.0, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),
            (60.0, 5.0, 0.5),
        ])
        assert result is None

    def test_end_of_run_slowdown(self):
        """Rate drops from 50 to 10 near end of run. Still 10 draws/s — fine."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (60.0, 50.0, 0.5),
            (60.0, 10.0, 0.5),  # slower but well above crawl_floor
        ])
        assert result is None

    def test_intermittent_slow(self):
        """Alternates 50 and 2 draws/s every 10s. Never sustained for 30s."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        segments = []
        segments.append((20.0, 50.0, 0.5))  # establish peak
        for _ in range(10):
            segments.append((10.0, 2.0, 0.5))
            segments.append((10.0, 50.0, 0.5))  # recovery resets timer
        result = _feed(d, 0, segments)
        assert result is None


class TestRealStalls:
    """These MUST trigger a stall."""

    def test_sustained_crawl(self):
        """Cruises at 50, drops to 0.5 for 60s. Genuine stall."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),   # establish peak
            (60.0, 0.5, 0.5),    # crawl for 60s — well past 30s grace
        ])
        assert result is not None
        assert result["chain"] == 0
        assert result["rate"] < 3.0

    def test_sustained_near_zero(self):
        """Cruises at 50, drops to 0.1. Classic sandbank."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),
            (60.0, 0.1, 0.5),
        ])
        assert result is not None
        assert result["rate"] < 1.0

    def test_crawl_at_two_draws_per_second(self):
        """Cruises at 50, drops to 2. That's <3 AND <10% of 50. Stall."""
        d = ChainStallDetector(grace_s=30, crawl_floor=3.0, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),
            (60.0, 2.0, 0.5),
        ])
        assert result is not None

    def test_stall_fires_after_grace_not_before(self):
        """Stall should fire at ~30s of crawl, not at 10s."""
        d = ChainStallDetector(grace_s=30, warmup_s=10)
        # Cruise then crawl — check it doesn't fire too early
        t = 0.0
        total = 0.0
        # Establish peak
        for _ in range(60):  # 30s at 0.5s steps
            total += 50 * 0.5
            d.update(0, int(total), t)
            t += 0.5
        # Crawl — should NOT fire in first 25s
        crawl_start = t
        fired_at = None
        for _ in range(200):  # 100s
            total += 0.5 * 0.5
            result = d.update(0, int(total), t)
            if result is not None and fired_at is None:
                fired_at = t - crawl_start
            t += 0.5
        assert fired_at is not None
        assert fired_at >= 29.0, f"Fired too early at {fired_at}s"
        assert fired_at <= 40.0, f"Fired too late at {fired_at}s"

    def test_correct_chain_identified(self):
        """Two chains, only one crawls. Correct chain reported."""
        d = ChainStallDetector(grace_s=10, warmup_s=10)  # short grace for test speed
        t = 0.0
        total0 = 0.0
        total1 = 0.0
        stall_result = None
        for _ in range(200):
            total0 += 50 * 0.5   # chain 0: healthy
            total1 += (50 if t < 15 else 0.5) * 0.5  # chain 1: crawls after 15s
            d.update(0, int(total0), t)
            r = d.update(1, int(total1), t)
            if r is not None and stall_result is None:
                stall_result = r
            t += 0.5
        assert stall_result is not None
        assert stall_result["chain"] == 1


class TestEdgeCases:

    def test_warmup_not_detected(self):
        """During warmup period — no stall even if rate is low."""
        d = ChainStallDetector(grace_s=30, warmup_s=60)
        result = _feed(d, 0, [
            (55.0, 2.0, 0.5),  # 55s — still within warmup_s=60
        ])
        assert result is None

    def test_crawl_floor_both_conditions(self):
        """Rate above crawl_floor but below crawl_ratio — no stall.
        Rate below crawl_floor but above crawl_ratio — no stall.
        Both conditions required."""
        # Above floor (4 draws/s) but below 10% of peak (50 → threshold 5)
        # 4 > 3 (floor) so NOT crawling
        d = ChainStallDetector(grace_s=30, crawl_floor=3.0, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 50.0, 0.5),
            (60.0, 4.0, 0.5),
        ])
        assert result is None

    def test_low_peak_model(self):
        """Peak is 12 draws/s, drops to 2. 2/12=17% > 10% ratio — no stall.
        But 2 < 3 floor. Both conditions must hold: 2 < 3 AND 2 < 1.2 (10% of 12)?
        2 is NOT < 1.2 so not crawling."""
        d = ChainStallDetector(grace_s=30, crawl_floor=3.0, crawl_ratio=0.10, warmup_s=10)
        result = _feed(d, 0, [
            (30.0, 12.0, 0.5),
            (60.0, 2.0, 0.5),
        ])
        # 2 < 3 (floor) ✓, but 2 < 1.2 (10% of 12) ✗ → NOT crawling
        assert result is None


class TestWarmupAndSlowChains:
    """Chains that are slow from the start — detected after warmup_s."""

    def test_slow_from_start_detected_after_warmup(self):
        """Chain at 0.5 draws/s from the start → stall after warmup + grace."""
        d = ChainStallDetector(grace_s=30, warmup_s=60)
        result = _feed(d, 0, [
            (120.0, 0.5, 0.5),  # 2 min at 0.5 draws/s
        ])
        assert result is not None
        assert result["rate"] < 3.0

    def test_slow_from_start_not_detected_during_warmup(self):
        """During warmup_s, even very slow chains are not flagged."""
        d = ChainStallDetector(grace_s=30, warmup_s=60)
        result = _feed(d, 0, [
            (55.0, 0.5, 0.5),  # 55s — still in warmup
        ])
        assert result is None

    def test_multiple_slow_chains_detected(self):
        """Two slow chains, one fast — slow ones detected after warmup."""
        d = ChainStallDetector(grace_s=30, warmup_s=60)
        t = 0.0
        result = None
        for step in range(400):  # 200 seconds
            t += 0.5
            d.update(0, int(50.0 * t), t)   # fast
            d.update(1, int(0.5 * t), t)     # slow
            d.update(2, int(0.6 * t), t)     # slow
            if result is None:
                r1 = d.update(1, int(0.5 * t), t)
                r2 = d.update(2, int(0.6 * t), t)
                result = r1 or r2
        # After warmup (60s) + grace (30s), slow chains should be caught
        assert result is not None

    def test_chain_that_warms_up_late_not_false_positive(self):
        """Chain slow for 50s then accelerates → no stall."""
        d = ChainStallDetector(grace_s=30, warmup_s=60)
        result = _feed(d, 0, [
            (70.0, 0.5, 0.5),   # slow through warmup + 10s
            (60.0, 50.0, 0.5),  # then fast
        ])
        assert result is None


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
