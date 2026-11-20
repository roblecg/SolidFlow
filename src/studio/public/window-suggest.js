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

  /** The value after trayMenu:, or null when the caret is somewhere else. */
  trayMenuContext(value, cursor) {
    const at = Math.max(0, Math.min(cursor, value.length));
    const lineStart = value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    const lineBreak = value.indexOf("\n", at);
    const lineEnd = lineBreak === -1 ? value.length : lineBreak;
    const line = value.slice(lineStart, lineEnd);
    const match = /^(\s*-\s*trayMenu:)(.*)$/.exec(line);
    if (!match) return null;
    const from = lineStart + match[1].length;
    if (at < from) return null;
    const typed = yamlScalar(match[2]);
    const indent = (line.match(/^\s*/) || [""])[0].length + 4;
    return { typed, from, to: lineEnd, indent };
  },

  /** app: or item: under trayMenu. */
  trayFieldContext(value, cursor, key) {
    const at = Math.max(0, Math.min(cursor, value.length));
    const lineStart = value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    const lineBreak = value.indexOf("\n", at);
    const lineEnd = lineBreak === -1 ? value.length : lineBreak;
    const line = value.slice(lineStart, lineEnd);
    const match = new RegExp("^(\\s*)" + key + ":\\s*(.*)$").exec(line);
    if (!match) return null;
    const from = lineStart + match[1].length + key.length + 1;
    if (at < from) return null;
    if (commandAbove(value, lineStart, match[1].length) !== "trayMenu") return null;
    return { typed: yamlScalar(match[2]), from, to: lineEnd };
  },

  /** The app named on the trayMenu step that contains this line. */
  trayAppName(value, cursor) {
    const at = Math.max(0, Math.min(cursor, value.length));
    const lineStart = value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    const ownIndent = (value.slice(lineStart).match(/^\s*/) || [""])[0].length;
    const lines = value.slice(0, lineStart).split("\n");
    let start = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = (line.match(/^\s*/) || [""])[0].length;
      if (indent >= ownIndent) continue;
      if (/^\s*-\s*trayMenu\s*:/.test(line)) start = i;
      break;
    }
    const rest = value.split("\n").slice(start);
    const stepIndent = (rest[0].match(/^\s*/) || [""])[0].length;
    for (let i = 1; i < rest.length; i++) {
      const line = rest[i];
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = (line.match(/^\s*/) || [""])[0].length;
      if (indent <= stepIndent) break;
      const match = /^\s*app:\s*(.*)$/.exec(line);
      if (match) return yamlScalar(match[1]);
    }
    return "";
  },

  /** file: under switchToWindow, an app on the taskbar, or that app's menu item. */
  editorSuggestContext(value, cursor) {
    const file = this.switchFileContext(value, cursor);
    if (file) return { kind: "window", ...file };
    const item = this.trayFieldContext(value, cursor, "item");
    if (item) return { kind: "tray-item", ...item, app: this.trayAppName(value, cursor) };
    const app = this.trayFieldContext(value, cursor, "app");
    if (app) return { kind: "tray-app", mode: "field", ...app };
    const tray = this.trayMenuContext(value, cursor);
    if (tray) return { kind: "tray-app", mode: "shorthand", ...tray };
    return null;
  },

  /** Text that replaces the value after the colon, including the leading space. */
  yamlFileValue(file) {
    const quoted = /[:#\s"'\\]/.test(file) ? JSON.stringify(file) : file;
    return " " + quoted;
  }
};

function yamlScalar(raw) {
  const text = String(raw || "").trim();
  if (text.startsWith('"')) {
    if (text.length >= 2 && text.endsWith('"')) {
      try {
        const parsed = JSON.parse(text);
        return typeof parsed === "string" ? parsed : text.slice(1, -1);
      } catch {
        return text.slice(1, -1);
      }
    }
    return text.slice(1);
  }
  if (text.startsWith("'")) return text.length >= 2 && text.endsWith("'") ? text.slice(1, -1) : text.slice(1);
  return text;
}

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
