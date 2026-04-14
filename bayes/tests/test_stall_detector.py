"""Tests for ChainStallDetector — EMA-based MCMC chain stall detection.

Tests use synthetic draw sequences with controlled timing.  No MCMC,
no JAX, no model compilation — pure detection logic.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from compiler.inference import ChainStallDetector


def _simulate(detector: ChainStallDetector, chain: int,
              draws_sequence: list[int], dt: float = 0.5) -> dict | None:
    """Feed a sequence of cumulative draw counts to the detector.

    Returns the first stall info dict, or None if no stall detected.
    """
    t = 0.0
    for draws in draws_sequence:
        result = detector.update(chain, draws, t)
        if result is not None:
            return result
        t += dt
    return None


def _ramp_then_stall(cruising_rate: float, stall_rate: float,
                     ramp_steps: int = 40, stall_steps: int = 120,
                     dt: float = 0.5) -> list[int]:
    """Generate a draw sequence: ramp up to cruising speed, then stall.

    Returns cumulative draw counts at each timestep.
    """
    draws = []
    total = 0
    for i in range(ramp_steps):
        # Ramp: linearly increase from 0 to cruising_rate
        rate = cruising_rate * (i + 1) / ramp_steps
        total += rate * dt
        draws.append(int(total))
    for _ in range(stall_steps):
        total += stall_rate * dt
        draws.append(int(total))
    return draws


def _steady(rate: float, steps: int = 100, dt: float = 0.5) -> list[int]:
    """Generate a steady draw sequence at constant rate."""
    draws = []
    total = 0
    for _ in range(steps):
        total += rate * dt
        draws.append(int(total))
    return draws


class TestHealthyRun:
    """No stall should fire when all chains run normally."""

    def test_steady_chains(self):
        d = ChainStallDetector(grace_s=30.0)
        seq = _steady(rate=50.0, steps=200)
        assert _simulate(d, 0, seq) is None

    def test_two_chains_different_speeds(self):
        """Chains at different but stable speeds — not a stall."""
        d = ChainStallDetector(grace_s=30.0)
        # Chain 0 at 50 draws/s, chain 1 at 30 draws/s
        t = 0.0
        for i in range(200):
            d.update(0, int(50 * t), t)
            d.update(1, int(30 * t), t)
            t += 0.5
        # Neither should stall — both are at steady velocity
        # (chain 1 is slower but hasn't collapsed from its own peak)


class TestStallDetection:
    """Stall should fire when a chain's velocity collapses."""

    def test_basic_stall(self):
        d = ChainStallDetector(grace_s=5.0, min_peak=3.0)  # short grace for test speed
        seq = _ramp_then_stall(cruising_rate=50.0, stall_rate=0.5,
                               ramp_steps=40, stall_steps=60)
        result = _simulate(d, 0, seq)
        assert result is not None
        assert result["chain"] == 0
        assert result["rate"] < 5.0  # well below cruising
        assert result["peak"] > 20.0  # had established a high peak

    def test_stall_reports_correct_chain(self):
        d = ChainStallDetector(grace_s=5.0, min_peak=3.0)
        t = 0.0
        stall_result = None
        for i in range(200):
            # Chain 0: steady
            d.update(0, int(50 * t), t)
            # Chain 1: ramp then stall at step 80
            if i < 40:
                draws1 = int(50 * t)
            elif i < 80:
                draws1 = int(50 * 20 + 50 * (t - 20))  # still cruising
            else:
                draws1 = int(50 * 20 + 50 * 20 + 0.5 * (t - 40))  # crawling
            r = d.update(1, draws1, t)
            if r is not None and stall_result is None:
                stall_result = r
            t += 0.5

        assert stall_result is not None
        assert stall_result["chain"] == 1

    def test_no_stall_during_warmup(self):
        """All chains slow during warmup — no stall because peak not established."""
        d = ChainStallDetector(grace_s=5.0, min_peak=5.0)
        # Both chains crawl at 2 draws/s (below min_peak)
        seq = _steady(rate=2.0, steps=200)
        assert _simulate(d, 0, seq) is None

    def test_grace_period_respected(self):
        """Brief dip and recovery should NOT trigger stall."""
        d = ChainStallDetector(grace_s=30.0, min_peak=3.0)
        draws = []
        total = 0
        # Ramp to cruising
        for i in range(40):
            total += 50 * 0.5 * (i + 1) / 40
            draws.append(int(total))
        # Cruise for a while
        for _ in range(40):
            total += 50 * 0.5
            draws.append(int(total))
        # Brief stall (10s = 20 steps at dt=0.5) — under 30s grace
        for _ in range(20):
            total += 0.5 * 0.5
            draws.append(int(total))
        # Recover
        for _ in range(40):
            total += 50 * 0.5
            draws.append(int(total))
        result = _simulate(d, 0, draws)
        assert result is None

    def test_sustained_stall_triggers(self):
        """Stall lasting longer than grace period should trigger."""
        d = ChainStallDetector(grace_s=10.0, min_peak=3.0)
        draws = []
        total = 0
        # Ramp + cruise
        for i in range(40):
            total += 50 * 0.5 * (i + 1) / 40
            draws.append(int(total))
        for _ in range(40):
            total += 50 * 0.5
            draws.append(int(total))
        # Sustained stall (40s = 80 steps at dt=0.5) — over 10s grace
        for _ in range(80):
            total += 0.3 * 0.5
            draws.append(int(total))
        result = _simulate(d, 0, draws)
        assert result is not None

    def test_hysteresis_prevents_hair_trigger(self):
        """Small wobbles within crawl speed should NOT reset the timer."""
        d = ChainStallDetector(grace_s=10.0, min_peak=3.0)
        draws = []
        total = 0
        # Ramp + cruise
        for i in range(40):
            total += 50 * 0.5 * (i + 1) / 40
            draws.append(int(total))
        for _ in range(30):
            total += 50 * 0.5
            draws.append(int(total))
        # Stall with small wobbles — rate oscillates between 0.5 and 3 draws/s
        # (3/50 = 6% of peak, still below 10% trigger, well below 30% recovery)
        import math
        for i in range(80):
            wobble_rate = 1.5 + 1.5 * math.sin(i * 0.3)  # 0 to 3 draws/s
            total += wobble_rate * 0.5
            draws.append(int(total))
        result = _simulate(d, 0, draws)
        assert result is not None  # wobbles should NOT prevent stall detection


