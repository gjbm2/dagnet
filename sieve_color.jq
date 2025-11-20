if (
  # 1) Any CSS file: don't touch by default
  (.file | test("\\.css$")) or

  # 2) DOM / React style usages and core CSS props
  (.context | test("style\\.color")) or
  (.context | test("style *= *\\{\\{[^}]*color *:")) or
  (.context | test("style\\s*:\\s*\\{[^}]*color\\s*:")) or
  (.context | test("background-color|border-color|outline-color|text-decoration-color|caret-color")) or

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

  # 11) backgroundColor, borderColor, textColor - compound CSS-like properties in style objects or CSS
  ((.file | test("\\.css$")) and (.context | test("(background|border|text|accent)Color[^a-z]"))) or
  ((.context | test("style\\s*[:=]")) and (.context | test("(background|border|text|accent)Color[^a-z]"))) or

  # 12) CSS variable references
  (.context | test("var\\(--[^)]*color")) or

  # 13) CSS transitions that animate color properties
  (.context | test("transition:.*\\bcolor\\b")) or
  (.context | test("transition.*'color")) or

  # 14) External library component props (lucide-react icons, react-flow components)
  (.context | test("<(ZapOff|Background)\\s+[^>]*color\\s*=")) or

  # 15) CSS property syntax in markdown that's actual CSS (not TypeScript interfaces)
  (.context | test("^[[:space:]]*color:\\s*(var\\(|rgba?\\()")) or
  (.context | test("^[[:space:]]*color:\\s*[#'][^;]*;"))
)
then .change = false
else .
end
