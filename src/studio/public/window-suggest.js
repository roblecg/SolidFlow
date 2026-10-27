window.SolidFlowWindows = {
  /** The file: value under switchToWindow, or null when the caret is somewhere else. */
  switchFileContext(value, cursor) {
    const at = Math.max(0, Math.min(cursor, value.length));
    const lineStart = value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    const lineBreak = value.indexOf("\n", at);
    const lineEnd = lineBreak === -1 ? value.length : lineBreak;
    const line = value.slice(lineStart, lineEnd);
    const match = /^(\s*)file:\s*(.*)$/.exec(line);
    if (!match) return null;
    const from = lineStart + match[1].length + "file:".length;
    if (at < from) return null;
    const command = commandAbove(value, lineStart, match[1].length);
    if (command !== "switchToWindow") return null;
    const typed = match[2].trim().replace(/^["']/, "").replace(/["']$/, "");
    return { typed, from, to: lineEnd };
  },

  /** Text that replaces the value after file:, including the leading space. */
  yamlFileValue(file) {
    const quoted = /[:#\s"'\\]/.test(file) ? JSON.stringify(file) : file;
    return " " + quoted;
  }
};

function commandAbove(value, lineStart, fieldIndent) {
  const lines = value.slice(0, lineStart).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = (line.match(/^\s*/) || [""])[0].length;
    if (indent >= fieldIndent) continue;
    const step = /^\s*-\s*([A-Za-z][A-Za-z0-9]*)\s*:/.exec(line);
    return step ? step[1] : "";
  }
  return "";
}
