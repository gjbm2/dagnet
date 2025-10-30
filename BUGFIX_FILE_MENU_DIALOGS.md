# Bugfix: File Menu Clear Data Commands Use Custom Modal

## Issue
The File menu's "Clear Data" commands were using browser system modals (`window.confirm()` and `alert()`) instead of the application's custom modal dialog system.

## Changes Made

### File: `graph-editor/src/components/MenuBar/FileMenu.tsx`

**1. Added Dialog Context Import** (Line 5)
```typescript
import { useDialog } from '../../contexts/DialogContext';
```

**2. Added useDialog Hook** (Line 29)
```typescript
const { showConfirm } = useDialog();
```

**3. Updated `handleClearData()` Function** (Lines 290-328)

**Before:**
```typescript
const handleClearData = async () => {
  const confirmed = window.confirm(
    'Clear ALL application data?\n\n' +
    'This will:\n' +
    '- Close all tabs\n' +
    '- Clear all cached files\n' +
    '- Reset layout\n' +
    '- Keep settings intact\n\n' +
    'This action cannot be undone!'
  );
  
  if (!confirmed) return;
  
  try {
    // ... clear logic ...
  } catch (error) {
    alert('Failed to clear data: ' + error);
  }
};
```

**After:**
```typescript
const handleClearData = async () => {
  const confirmed = await showConfirm({
    title: 'Clear Application Data',
    message: 
      'Clear ALL application data?\n\n' +
      'This will:\n' +
      '• Close all tabs\n' +
      '• Clear all cached files\n' +
      '• Reset layout\n' +
      '• Keep settings intact\n\n' +
      'This action cannot be undone!',
    confirmLabel: 'Clear Data',
    cancelLabel: 'Cancel',
    confirmVariant: 'danger'
  });
  
  if (!confirmed) return;
  
  try {
    // ... clear logic ...
  } catch (error) {
    await showConfirm({
      title: 'Error',
      message: `Failed to clear data: ${error}`,
      confirmLabel: 'OK',
      cancelLabel: '',
      confirmVariant: 'primary'
    });
  }
};
```

**4. Updated `handleClearAllData()` Function** (Lines 330-372)

**Before:**
```typescript
const handleClearAllData = async () => {
  const confirmed = window.confirm(
    'Clear ALL application data and settings?\n\n' +
    'This will:\n' +
    '- Close all tabs\n' +
    '- Clear all cached files\n' +
    '- Reset layout and settings\n' +
    '- Clear all user preferences\n\n' +
    'This action cannot be undone!'
  );
  
  if (!confirmed) return;
  
  try {
    // ... clear logic ...
  } catch (error) {
    alert('Failed to clear data: ' + error);
  }
};
```

**After:**
```typescript
const handleClearAllData = async () => {
  const confirmed = await showConfirm({
    title: 'Clear ALL Data and Settings',
    message: 
      'Clear ALL application data and settings?\n\n' +
      'This will:\n' +
      '• Close all tabs\n' +
      '• Clear all cached files\n' +
      '• Reset layout and settings\n' +
      '• Clear all user preferences\n' +
      '• Remove all credentials\n\n' +
      'This action cannot be undone!',
    confirmLabel: 'Clear Everything',
    cancelLabel: 'Cancel',
    confirmVariant: 'danger'
  });
  
  if (!confirmed) return;
  
  try {
    // ... clear logic ...
  } catch (error) {
    await showConfirm({
      title: 'Error',
      message: `Failed to clear data: ${error}`,
      confirmLabel: 'OK',
      cancelLabel: '',
      confirmVariant: 'primary'
    });
  }
};
```

## Improvements

### Visual Consistency
- ✅ Uses application's custom modal dialog system
- ✅ Matches application's design language
- ✅ Professional appearance with proper styling
- ✅ Modal overlays with proper backdrop

### User Experience
- ✅ Better visual hierarchy with clear title and message separation
- ✅ Improved readability with bullet points (• instead of -)
- ✅ More descriptive button labels ("Clear Data" vs just "OK")
- ✅ Proper danger variant styling (red) for destructive actions
- ✅ Error messages displayed in modal instead of browser alert
- ✅ Consistent interaction pattern throughout the app

### Technical Benefits
- ✅ Uses React components instead of blocking browser APIs
- ✅ Non-blocking async/await pattern
- ✅ Testable (can mock dialog responses)
- ✅ Keyboard accessible (auto-focus on confirm button)
- ✅ Click-outside to dismiss
- ✅ No reliance on browser's confirm() which can be disabled

## Dialog Variants

### Clear Data Modal
- **Title**: "Clear Application Data"
- **Variant**: Danger (red button)
- **Confirm**: "Clear Data"
- **Description**: Emphasizes that settings are preserved

### Clear All Data Modal
- **Title**: "Clear ALL Data and Settings"
- **Variant**: Danger (red button)
- **Confirm**: "Clear Everything"
- **Description**: Clearly lists all data that will be removed including credentials

### Error Modal
- **Title**: "Error"
- **Variant**: Primary (blue button)
- **Confirm**: "OK"
- **No Cancel**: Empty string hides cancel button

## Testing

### Manual Testing Steps
1. **Clear Data Command**
   - Go to File > Clear Data
   - ✅ Custom modal appears (not browser confirm)
   - ✅ Modal has title "Clear Application Data"
   - ✅ Confirm button is red and says "Clear Data"
   - ✅ Cancel button works
   - ✅ Click outside modal dismisses it

2. **Clear All Data Command**
   - Go to File > Clear All Data
   - ✅ Custom modal appears (not browser confirm)
   - ✅ Modal has title "Clear ALL Data and Settings"
   - ✅ Confirm button is red and says "Clear Everything"
   - ✅ Credentials removal is mentioned
   - ✅ Cancel button works

3. **Error Handling**
   - If an error occurs (test by causing IDB error)
   - ✅ Error modal appears instead of alert()
   - ✅ Error message is displayed clearly

## Future Enhancements

Other `alert()` and `window.confirm()` calls in FileMenu.tsx that could be updated:
- Line 120: Pull failed alert
- Line 123: Pull error alert
- Line 242: Import file failed alert
- Line 254: No data to download alert
- Line 266: Download failed alert
- Line 276: No data to share alert
- Line 283: Shareable URL copied success message
- Line 286: Failed to create shareable URL alert

These can be replaced with toast notifications or similar custom dialogs in a future update.