class TestEdgeCases:

    def test_single_chain(self):
        """Single chain can still stall (no comparison needed)."""
        d = ChainStallDetector(grace_s=5.0, min_peak=3.0)
        seq = _ramp_then_stall(cruising_rate=50.0, stall_rate=0.2,
                               ramp_steps=30, stall_steps=60)
        result = _simulate(d, 0, seq)
        assert result is not None

    def test_zero_draws_stall(self):
        """Chain that completely stops (0 draws/s)."""
        d = ChainStallDetector(grace_s=5.0, min_peak=3.0)
        seq = _ramp_then_stall(cruising_rate=50.0, stall_rate=0.0,
                               ramp_steps=30, stall_steps=60)
        result = _simulate(d, 0, seq)
        assert result is not None
        assert result["rate"] < 1.0

    def test_very_slow_model_no_false_positive(self):
        """A genuinely slow model (3 draws/s steady) should not trigger."""
        d = ChainStallDetector(grace_s=30.0, min_peak=5.0)
        seq = _steady(rate=3.0, steps=200)
        assert _simulate(d, 0, seq) is None

    def test_gradual_slowdown_no_false_positive(self):
        """Chain gradually slowing (not a sandbank crash) — depends on degree."""
        d = ChainStallDetector(grace_s=10.0, min_peak=3.0)
        draws = []
        total = 0
        # Ramp to 50
        for i in range(40):
            total += 50 * 0.5 * (i + 1) / 40
            draws.append(int(total))
        # Gradually slow from 50 to 30 over 100 steps — this is normal fluctuation
        for i in range(100):
            rate = 50 - 20 * (i / 100)
            total += rate * 0.5
            draws.append(int(total))
        result = _simulate(d, 0, draws)
        assert result is None  # 30/50 = 60% of peak, well above trigger


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
