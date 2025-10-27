# Navigator Panel - Complete Implementation Specification

## Visual Layout

### State 1: Pinned (Default)
```
┌─────────────────────────────────────────────────────────────┐
│ File   Edit   View   Git   Help                             │ Menu Bar (40px)
├──────────────┬──────────────────────────────────────────────┤
│ Navigator ▼  │ [tab1] [tab2] [tab3] [+]                     │ Header + Tabs (44px)
├──────────────┼──────────────────────────────────────────────┤
│              │                                               │
│ Search...    │                                               │
│ Repo: [▼]    │          Tab Content                         │
│ Branch: [▼]  │          (Full height)                       │
│ ───────────  │                                               │
│ ▼ Graphs     │                                               │
│   • graph1   │                                               │
│              │                                               │
└──────────────┴──────────────────────────────────────────────┘
  ↑ 240px       ↑ Remaining width
```

### State 2: Unpinned + Closed
```
┌─────────────────────────────────────────────────────────────┐
│ File   Edit   View   Git   Help                             │
├────┬────────────────────────────────────────────────────────┤
│Nav▶│ [tab1] [tab2] [tab3] [+]                               │ Header + Tabs
├────┴────────────────────────────────────────────────────────┤
│                                                              │
│                  Tab Content (Full Width)                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### State 3: Unpinned + Hovering
```
┌─────────────────────────────────────────────────────────────┐
│ File   Edit   View   Git   Help                             │
├──────────────┬──────────────────────────────────────────────┤
│ Navigator ▼  │ [tab1] [tab2] [tab3] [+]                     │
├──────────────┤                                               │
│╔════════════╗│                                               │
│║ Search...  ║│          Tab Content                         │
│║ Repo: [▼]  ║│          (Overlay on top)                    │
│║ Branch: [▼]║│                                               │
│║ ─────────  ║│                                               │
│║ ▼ Graphs   ║│                                               │
│║   • graph1 ║│                                               │
│╚════════════╝│                                               │
└──────────────┴──────────────────────────────────────────────┘
  ↑ Overlay       ↑ Full width underneath
```

## Key Requirements

1. **Header always inline with tabs** - Same horizontal row
2. **Pinned**: Panel takes layout space (240px), pushes content right
3. **Unpinned + Closed**: Header is small button, content uses full width
4. **Unpinned + Hover**: Panel appears as overlay, content still full width underneath
5. **Click header**: Toggles pinned/unpinned (single action, no separate pin button)
6. **Resizable**: When pinned, can drag to resize

## Implementation Strategy

### HTML Structure
```jsx
<div class="app-shell">
  {/* Menu Bar - 40px */}
  <div class="menu-bar">...</div>
  
  {/* Navigator Header + Tab Bar Row - 44px */}
  <div class="header-row">
    {/* Navigator Header */}
    <div class="nav-header" onClick={togglePinned}>
      {isPinned ? '▼' : '▶'} Navigator
    </div>
    
    {/* rc-dock Tab Bar renders here automatically */}
  </div>
  
  {/* Content Row - flex */}
  <div class="content-row">
    {/* Navigator Panel - when pinned */}
    {isPinned && (
      <div class="nav-panel-pinned" style={{width: navWidth}}>
        <NavigatorContent />
        <ResizeHandle />
      </div>
    )}
    
    {/* Navigator Panel - overlay when unpinned and hovering */}
    {!isPinned && isHovering && (
      <div class="nav-panel-overlay">
        <NavigatorContent />
      </div>
    )}
    
    {/* rc-dock content */}
    <div class="dock-container">
      <DockLayout />
    </div>
  </div>
</div>
```

### CSS Approach
```css
.header-row {
  display: flex;
  height: 44px;
}

.nav-header {
  width: /* if pinned */ 240px /* else */ auto;
  border-right: /* if pinned */ 1px solid #e0e0e0 /* else */ none;
}

.content-row {
  flex: 1;
  display: flex;
}

.nav-panel-pinned {
  width: 240px; /* or custom navWidth */
  border-right: 1px solid #e0e0e0;
  /* Part of layout, pushes dock-container */
}

.nav-panel-overlay {
  position: absolute;
  width: 240px;
  z-index: 1000;
  box-shadow: ...;
  /* Floats over dock-container */
}

.dock-container {
  flex: 1;
  /* Takes remaining space */
}
```

## React State

```typescript
interface NavigatorState {
  isPinned: boolean;  // true = part of layout, false = overlay on hover
  navWidth: number;   // When pinned, allows resizing (180-400px)
}
```

## Interaction Logic

### Click Header
```typescript
const handleHeaderClick = () => {
  setIsPinned(!isPinned);
  // If unpinning, also close it
  // If pinning, open it
};
```

### Hover Behavior (when unpinned)
```typescript
<div 
  onMouseEnter={() => setIsHovering(true)}
  onMouseLeave={() => setIsHovering(false)}
>
  {/* Shows overlay when hovering */}
</div>
```

### Resize (when pinned)
```typescript
const handleResize = (delta: number) => {
  setNavWidth(Math.max(180, Math.min(400, navWidth + delta)));
};
```

## Implementation Steps

1. **Remove navigator from rc-dock layout entirely**
   - No navigator panel in rc-dock
   - rc-dock only has main-tabs panel

2. **Create header row structure**
   - Fixed 44px height div
   - Navigator header on left (dynamic width)
   - Tab bar area on right (how?)

3. **Problem: rc-dock manages its own tab bar**
   - rc-dock renders tab bar inside its panel
   - We can't extract it to our header row
   
4. **Solution: Put navigator header INSIDE rc-dock's panelExtra**
   - Use `panelExtra` to inject navigator header into tab bar
   - Navigator panel is separate div outside rc-dock
   - When pinned: panel takes space, rc-dock shrinks
   - When unpinned: panel is overlay, rc-dock full width

## Final Architecture

```jsx
<AppShell>
  <MenuBar />
  
  <div class="content-area" style={{display: 'flex'}}>
    {/* Navigator - when pinned */}
    {isPinned && (
      <div style={{width: navWidth}}>
        <NavigatorContent />
      </div>
    )}
    
    {/* Navigator - overlay when unpinned + hovering */}
    {!isPinned && hovering && (
      <div style={{position: 'absolute', width: 240px, zIndex: 1000}}>
        <NavigatorContent />
      </div>
    )}
    
    {/* rc-dock with panelExtra for nav button */}
    <DockLayout 
      groups={{
        'main-content': {
          panelExtra: () => <NavigatorHeaderButton />
        }
      }}
    />
  </div>
</AppShell>
```

## Key Insight

The Navigator button MUST be in rc-dock's tab bar (via panelExtra), but the Navigator panel is a separate React div outside rc-dock. This gives us:
- ✅ Button inline with tabs (rc-dock renders it)
- ✅ Panel can be pinned (flexbox layout)
- ✅ Panel can be overlay (position: absolute)
- ✅ rc-dock width adjusts automatically (flex: 1)

---

This is the ONLY way to achieve the design requirements while working WITH rc-dock instead of fighting it.

