using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SolidFlow;

internal sealed class StudioWindow : Form
{
    private const int WmNcCalcSize = 0x0083;
    private const int WmNcLButtonDown = 0x00A1;
    private const int HtCaption = 2;
    private const int DwmwaWindowCornerPreference = 33;

    private readonly StudioProcess? _studio;
    private readonly bool _customFrame;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private bool _frameStateSent;
    private bool _lastMaximized;
    private bool _fitting;

    public StudioWindow(string url, StudioProcess? studio, string? workspace = null)
    {
        _studio = studio;
        _customFrame = studio is not null;
        Text = workspace is null ? "SolidFlow" : WorkspaceStore.WindowTitle(workspace);
        Width = 1440;
        Height = 920;
        MinimumSize = new Size(1180, 760);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.White;
        Controls.Add(_web);
        Load += async (_, _) => await OpenAsync(url);
        Resize += (_, _) =>
        {
            if (WindowState == FormWindowState.Normal) ClampToWorkArea();
            if (_customFrame) PublishFrameState(false);
        };
        if (studio is not null)
        {
            FormClosed += (_, _) => studio.Dispose();
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ClampToWorkArea();
        if (!_customFrame) return;
        var preference = 2;
        _ = DwmSetWindowAttribute(Handle, DwmwaWindowCornerPreference, ref preference, sizeof(int));
    }

    /// <summary>
    /// Keep a restored window inside the monitor work area. The preferred
    /// 1440×920 size is taller than a short display, and the 760px minimum
    /// is the size that still fits those screens.
    /// </summary>
    private void ClampToWorkArea()
    {
        if (_fitting || !IsHandleCreated || WindowState != FormWindowState.Normal) return;
        var area = Screen.FromHandle(Handle).WorkingArea;
        if (area.Width < 320 || area.Height < 240) return;
        _fitting = true;
        try
        {
            var minW = Math.Min(MinimumSize.Width, area.Width);
            var minH = Math.Min(MinimumSize.Height, area.Height);
            if (minW != MinimumSize.Width || minH != MinimumSize.Height)
                MinimumSize = new Size(minW, minH);
            var width = Math.Min(Width, area.Width);
            var height = Math.Min(Height, area.Height);
            var left = Math.Min(Math.Max(Left, area.Left), area.Right - width);
            var top = Math.Min(Math.Max(Top, area.Top), area.Bottom - height);
            if (left != Left || top != Top || width != Width || height != Height)
                Bounds = new Rectangle(left, top, width, height);
        }
        finally
        {
            _fitting = false;
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (_customFrame && m.Msg == WmNcCalcSize && m.WParam != IntPtr.Zero)
        {
            // WindowState is still the old value while this message is in flight.
            // IsZoomed is the maximized state Windows is sizing for.
            if (IsZoomed(Handle) && TryGetWorkArea(out var work))
            {
                var size = Marshal.PtrToStructure<NcCalcSizeParams>(m.LParam);
                size.rgrc0 = work;
                Marshal.StructureToPtr(size, m.LParam, false);
            }
            m.Result = IntPtr.Zero;
            return;
        }
        base.WndProc(ref m);
    }

    private async Task OpenAsync(string url)
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SolidFlow",
                "WebView2");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(environment);
            _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
            _web.CoreWebView2.Settings.IsWebMessageEnabled = true;
            _web.CoreWebView2.NavigationCompleted += (_, _) => PublishFrameState(true);
            if (_studio is not null)
            {
                _web.CoreWebView2.WebMessageReceived += (_, args) =>
                {
                    if (!TryReadMessage(args.WebMessageAsJson, out var message)) return;
                    if (message.Type == "pick-folder") BeginInvoke(() => ReturnPickedFolder(message.Path));
                    else if (message.Type == "workspace-opened" && !string.IsNullOrWhiteSpace(message.Path))
                        BeginInvoke(() => Text = WorkspaceStore.WindowTitle(message.Path));
                    else if (message.Type == "window")
                        BeginInvoke(() => HandleWindow(message.Action, message.Edge));
                };
            }
            _web.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                if (!IsLocal(args.Uri))
                {
                    args.Handled = true;
                    return;
                }
                args.Handled = true;
                var popup = new StudioWindow(args.Uri, null)
                {
                    Width = 1100,
                    Height = 820
                };
                popup.Show(this);
            };
            _web.CoreWebView2.NavigationStarting += (_, args) =>
            {
                if (!IsLocal(args.Uri)) args.Cancel = true;
            };
            _web.Source = new Uri(url);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "The SolidFlow window could not open the studio page." + Environment.NewLine + ex.Message,
                "SolidFlow",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    private void ReturnPickedFolder(string? initial)
    {
        var picked = WorkspaceStore.Pick(this, initial);
        var payload = JsonSerializer.Serialize(new { type = "folder-picked", path = picked ?? "" });
        try
        {
            _web.CoreWebView2.PostWebMessageAsJson(payload);
        }
        catch (InvalidOperationException)
        {
            // The page navigated away before the folder dialog closed.
        }
    }

