if (
  # 1) Any CSS file: don't touch by default
  (.file | test("\\.css$")) or

  # 2) DOM / React style usages and core CSS props
  (.context | test("style\\.color")) or
  (.context | test("style *= *\\{\\{[^}]*color *:")) or
  (.context | test("style\\s*:\\s*\\{[^}]*color\\s*:")) or
  # GLOBALLY EXCLUDE COMPOUND CSS PROPS to prevent 'backgroundColour' in JS objects
  (.context | test("background-color|border-color|outline-color|text-decoration-color|caret-color|flood-color|lighting-color|stop-color")) or
  (.context | test("backgroundColor|borderColor|outlineColor|textDecorationColor|caretColor|floodColor|lightingColor|stopColor")) or

  # 3) HTML color input
  (.context | test("type=\\\"color\\\"|type=\\'color\\'")) or

  # 4) Known third-party / tooling names
  (.context | test("d3-color|supports-color|color-support|css-color|@asamuzakjp/css-color|@csstools/css-color-parser")) or

  # 5) Likely MUI / component props using enum-y color values
  (.context | test("color=\\\"(primary|secondary|inherit|default|info|success|warning|error|textSecondary|textPrimary|text\\.primary|text\\.secondary|text\\.disabled|error\\.main)\\\"")) or
  (.context | test("color=\\'(primary|secondary|inherit|default|info|success|warning|error|textSecondary|textPrimary)\\'")) or

  # 6) Style objects in JS/TS that look like plain CSS (not domain keys)
  (.context | test("\\{[^}]*color *: *['\\\"]#")) or

  # 7) Any obvious CLI / terminal color support mentions
  (.context | test("NO_COLOR|FORCE_COLOR")) or

  # 8) Apps Script / Google Apps Script files (inline HTML/CSS)
  (.file | test("apps-script/")) or

  # 9) CSS code examples in markdown (lines showing actual CSS syntax)
  (.context | test("^[[:space:]]*\\.[a-z-]+[[:space:]]*\\{[[:space:]]*color:")) or
  (.context | test("^[[:space:]]*color:[[:space:]]*[#']")) or

  # 10) Inline style strings in HTML
  (.context | test("style=\\\"[^\\\"]*color:")) or
  (.context | test("style=\\'[^\\']*color:")) or

  # 12) CSS variable references
  (.context | test("var\\(--[^)]*color")) or

  # 13) CSS transitions that animate color properties
  (.context | test("transition:.*\\bcolor\\b")) or
  (.context | test("transition.*'color")) or

  # 14) External library component props (lucide-react icons, react-flow components)
  (.context | test("<(ZapOff|Zap|Check|X|AlertCircle|Info|Warning|Error|Success|Close|Menu|Search|Filter|Settings|Home|User|LogOut|Plus|Minus|Edit|Trash|Download|Upload|Share|Copy|Save|File|Folder|Image|Video|Music|Play|Pause|Stop|SkipForward|SkipBack|Rewind|FastForward|Volume|Mute|Bell|Mail|Message|Phone|Calendar|Clock|Star|Heart|ThumbsUp|ThumbsDown|Like|Dislike|Eye|EyeOff|Lock|Unlock|Key|Shield|ShieldCheck|ShieldAlert|ShieldOff|ShieldX|ShieldQuestion|ShieldPlus|ShieldMinus|ShieldBan|ShieldCheckmark|ShieldExclamation|ShieldLock|ShieldUnlock|ShieldKey|ShieldStar|ShieldHeart|ShieldThumbsUp|ShieldThumbsDown|ShieldLike|ShieldDislike|ShieldEye|ShieldEyeOff|ShieldBell|ShieldMail|ShieldMessage|ShieldPhone|ShieldCalendar|ShieldClock|ShieldImage|ShieldVideo|ShieldMusic|ShieldPlay|ShieldPause|ShieldStop|ShieldSkipForward|ShieldSkipBack|ShieldRewind|ShieldFastForward|ShieldVolume|ShieldMute|ShieldFile|ShieldFolder|ShieldDownload|ShieldUpload|ShieldShare|ShieldCopy|ShieldSave|ShieldEdit|ShieldTrash|ShieldPlus|ShieldMinus|ShieldSearch|ShieldFilter|ShieldSettings|ShieldHome|ShieldUser|ShieldLogOut|ShieldMenu|ShieldCheck|ShieldX|ShieldAlert|ShieldInfo|ShieldWarning|ShieldError|ShieldSuccess|ShieldClose|Background|ReactFlow|MiniMap|Controls|Panel|Handle|Edge|Node|Marker|MarkerStart|MarkerEnd|ArrowHead|ArrowHeadClosed|ArrowHeadOpen)\\s+[^>]*color\\s*=")) or

  # 15) CSS property syntax in markdown that's actual CSS (not TypeScript interfaces)
  (.context | test("^[[:space:]]*color:\\s*(var\\(|rgba?\\()")) or
  (.context | test("^[[:space:]]*color:\\s*[#'][^;]*;"))
)
then .change = false
else .
end
