import React from 'react';
import * as Menubar from '@radix-ui/react-menubar';
import { useAutoUpdateCharts } from '../../hooks/useAutoUpdateCharts';

/**
 * Menu access-point only: renders the auto-update toggle using the same visual pattern as other
 * boolean toggles in DataMenu (Menubar.Item with leading "✓ ").
 */
export function AutoUpdateChartsMenubarItem(): JSX.Element {
  const { policy, setEnabled } = useAutoUpdateCharts();

  const enabled = Boolean(policy?.enabled);
  const forced = Boolean(policy?.forced);

  return (
    <Menubar.Item
      className="menubar-item"
      disabled={forced}
      onSelect={() => void setEnabled(!enabled)}
    >
      {enabled ? '✓ ' : ''}Auto-update charts{forced ? ' (forced)' : ''}
    </Menubar.Item>
  );
}






