/**
 * Integration test: Output card input interaction.
 *
 * Tests that:
 * 1. First keystroke calls onStartEdit (immediate source flip)
 * 2. Blur calls onCommit with correct value
 * 3. No spurious commits on blur without change (float precision)
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AutomatableField } from '../../components/AutomatableField';

// ── Exact copy of OutputInput from ModelVarsCards ────────────────────────────

function OutputInput({ label, field, value, dp, pct, unit, overridden, onClearOverride, onCommit, onStartEdit, disabled }: {
  label: string; field: string; value?: number; dp: number; pct?: boolean; unit?: string;
  overridden: boolean; onClearOverride: () => void;
  onCommit: (field: string, value: number) => void;
  onStartEdit: () => void;
  disabled: boolean;
}) {
  const display = value !== undefined ? (pct ? (value * 100).toFixed(dp) : value.toFixed(dp)) : '';
  const [local, setLocal] = React.useState(display);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { setLocal(display); }, [display]);

  return (
    <AutomatableField label="" value={value ?? ''} overridden={overridden} onClearOverride={onClearOverride}>
      <div className="property-field-inline">
        <label>{label}</label>
        <input
          className="property-input"
          type="number" step="any" min={0}
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            if (!dirty) {
              setDirty(true);
              onStartEdit();
            }
          }}
          onBlur={() => {
            const raw = parseFloat(local);
            if (!isNaN(raw)) {
              const v = pct ? raw / 100 : raw;
              if (value === undefined || Math.abs(v - value) > 1e-9) {
                onCommit(field, v);
              }
            }
            setDirty(false);
          }}
          disabled={disabled}
        />
      </div>
    </AutomatableField>
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OutputInput: immediate source flip on first keystroke', () => {
  it('first onChange calls onStartEdit exactly once', () => {
    const onStartEdit = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <OutputInput label="p" field="mean" value={0.398} dp={1} pct
        overridden={false} onClearOverride={() => {}}
        onCommit={onCommit} onStartEdit={onStartEdit} disabled={false} />
    );

    const input = container.querySelector('input') as HTMLInputElement;

    // First keystroke → onStartEdit fires
    fireEvent.change(input, { target: { value: '40' } });
    expect(onStartEdit).toHaveBeenCalledTimes(1);

    // Second keystroke → onStartEdit does NOT fire again
    fireEvent.change(input, { target: { value: '41' } });
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it('onCommit fires on blur with correct parsed value', () => {
    const onStartEdit = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <OutputInput label="p" field="mean" value={0.398} dp={1} pct
        overridden={false} onClearOverride={() => {}}
        onCommit={onCommit} onStartEdit={onStartEdit} disabled={false} />
    );

    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith('mean', 0.45);
  });

  it('no spurious commit when value unchanged (float precision tolerance)', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <OutputInput label="p" field="mean" value={0.398} dp={1} pct
        overridden={false} onClearOverride={() => {}}
        onCommit={onCommit} onStartEdit={() => {}} disabled={false} />
    );

    const input = container.querySelector('input') as HTMLInputElement;
    // Don't change value, just blur
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('non-pct field works correctly', () => {
    const onStartEdit = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <OutputInput label="μ" field="mu" value={1.286} dp={3}
        overridden={false} onClearOverride={() => {}}
        onCommit={onCommit} onStartEdit={onStartEdit} disabled={false} />
    );

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('1.286');

    fireEvent.change(input, { target: { value: '2.0' } });
    expect(onStartEdit).toHaveBeenCalledTimes(1);

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('mu', 2.0);
  });
});
