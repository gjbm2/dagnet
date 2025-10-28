import React from 'react';
import { FormEditor } from './editors/FormEditor';

export default function SettingsTab() {
  return <FormEditor fileId="settings-settings" readonly={false} />;
}