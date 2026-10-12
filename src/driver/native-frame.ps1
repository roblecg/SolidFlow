# Reads one JSON request per line and writes one JSON response per line.
# Captures the title bar of the app under test for the inspect preview.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Drawing

$csharp = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
using System.Windows.Automation;
using Microsoft.Win32;

namespace SolidFlow {
  public static class NativeFrame {
    const int GW_OWNER = 4;
    const int DWMWA_CAPTION_BUTTON_BOUNDS = 5;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    const int DWMWA_CLOAKED = 14;
    const uint SRCCOPY = 0x00CC0020;
    const uint WM_SYSCOMMAND = 0x0112;
    const int SC_MINIMIZE = 0xF020;
    const int SC_MAXIMIZE = 0xF030;
    const int SC_RESTORE = 0xF120;
    const int SC_CLOSE = 0xF060;
    const int SM_CYCAPTION = 4;
    const int SM_CXFRAME = 32;
    const int SM_CYFRAME = 33;
    const int SM_CXPADDEDBORDER = 92;

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT {
      public int length;
      public int flags;
      public int showCmd;
      public POINT ptMinPosition;
      public POINT ptMaxPosition;
      public RECT rcNormalPosition;
    }

    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint nFlags);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendMessageText(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] static extern IntPtr SendMessageBuffer(IntPtr hWnd, uint Msg, IntPtr wParam, StringBuilder lParam);
    [DllImport("user32.dll", EntryPoint = "SendMessageW")] static extern IntPtr SendMessagePtr(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr hdc, int x, int y, int cx, int cy, IntPtr hdcSrc, int x1, int y1, uint rop);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr hProcess, int flags, StringBuilder exeName, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);

    static EnumProc held;
    static bool dpiReady;

    public static void Init() {
      if (dpiReady) return;
      dpiReady = true;
      try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
      try { SetProcessDpiAwareness(2); } catch { }
      try { SetProcessDPIAware(); } catch { }
    }

    public static string Handle(string op, int procId, string appPath, int hintW, int hintH, int cssW, int cssH, string action, string hwndText, string name, string text) {
      Init();
      op = op ?? "";
      appPath = appPath ?? "";
      if (op == "windows") return ListPopups(procId, appPath);
      IntPtr requested = ParseHwnd(hwndText);
      bool specific = requested != IntPtr.Zero;
      if (specific && (op == "invoke" || op == "visible" || op == "value" || op == "caption")) {
        if (!IsWindow(requested) || !Related(requested, procId, appPath)) return "{\"ok\":false,\"error\":\"window not found\"}";
        if (op == "invoke") return InvokeNamed(requested, name ?? "");
        if (op == "visible") return VisibleNamed(requested, name ?? "");
        if (op == "value") return SetNamedValue(requested, name ?? "", text ?? "");
        if (op == "read") return ReadNamed(requested, name ?? "");
        return Caption(requested, action ?? "");
      }
      IntPtr hwnd = IntPtr.Zero;
      bool popup = false;
      if (specific && IsWindow(requested) && Related(requested, procId, appPath)) {
        hwnd = requested;
        popup = GetWindow(hwnd, GW_OWNER) != IntPtr.Zero || hwnd != Find(procId, appPath, hintW, hintH, cssW, cssH);
      } else {
        hwnd = Find(procId, appPath, hintW, hintH, cssW, cssH);
      }
      if (hwnd == IntPtr.Zero) return "{\"ok\":false,\"error\":\"window not found\"}";
      if (op == "invoke") return InvokeNamed(hwnd, name ?? "");
      if (op == "visible") return VisibleNamed(hwnd, name ?? "");
      if (op == "value") return SetNamedValue(hwnd, name ?? "", text ?? "");
      if (op == "read") return ReadNamed(hwnd, name ?? "");
      if (op == "caption") return Caption(hwnd, action ?? "");
      return Capture(hwnd, op == "capture", popup);
    }

    static string Caption(IntPtr hwnd, string action) {
      int command = 0;
      if (action == "minimize") command = SC_MINIMIZE;
      else if (action == "maximize" || action == "toggleZoom") command = IsZoomed(hwnd) || IsIconic(hwnd) ? SC_RESTORE : SC_MAXIMIZE;
      else if (action == "close") command = SC_CLOSE;
      else {
        FocusWindow(hwnd);
        return "{\"ok\":true}";
      }
      if (!SysCommand(hwnd, command)) return "{\"ok\":false,\"error\":\"The app did not accept the window command.\"}";
      return "{\"ok\":true}";
    }

    static bool SysCommand(IntPtr hwnd, int command) {
      IntPtr result;
      IntPtr sent = SendMessageTimeout(hwnd, WM_SYSCOMMAND, new IntPtr(command), IntPtr.Zero, 2, 1500, out result);
      return sent != IntPtr.Zero;
    }

    static void FocusWindow(IntPtr hwnd) {
      uint foregroundPid = 0;
      uint targetPid = 0;
      IntPtr foreground = GetForegroundWindow();
      uint foregroundThread = 0;
      if (foreground != IntPtr.Zero) foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
      uint targetThread = GetWindowThreadProcessId(hwnd, out targetPid);
      uint currentThread = GetCurrentThreadId();
      bool attachedForeground = false;
      bool attachedTarget = false;
      try {
        if (foregroundThread != 0 && foregroundThread != currentThread) {
          attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
        }
        if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
          attachedTarget = AttachThreadInput(currentThread, targetThread, true);
        }
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        else ShowWindow(hwnd, 5);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
      } finally {
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
      }
    }

    static IntPtr ParseHwnd(string value) {
      long parsed;
      if (string.IsNullOrWhiteSpace(value) || !long.TryParse(value, out parsed) || parsed == 0) return IntPtr.Zero;
      return new IntPtr(parsed);
    }

    static string HwndText(IntPtr hwnd) {
      return hwnd.ToInt64().ToString();
    }

    static bool Belongs(uint windowPid, int procId, string appPath) {
      if (procId > 0 && windowPid == (uint)procId) return true;
      if (procId > 0) return false;
      return SamePath(ProcessPath(windowPid), appPath);
    }

    static bool Related(IntPtr hwnd, int procId, string appPath) {
      if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      string image = ProcessPath(pid);
      if (IsStudioProcess(image)) return false;
      if (Belongs(pid, procId, appPath) || SamePath(image, appPath)) return true;
      IntPtr owner = GetWindow(hwnd, GW_OWNER);
      if (owner != IntPtr.Zero && owner != hwnd && Related(owner, procId, appPath)) return true;
      IntPtr root = GetAncestor(hwnd, 3);
      if (root != IntPtr.Zero && root != hwnd && root != owner) {
        uint rootPid;
        GetWindowThreadProcessId(root, out rootPid);
        if (IsStudioProcess(ProcessPath(rootPid))) return false;
        if (Belongs(rootPid, procId, appPath) || SamePath(ProcessPath(rootPid), appPath)) return true;
      }
      return false;
    }

    static bool SkipClass(IntPtr hwnd) {
      StringBuilder buffer = new StringBuilder(256);
      if (GetClassName(hwnd, buffer, buffer.Capacity) == 0) return false;
      string name = buffer.ToString();
      return name == "tooltips_class32" || name == "SysShadow" || name == "#32768" || name == "IME" || name == "MSCTFIME UI";
    }

    static List<IntPtr> popupHits;

    static string ListPopups(int procId, string appPath) {
      IntPtr main = Find(procId, appPath, 0, 0, 0, 0);
      popupHits = new List<IntPtr>();
      held = delegate(IntPtr hWnd, IntPtr lParam) {
        try {
          if (IsPopup(hWnd, main, procId, appPath)) popupHits.Add(hWnd);
        } catch { }
        return true;
      };
      try { EnumWindows(held, IntPtr.Zero); }
      finally { held = null; }
      StringBuilder json = new StringBuilder();
      json.Append("{\"ok\":true,\"windows\":[");
      bool first = true;
      foreach (IntPtr hwnd in popupHits) {
        if (!first) json.Append(',');
        first = false;
        json.Append("{\"hwnd\":\"" + HwndText(hwnd) + "\",\"title\":" + JsonString(WindowTitle(hwnd)) + "}");
      }
      popupHits = null;
      json.Append("]}");
      return json.ToString();
    }

    static bool IsPopup(IntPtr hwnd, IntPtr main, int procId, string appPath) {
      if (hwnd == IntPtr.Zero || hwnd == main) return false;
      if (!IsWindowVisible(hwnd) || Cloaked(hwnd) || SkipClass(hwnd)) return false;
      if (GetWindowTextLength(hwnd) == 0) return false;
      if (!Related(hwnd, procId, appPath)) return false;
      RECT win;
      if (!WindowRect(hwnd, out win)) return false;
      if (win.Right - win.Left < 80 || win.Bottom - win.Top < 80) return false;
      return true;
    }

    static AutomationElement FromHwnd(IntPtr hwnd) {
      return AutomationElement.FromHandle(hwnd);
    }

    static string ClassNameOf(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero) return "";
      StringBuilder buffer = new StringBuilder(256);
      if (GetClassName(hwnd, buffer, buffer.Capacity) == 0) return "";
      return buffer.ToString();
    }

    static IntPtr HwndOf(AutomationElement el) {
      if (el == null) return IntPtr.Zero;
      int raw = el.Current.NativeWindowHandle;
      if (raw == 0) return IntPtr.Zero;
      return new IntPtr(raw);
    }

    static bool IsFilenameId(string id) {
      return id == "1152" || id == "1148" || id == "FileNameControlHost" || id == "Filename" || id == "FileName";
    }

    static bool IsFilenameLabel(string name) {
      string trimmed = (name ?? "").Trim().TrimEnd(':').Trim();
      return trimmed.Equals("Folder", StringComparison.OrdinalIgnoreCase)
        || trimmed.Equals("File name", StringComparison.OrdinalIgnoreCase);
    }

    static bool SameName(AutomationElement el, string name) {
      string current = (el.Current.Name ?? "").Trim();
      string auto = el.Current.AutomationId ?? "";
      if (string.Equals(current, name, StringComparison.OrdinalIgnoreCase)) return true;
      return string.Equals(auto, name, StringComparison.OrdinalIgnoreCase);
    }

    static AutomationElement FilenameEdit(AutomationElement root) {
      if (root == null) return null;
      string[] ids = new string[] { "1152", "1148", "FileNameControlHost", "Filename", "FileName" };
      for (int i = 0; i < ids.Length; i++) {
        AutomationElement found = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, ids[i]));
        if (found != null) return found;
      }
      return null;
    }

    static string FieldLabel(AutomationElement root) {
      AutomationElement label = root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, "1090"));
      string name = label == null ? "" : (label.Current.Name ?? "").Trim();
      if (name.Length > 0) return name;
      return "Folder:";
    }

    static AutomationElement FindNamed(AutomationElement root, string name) {
      if (root == null || string.IsNullOrWhiteSpace(name)) return null;
      AutomationElement editable = null;
      AutomationElement button = null;
      AutomationElement other = null;
      AutomationElementCollection all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
      foreach (AutomationElement el in all) {
        if (!SameName(el, name)) continue;
        string cls = ClassNameOf(HwndOf(el));
        string id = el.Current.AutomationId ?? "";
        if (cls == "Edit" || cls.StartsWith("RichEdit") || IsFilenameId(id)) editable = el;
        else if (cls == "Button") button = el;
        else if (other == null && cls != "Static") other = el;
      }
      if (editable != null) return editable;
      if (IsFilenameLabel(name)) {
        AutomationElement field = FilenameEdit(root);
        if (field != null) return field;
      }
      if (button != null) return button;
      return other;
    }

    static bool ClickHwnd(IntPtr hwnd) {
      RECT rect;
      if (hwnd == IntPtr.Zero || !GetClientRect(hwnd, out rect)) return false;
      int x = Math.Max(1, (rect.Right - rect.Left) / 2);
      int y = Math.Max(1, (rect.Bottom - rect.Top) / 2);
      IntPtr point = new IntPtr((y << 16) | (x & 0xFFFF));
      SendMessagePtr(hwnd, 0x0201, new IntPtr(1), point);
      SendMessagePtr(hwnd, 0x0202, IntPtr.Zero, point);
      return true;
    }

    static bool Act(AutomationElement el) {
      object pattern;
      if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        ((InvokePattern)pattern).Invoke();
        return true;
      }
      IntPtr hwnd = HwndOf(el);
      string cls = ClassNameOf(hwnd);
      if (cls == "Button") {
        SendMessagePtr(hwnd, 0x00F5, IntPtr.Zero, IntPtr.Zero);
        return true;
      }
      if (cls == "Edit" || cls.StartsWith("RichEdit") || IsFilenameId(el.Current.AutomationId ?? "")) {
        return ClickHwnd(hwnd);
      }
      if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) {
        ((TogglePattern)pattern).Toggle();
        return true;
      }
      if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) {
        ((SelectionItemPattern)pattern).Select();
        return true;
      }
      if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
        ExpandCollapsePattern expand = (ExpandCollapsePattern)pattern;
        if (expand.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) expand.Expand();
        else expand.Collapse();
        return true;
      }
      return false;
    }

    static string InvokeNamed(IntPtr hwnd, string name) {
      try {
        AutomationElement el = FindNamed(FromHwnd(hwnd), name);
        if (el == null || !Act(el)) return "{\"ok\":false,\"error\":" + JsonString(name + " is not in " + WindowTitle(hwnd)) + "}";
        return "{\"ok\":true}";
      } catch (Exception ex) {
        return "{\"ok\":false,\"error\":" + JsonString(ex.Message) + "}";
      }
    }

    static string VisibleNamed(IntPtr hwnd, string name) {
      try {
        if (string.Equals(WindowTitle(hwnd), name, StringComparison.OrdinalIgnoreCase)) return "{\"ok\":true,\"visible\":true}";
        AutomationElement el = FindNamed(FromHwnd(hwnd), name);
        if (el == null) return "{\"ok\":true,\"visible\":false}";
        bool visible = !el.Current.IsOffscreen;
        return "{\"ok\":true,\"visible\":" + (visible ? "true" : "false") + "}";
      } catch (Exception ex) {
        return "{\"ok\":false,\"error\":" + JsonString(ex.Message) + "}";
      }
    }

    static bool WriteText(AutomationElement el, string text) {
      IntPtr hwnd = HwndOf(el);
      string cls = ClassNameOf(hwnd);
      if (cls == "Edit" || cls.StartsWith("RichEdit")) {
        SendMessageText(hwnd, 0x000C, IntPtr.Zero, text ?? "");
        return true;
      }
      object pattern = null;
      if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
        AutomationElement inner = el.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        if (inner != null) inner.TryGetCurrentPattern(ValuePattern.Pattern, out pattern);
      }
      ValuePattern value = pattern as ValuePattern;
      if (value == null) return false;
      value.SetValue(text ?? "");
      return true;
    }

    static string ReadText(AutomationElement el) {
      IntPtr hwnd = HwndOf(el);
      string cls = ClassNameOf(hwnd);
      if (cls == "Edit" || cls.StartsWith("RichEdit")) {
        StringBuilder buffer = new StringBuilder(2048);
        SendMessageBuffer(hwnd, 0x000D, new IntPtr(buffer.Capacity), buffer);
        return buffer.ToString();
      }
      object pattern = null;
      if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
        ValuePattern value = pattern as ValuePattern;
        if (value != null) return value.Current.Value ?? "";
      }
      return "";
    }

    static string SetNamedValue(IntPtr hwnd, string name, string text) {
      try {
        AutomationElement root = FromHwnd(hwnd);
        AutomationElement el = string.IsNullOrWhiteSpace(name) ? FilenameEdit(root) : FindNamed(root, name);
        if (el == null) return "{\"ok\":false,\"error\":" + JsonString((name.Length == 0 ? "The text field" : name) + " is not in " + WindowTitle(hwnd)) + "}";
        if (!WriteText(el, text)) return "{\"ok\":false,\"error\":" + JsonString(name + " cannot be edited") + "}";
        return "{\"ok\":true}";
      } catch (Exception ex) {
        return "{\"ok\":false,\"error\":" + JsonString(ex.Message) + "}";
      }
    }

    static string ReadNamed(IntPtr hwnd, string name) {
      try {
        AutomationElement root = FromHwnd(hwnd);
        AutomationElement el = string.IsNullOrWhiteSpace(name) ? FilenameEdit(root) : FindNamed(root, name);
        if (el == null) return "{\"ok\":false,\"error\":" + JsonString((name.Length == 0 ? "The text field" : name) + " is not in " + WindowTitle(hwnd)) + "}";
        return "{\"ok\":true,\"text\":" + JsonString(ReadText(el)) + "}";
      } catch (Exception ex) {
        return "{\"ok\":false,\"error\":" + JsonString(ex.Message) + "}";
      }
    }

    static void AppendControl(StringBuilder json, ref bool first, ref int count, string label, string kind, int x, int y, int w, int h) {
      if (count >= 80 || label.Length == 0 || w < 4 || h < 4) return;
      if (!first) json.Append(',');
      first = false;
      count++;
      json.Append("{\"name\":" + JsonString(label) + ",\"kind\":\"" + kind + "\",\"bounds\":{\"x\":" + x + ",\"y\":" + y + ",\"width\":" + w + ",\"height\":" + h + "}}");
    }

    static bool TryBounds(AutomationElement el, int originX, int originY, int captionH, out int x, out int y, out int w, out int h) {
      x = y = w = h = 0;
      if (el.Current.IsOffscreen) return false;
      System.Windows.Rect rect = el.Current.BoundingRectangle;
      if (rect.IsEmpty || rect.Width < 4 || rect.Height < 4) return false;
      x = (int)Math.Round(rect.X - originX);
      y = (int)Math.Round(rect.Y - originY);
      w = (int)Math.Round(rect.Width);
      h = (int)Math.Round(rect.Height);
      if (captionH > 0 && y + h / 2 < captionH) return false;
      return true;
    }

    static void AppendDialogFields(AutomationElement root, StringBuilder json, ref bool first, ref int count, int originX, int originY, int captionH) {
      AutomationElement edit = FilenameEdit(root);
      int x, y, w, h;
      if (edit != null && TryBounds(edit, originX, originY, captionH, out x, out y, out w, out h)) {
        AppendControl(json, ref first, ref count, FieldLabel(root), "edit", x, y, w, h);
      }
      AutomationElementCollection panes = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Pane));
      foreach (AutomationElement el in panes) {
        if (ClassNameOf(HwndOf(el)) != "Button") continue;
        string label = (el.Current.Name ?? "").Trim();
        if (!TryBounds(el, originX, originY, captionH, out x, out y, out w, out h)) continue;
        AppendControl(json, ref first, ref count, label, "button", x, y, w, h);
      }
    }

    static string ControlJson(IntPtr hwnd, int originX, int originY, int captionH) {
      try {
        AutomationElement root = FromHwnd(hwnd);
        ControlType[] types = new ControlType[] {
          ControlType.Button, ControlType.SplitButton, ControlType.Edit, ControlType.ComboBox,
          ControlType.CheckBox, ControlType.RadioButton, ControlType.Hyperlink, ControlType.TreeItem
        };
        StringBuilder json = new StringBuilder();
        json.Append('[');
        bool first = true;
        int count = 0;
        int trees = 0;
        AppendDialogFields(root, json, ref first, ref count, originX, originY, captionH);
        for (int t = 0; t < types.Length && count < 80; t++) {
          AutomationElementCollection found = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, types[t]));
          foreach (AutomationElement el in found) {
            if (count >= 80) break;
            string label = (el.Current.Name ?? "").Trim();
            if (label.Length == 0) continue;
            if (el.Current.IsOffscreen) continue;
            System.Windows.Rect rect = el.Current.BoundingRectangle;
            if (rect.IsEmpty || rect.Width < 4 || rect.Height < 4) continue;
            int x = (int)Math.Round(rect.X - originX);
            int y = (int)Math.Round(rect.Y - originY);
            int w = (int)Math.Round(rect.Width);
            int h = (int)Math.Round(rect.Height);
            if (captionH > 0 && y + h / 2 < captionH) continue;
            string kind = "control";
            ControlType type = types[t];
            if (type == ControlType.Button || type == ControlType.SplitButton) kind = "button";
            else if (type == ControlType.Edit) kind = "edit";
            else if (type == ControlType.ComboBox) kind = "combo";
            else if (type == ControlType.TreeItem) {
              if (trees >= 40) continue;
              trees++;
              kind = "tree";
            } else if (type == ControlType.CheckBox || type == ControlType.RadioButton) kind = "check";
            else if (type == ControlType.Hyperlink) kind = "link";
            if (!first) json.Append(',');
            first = false;
            count++;
            json.Append("{\"name\":" + JsonString(label) + ",\"kind\":\"" + kind + "\",\"bounds\":{\"x\":" + x + ",\"y\":" + y + ",\"width\":" + w + ",\"height\":" + h + "}}");
          }
        }
        json.Append(']');
        return json.ToString();
      } catch {
        return "[]";
      }
    }

    static string Capture(IntPtr hwnd, bool includePng, bool popup) {
      bool iconic = IsIconic(hwnd);
      bool showRestore = iconic || IsZoomed(hwnd);
      RECT win;
      if (!WindowRect(hwnd, out win)) return "{\"ok\":false,\"error\":\"window rect unavailable\"}";
      RECT ext = win;
      if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out ext, Marshal.SizeOf(typeof(RECT))) != 0) ext = win;
      if (ext.Right <= ext.Left || ext.Bottom <= ext.Top) ext = win;

      int screenX = 0, screenY = 0, clientW = 0, clientH = 0;
      POINT origin = new POINT();
      RECT client = new RECT();
      bool haveClient = GetClientRect(hwnd, out client) && ClientToScreen(hwnd, ref origin);
      if (haveClient && !iconic) {
        screenX = origin.X;
        screenY = origin.Y;
        clientW = client.Right - client.Left;
        clientH = client.Bottom - client.Top;
      }

      int imgW = ext.Right - ext.Left;
      int imgH = ext.Bottom - ext.Top;
      if (imgW < 80 || imgH < 80 || imgW > 8000 || imgH > 8000) {
        return "{\"ok\":false,\"error\":\"window size is not usable\"}";
      }

      int cx = haveClient && !iconic ? screenX - ext.Left : Border(hwnd);
      int cy = haveClient && !iconic ? screenY - ext.Top : CaptionHeight(hwnd);
      if (cx < 0 || cx > 64) cx = 0;
      if (cy < 0 || cy > imgH / 2) cy = 0;
      if (clientW < 20 || clientH < 20 || iconic) {
        int border = cx > 0 ? cx : Border(hwnd);
        int caption = cy >= 8 ? cy : CaptionHeight(hwnd);
        cx = border;
        cy = caption;
        clientW = Math.Max(20, imgW - border * 2);
        clientH = Math.Max(20, imgH - caption - border);
      }

      int winW = Math.Max(1, win.Right - win.Left);
      int winH = Math.Max(1, win.Bottom - win.Top);
      int cropX = ext.Left - win.Left;
      int cropY = ext.Top - win.Top;
      RECT buttons = new RECT();
      bool haveButtons = DwmGetWindowAttribute(hwnd, DWMWA_CAPTION_BUTTON_BOUNDS, out buttons, Marshal.SizeOf(typeof(RECT))) == 0;
      int bx = haveButtons ? buttons.Left - (ext.Left - win.Left) : imgW;
      int buttonW = haveButtons ? buttons.Right - buttons.Left : 0;
      int maxGroup = Math.Max(120, cy * 7);
      bool buttonsOk = buttonW >= 24 && buttonW <= maxGroup && bx >= imgW - maxGroup - 8 && bx < imgW - 12;
      if (!buttonsOk) {
        int one = (int)Math.Round(Math.Max(cy, 28) * 1.45);
        bx = Math.Max(0, imgW - one * 3);
      }

      string title = WindowTitle(hwnd);
      string pngPath = "";
      if (includePng && cy >= 8) {
        Bitmap image = null;
        try {
          image = iconic ? null : Grab(hwnd, winW, winH, cropX, cropY, imgW, imgH, cy);
          bool blank = image == null || (!popup && TitleBlank(image, cy));
          if (blank) {
            if (image != null) image.Dispose();
            image = new Bitmap(imgW, imgH, PixelFormat.Format32bppArgb);
            DrawTitle(image, hwnd, title, cy, bx, showRestore);
          }
          imgW = image.Width;
          imgH = image.Height;
          if (cx + clientW > imgW) clientW = Math.Max(20, imgW - cx);
          if (cy + clientH > imgH) clientH = Math.Max(20, imgH - cy);
          if (bx > imgW - 24) {
            int one = (int)Math.Round(Math.Max(cy, 28) * 1.45);
            bx = Math.Max(0, imgW - one * 3);
          }
          pngPath = Path.Combine(Path.GetTempPath(), "solidflow-frame-" + Guid.NewGuid().ToString("N") + ".png");
          image.Save(pngPath, ImageFormat.Png);
        } finally {
          if (image != null) image.Dispose();
        }
      }

      int buttonWidth = Math.Max(0, imgW - bx);
      string controls = popup ? ControlJson(hwnd, ext.Left, ext.Top, cy) : "[]";
      return "{\"ok\":true,\"title\":" + JsonString(title)
        + ",\"popup\":" + (popup ? "true" : "false")
        + ",\"controls\":" + controls
        + ",\"maximized\":" + (showRestore ? "true" : "false")
        + ",\"width\":" + imgW
        + ",\"height\":" + imgH
        + ",\"client\":{\"x\":" + cx + ",\"y\":" + cy + ",\"width\":" + clientW + ",\"height\":" + clientH + "}"
        + ",\"buttons\":{\"x\":" + bx + ",\"y\":0,\"width\":" + buttonWidth + ",\"height\":" + Math.Max(cy, 1) + "}"
        + ",\"pngPath\":" + JsonString(pngPath) + "}";
    }

    static Bitmap Grab(IntPtr hwnd, int winW, int winH, int cropX, int cropY, int imgW, int imgH, int titleH) {
      Bitmap full = TryPrint(hwnd, winW, winH, 2);
      Bitmap cropped = Crop(full, cropX, cropY, imgW, imgH);
      if (full != null) full.Dispose();
      if (cropped != null && !TitleBlank(cropped, titleH)) return cropped;
      if (cropped != null) cropped.Dispose();

      full = TryPrint(hwnd, winW, winH, 0);
      cropped = Crop(full, cropX, cropY, imgW, imgH);
      if (full != null) full.Dispose();
      if (cropped != null && !TitleBlank(cropped, titleH)) return cropped;
      if (cropped != null) cropped.Dispose();

      full = TryWindowDc(hwnd, winW, winH);
      cropped = Crop(full, cropX, cropY, imgW, imgH);
      if (full != null) full.Dispose();
      if (cropped != null && !TitleBlank(cropped, titleH)) return cropped;
      if (cropped != null) cropped.Dispose();

      if (GetForegroundWindow() == hwnd) cropped = TryScreen(hwnd, imgW, imgH);
      return cropped;
    }

    static Bitmap TryScreen(IntPtr hwnd, int imgW, int imgH) {
      Bitmap bmp = null;
      try {
        RECT ext;
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out ext, Marshal.SizeOf(typeof(RECT))) != 0) return null;
        int w = ext.Right - ext.Left;
        int h = ext.Bottom - ext.Top;
        if (w != imgW || h != imgH || w < 80 || h < 80) return null;
        bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp)) {
          g.CopyFromScreen(ext.Left, ext.Top, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
        Bitmap ready = bmp;
        bmp = null;
        return ready;
      } catch {
        if (bmp != null) bmp.Dispose();
        return null;
      }
    }

    static Bitmap TryPrint(IntPtr hwnd, int w, int h, uint flags) {
      Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      bool ok = false;
      try {
        using (Graphics g = Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          try { ok = PrintWindow(hwnd, hdc, flags); }
          finally { g.ReleaseHdc(hdc); }
        }
      } catch {
        bmp.Dispose();
        return null;
      }
      if (!ok) {
        bmp.Dispose();
        return null;
      }
      return bmp;
    }

    static Bitmap TryWindowDc(IntPtr hwnd, int w, int h) {
      IntPtr src = GetWindowDC(hwnd);
      if (src == IntPtr.Zero) return null;
      Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      try {
        bool ok = false;
        using (Graphics g = Graphics.FromImage(bmp)) {
          IntPtr dst = g.GetHdc();
          try { ok = BitBlt(dst, 0, 0, w, h, src, 0, 0, SRCCOPY); }
          finally { g.ReleaseHdc(dst); }
        }
        if (!ok) {
          bmp.Dispose();
          bmp = null;
          return null;
        }
        return bmp;
      } catch {
        if (bmp != null) bmp.Dispose();
        return null;
      } finally {
        ReleaseDC(hwnd, src);
      }
    }

    static Bitmap Crop(Bitmap full, int cropX, int cropY, int imgW, int imgH) {
      if (full == null || imgW < 1 || imgH < 1) return null;
      if (cropX < 0) cropX = 0;
      if (cropY < 0) cropY = 0;
      if (cropX + imgW > full.Width) imgW = full.Width - cropX;
      if (cropY + imgH > full.Height) imgH = full.Height - cropY;
      if (imgW < 1 || imgH < 1) return null;
      Bitmap cropped = new Bitmap(imgW, imgH, PixelFormat.Format32bppArgb);
      using (Graphics g = Graphics.FromImage(cropped)) {
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.DrawImage(full, new Rectangle(0, 0, imgW, imgH), new Rectangle(cropX, cropY, imgW, imgH), GraphicsUnit.Pixel);
      }
      return cropped;
    }

    static bool TitleBlank(Bitmap bmp, int titleH) {
      if (bmp == null || titleH < 8 || bmp.Width < 16) return true;
      int samples = 0;
      double sum = 0;
      double sum2 = 0;
      int step = Math.Max(1, bmp.Width / 48);
      int[] rows = new int[] { titleH / 4, titleH / 2, (titleH * 3) / 4 };
      for (int r = 0; r < rows.Length; r++) {
        int y = Math.Max(0, Math.Min(bmp.Height - 1, rows[r]));
        for (int x = 8; x < bmp.Width - 8; x += step) {
          Color c = bmp.GetPixel(x, y);
          int lum = (c.R + c.G + c.B) / 3;
          // PrintWindow often stores the caption RGB with alpha 0. Those pixels are still the real title bar.
          if (c.A < 16 && lum <= 10) continue;
          sum += lum;
          sum2 += lum * lum;
          samples++;
        }
      }
      if (samples < 4) return true;
      double mean = sum / samples;
      double variance = sum2 / samples - mean * mean;
      if (variance < 8) return true;
      return mean < 12 && variance < 40;
    }

    static void DrawTitle(Bitmap bmp, IntPtr hwnd, string title, int titleH, int buttonsX, bool showRestore) {
      bool light = true;
      try {
        object theme = Registry.GetValue(
          @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
          "AppsUseLightTheme",
          1);
        light = theme == null || Convert.ToInt32(theme) != 0;
      } catch { }
      Color bg = light ? Color.FromArgb(255, 255, 255) : Color.FromArgb(32, 32, 32);
      Color fg = light ? Color.FromArgb(28, 28, 28) : Color.FromArgb(255, 255, 255);
      Color line = light ? Color.FromArgb(229, 229, 229) : Color.FromArgb(58, 58, 58);
      using (Graphics g = Graphics.FromImage(bmp)) {
        g.Clear(bg);
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        int icon = Math.Max(16, titleH / 2);
        int iconY = Math.Max(0, (titleH - icon) / 2);
        try {
          string path = ProcessPath((uint)hwndProc(hwnd));
          if (path.Length > 0) {
            using (Icon associated = Icon.ExtractAssociatedIcon(path)) {
              if (associated != null) {
                using (Bitmap iconBmp = associated.ToBitmap()) {
                  g.DrawImage(iconBmp, new Rectangle(10, iconY, icon, icon));
                }
              }
            }
          }
        } catch { }
        float size = Math.Max(9f, titleH * 9f / 32f);
        using (Font font = MakeFont(size))
        using (Brush brush = new SolidBrush(fg))
        using (Pen border = new Pen(line))
        using (Pen glyph = new Pen(fg, Math.Max(1f, titleH / 22f))) {
          float textLeft = 16f + icon;
          float textRight = Math.Max(textLeft + 8f, buttonsX - 8f);
          using (StringFormat format = new StringFormat()) {
            format.LineAlignment = StringAlignment.Center;
            format.Trimming = StringTrimming.EllipsisCharacter;
            format.FormatFlags = StringFormatFlags.NoWrap;
            g.DrawString(title ?? "", font, brush, new RectangleF(textLeft, 0, textRight - textLeft, titleH), format);
          }
          g.DrawLine(border, 0, titleH - 1, bmp.Width, titleH - 1);
          int slice = Math.Max(1, (bmp.Width - buttonsX) / 3);
          DrawGlyph(g, glyph, 0, buttonsX, slice, titleH, false);
          DrawGlyph(g, glyph, 1, buttonsX + slice, slice, titleH, showRestore);
          DrawGlyph(g, glyph, 2, buttonsX + slice * 2, bmp.Width - (buttonsX + slice * 2), titleH, false);
        }
      }
    }

    static void DrawGlyph(Graphics g, Pen pen, int kind, int x, int w, int h, bool restore) {
      int cx = x + w / 2;
      int cy = h / 2;
      int s = Math.Max(6, h / 4);
      if (kind == 0) {
        g.DrawLine(pen, cx - s, cy + s / 2, cx + s, cy + s / 2);
      } else if (kind == 1 && restore) {
        g.DrawRectangle(pen, cx - s + 2, cy - s, s, s);
        g.DrawRectangle(pen, cx - s, cy - s + 3, s, s);
      } else if (kind == 1) {
        g.DrawRectangle(pen, cx - s, cy - s, s * 2, s * 2);
      } else {
        g.DrawLine(pen, cx - s, cy - s, cx + s, cy + s);
        g.DrawLine(pen, cx + s, cy - s, cx - s, cy + s);
      }
    }

    static Font MakeFont(float size) {
      try { return new Font("Segoe UI", size, FontStyle.Regular, GraphicsUnit.Point); }
      catch { return new Font(FontFamily.GenericSansSerif, size, FontStyle.Regular, GraphicsUnit.Point); }
    }

    static uint hwndProc(IntPtr hwnd) {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      return pid;
    }

    static int CaptionHeight(IntPtr hwnd) {
      uint dpi = 96;
      try { dpi = GetDpiForWindow(hwnd); } catch { dpi = 96; }
      if (dpi == 0) dpi = 96;
      return Math.Max(28, Metric(SM_CYCAPTION, dpi) + Metric(SM_CYFRAME, dpi));
    }

    static int Border(IntPtr hwnd) {
      uint dpi = 96;
      try { dpi = GetDpiForWindow(hwnd); } catch { dpi = 96; }
      if (dpi == 0) dpi = 96;
      return Math.Max(1, Metric(SM_CXFRAME, dpi) + Metric(SM_CXPADDEDBORDER, dpi) / 2);
    }

    static int Metric(int index, uint dpi) {
      try {
        int value = GetSystemMetricsForDpi(index, dpi);
        if (value > 0) return value;
      } catch { }
      return Math.Max(0, GetSystemMetrics(index));
    }

    static IntPtr Find(int procId, string appPath, int hintW, int hintH, int cssW, int cssH) {
      IntPtr best = IntPtr.Zero;
      int bestScore = 0;
      held = delegate(IntPtr hWnd, IntPtr lParam) {
        try {
          int score = Score(hWnd, procId, appPath, hintW, hintH, cssW, cssH);
          if (score > bestScore) {
            bestScore = score;
            best = hWnd;
          }
        } catch { }
        return true;
      };
      try { EnumWindows(held, IntPtr.Zero); }
      finally { held = null; }
      return best;
    }

    static int Score(IntPtr hwnd, int procId, string appPath, int hintW, int hintH, int cssW, int cssH) {
      if (!IsWindowVisible(hwnd)) return 0;
      if (Cloaked(hwnd)) return 0;
      if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return 0;
      uint windowPid;
      GetWindowThreadProcessId(hwnd, out windowPid);
      string image = ProcessPath(windowPid);
      if (IsStudioProcess(image)) return 0;
      bool pidMatch = procId > 0 && windowPid == (uint)procId;
      bool pathMatch = SamePath(image, appPath);
      if (!pidMatch && !pathMatch) return 0;
      if (GetWindowTextLength(hwnd) == 0) return 0;
      RECT win;
      if (!WindowRect(hwnd, out win)) return 0;
      int winW = win.Right - win.Left;
      int winH = win.Bottom - win.Top;
      if (winW < 80 || winH < 80) return 0;
      int score = 1;
      if (pidMatch) score += 500000;
      if (pathMatch) score += 200000;
      int cw, ch;
      if (ClientPixels(hwnd, out cw, out ch) && Near(cw, hintW) && Near(ch, hintH)) score += 100000;
      else if (Near(cw, cssW) && Near(ch, cssH)) score += 80000;
      if (IsIconic(hwnd)) score -= 20000;
      score += Math.Min(winW * winH / 1000, 40000);
      return score;
    }

    static bool WindowRect(IntPtr hwnd, out RECT win) {
      win = new RECT();
      if (IsIconic(hwnd)) {
        WINDOWPLACEMENT place = new WINDOWPLACEMENT();
        place.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (GetWindowPlacement(hwnd, ref place)) {
          win = place.rcNormalPosition;
          if (win.Right - win.Left >= 80 && win.Bottom - win.Top >= 80) return true;
        }
      }
      return GetWindowRect(hwnd, out win);
    }

    static bool ClientPixels(IntPtr hwnd, out int w, out int h) {
      w = 0;
      h = 0;
      RECT client;
      if (!GetClientRect(hwnd, out client)) return false;
      w = client.Right - client.Left;
      h = client.Bottom - client.Top;
      return w > 0 && h > 0;
    }

    static bool Cloaked(IntPtr hwnd) {
      int cloaked;
      if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, out cloaked, 4) != 0) return false;
      return cloaked != 0;
    }

    static bool Near(int actual, int expected) {
      if (expected <= 0 || actual <= 0) return false;
      int tol = Math.Max(24, expected / 8);
      return Math.Abs(actual - expected) <= tol;
    }

    static string ProcessPath(uint processId) {
      IntPtr handle = OpenProcess(0x1000, false, processId);
      if (handle == IntPtr.Zero) return "";
      try {
        StringBuilder buffer = new StringBuilder(2048);
        int size = buffer.Capacity;
        if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) return "";
        return buffer.ToString();
      } finally {
        CloseHandle(handle);
      }
    }

    static bool IsStudioProcess(string image) {
      if (string.IsNullOrEmpty(image)) return false;
      return string.Equals(Path.GetFileName(image), "SolidFlow.exe", StringComparison.OrdinalIgnoreCase);
    }

    static bool SamePath(string left, string right) {
      if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
      try {
        string a = Path.GetFullPath(left).TrimEnd('\\', '/');
        string b = Path.GetFullPath(right).TrimEnd('\\', '/');
        return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
      } catch {
        return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
      }
    }

    static string WindowTitle(IntPtr hwnd) {
      int length = GetWindowTextLength(hwnd);
      StringBuilder buffer = new StringBuilder(Math.Max(1, length + 1));
      GetWindowText(hwnd, buffer, buffer.Capacity);
      return buffer.ToString();
    }

    static string JsonString(string value) {
      if (value == null) value = "";
      StringBuilder buffer = new StringBuilder(value.Length + 2);
      buffer.Append('"');
      foreach (char c in value) {
        if (c == '\\') buffer.Append("\\\\");
        else if (c == '"') buffer.Append("\\\"");
        else if (c < ' ') buffer.Append(' ');
        else buffer.Append(c);
      }
      buffer.Append('"');
      return buffer.ToString();
    }
  }
}
'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase
[SolidFlow.NativeFrame]::Init()

function Convert-ToInt($value) {
  if ($null -eq $value -or $value -eq "") { return 0 }
  return [int]$value
}

$stdout = [Console]::OpenStandardOutput()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $json = '{"ok":false,"error":"bad request"}'
  try {
    $req = $line | ConvertFrom-Json
    $json = [SolidFlow.NativeFrame]::Handle(
      [string]$req.op,
      (Convert-ToInt $req.procId),
      [string]$req.appPath,
      (Convert-ToInt $req.hintW),
      (Convert-ToInt $req.hintH),
      (Convert-ToInt $req.cssW),
      (Convert-ToInt $req.cssH),
      [string]$req.action,
      [string]$req.hwnd,
      [string]$req.name,
      [string]$req.text
    )
  } catch {
    $message = $_.Exception.Message
    if ($null -eq $message) { $message = "window capture failed" }
    $message = [regex]::Replace($message, "[\u0000-\u001F]", " ")
    $message = $message.Replace('\', '\\').Replace('"', '\"')
    $json = '{"ok":false,"error":"' + $message + '"}'
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