    private void HandleWindow(string? action, string? edge)
    {
        switch (action)
        {
            case "minimize":
                WindowState = FormWindowState.Minimized;
                break;
            case "maximize":
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal
                    : FormWindowState.Maximized;
                break;
            case "close":
                Close();
                break;
            case "drag":
                ReleaseCapture();
                _ = SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
                break;
            case "resize" when WindowState != FormWindowState.Maximized:
                var hit = HitForEdge(edge);
                if (hit == 0) return;
                ReleaseCapture();
                _ = SendMessage(Handle, WmNcLButtonDown, hit, 0);
                break;
        }
    }

    private void PublishFrameState(bool force)
    {
        if (!_customFrame || _web.CoreWebView2 is null) return;
        var maximized = WindowState == FormWindowState.Maximized;
        if (!force && _frameStateSent && maximized == _lastMaximized) return;
        _frameStateSent = true;
        _lastMaximized = maximized;
        var payload = JsonSerializer.Serialize(new { type = "window-state", maximized });
        try
        {
            _web.CoreWebView2.PostWebMessageAsJson(payload);
        }
        catch (InvalidOperationException)
        {
            // The page is navigating.
        }
    }

    private static int HitForEdge(string? edge)
    {
        return edge switch
        {
            "left" => 10,
            "right" => 11,
            "top" => 12,
            "top-left" => 13,
            "top-right" => 14,
            "bottom" => 15,
            "bottom-left" => 16,
            "bottom-right" => 17,
            _ => 0
        };
    }

    private readonly record struct HostMessage(string Type, string? Path, string? Action, string? Edge);

    private static bool TryReadMessage(string json, out HostMessage message)
    {
        message = default;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            if (!doc.RootElement.TryGetProperty("type", out var typeElement)) return false;
            var type = typeElement.GetString();
            if (string.IsNullOrEmpty(type)) return false;
            string? path = null;
            string? action = null;
            string? edge = null;
            if (doc.RootElement.TryGetProperty("path", out var pathElement)) path = pathElement.GetString();
            if (doc.RootElement.TryGetProperty("action", out var actionElement)) action = actionElement.GetString();
            if (doc.RootElement.TryGetProperty("edge", out var edgeElement)) edge = edgeElement.GetString();
            message = new HostMessage(type, path, action, edge);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public uint dwFlags;
    }

    private const uint MonitorDefaultToNearest = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct NcCalcSizeParams
    {
        public Rect rgrc0;
        public Rect rgrc1;
        public Rect rgrc2;
        public IntPtr lppos;
    }

    private bool TryGetWorkArea(out Rect work)
    {
        work = default;
        var monitor = MonitorFromWindow(Handle, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero) return false;
        var info = new MonitorInfo { cbSize = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref info)) return false;
        work = info.rcWork;
        return work.right > work.left && work.bottom > work.top;
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo lpmi);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    private static bool IsLocal(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return false;
        return parsed.Host is "127.0.0.1" or "localhost";
    }
}
