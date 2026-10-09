using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SolidFlow;

internal static class WorkspaceStore
{
    private const int MaxRecent = 8;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static string SettingsPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SolidFlow",
        "settings.json");

    public static string? Saved()
    {
        var settings = Read();
        if (!IsDirectory(settings.WorkspacePath)) return null;
        var full = Path.GetFullPath(settings.WorkspacePath!);
        return IsInsideInstall(full) ? null : full;
    }

    public static string? Pick(IWin32Window? owner, string? initial)
    {
        var start = IsDirectory(initial) ? initial : Saved();
        return PickWithExplorer(owner, start);
    }

    private static string? PickWithExplorer(IWin32Window? owner, string? current)
    {
        var dialog = (IFileOpenDialog)new FileOpenDialog();
        try
        {
            dialog.GetOptions(out var options);
            dialog.SetOptions(options | FosPickFolders | FosForceFileSystem | FosPathMustExist);
            dialog.SetTitle("Select a SolidFlow workspace");
            var start = IsDirectory(current)
                ? current!
                : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (TryCreateShellItem(start, out var folder) && folder is not null)
            {
                try
                {
                    dialog.SetFolder(folder);
                }
                finally
                {
                    Marshal.ReleaseComObject(folder);
                }
            }

            var hr = dialog.Show(owner?.Handle ?? IntPtr.Zero);
            if (hr == HresultCancelled) return null;
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);

            dialog.GetResult(out var result);
            try
            {
                result.GetDisplayName(SigdnFileSystemPath, out var path);
                return Path.GetFullPath(path);
            }
            finally
            {
                Marshal.ReleaseComObject(result);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(dialog);
        }
    }

    private static bool TryCreateShellItem(string path, out IShellItem? item)
    {
        var iid = typeof(IShellItem).GUID;
        var hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
        if (hr == 0 && item is not null) return true;
        item = null;
        return false;
    }

    private const uint FosPickFolders = 0x00000020;
    private const uint FosForceFileSystem = 0x00000040;
    private const uint FosPathMustExist = 0x00000800;
    private const uint SigdnFileSystemPath = 0x80058000;
    private const int HresultCancelled = unchecked((int)0x800704C7);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        string path,
        IntPtr bindContext,
        ref Guid iid,
        out IShellItem item);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig]
        int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IntPtr results);
        void GetSelectedItems(out IntPtr items);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint nameType, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    public static string WindowTitle(string workspace)
    {
        var name = Path.GetFileName(workspace.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        return string.IsNullOrEmpty(name) ? "SolidFlow" : $"SolidFlow — {name}";
    }

    private static bool IsDirectory(string? path)
    {
        return !string.IsNullOrWhiteSpace(path) && Directory.Exists(path);
    }

    private static bool IsInsideInstall(string path)
    {
        try
        {
            var repo = Path.GetFullPath(RepoRoot.Find())
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var full = Path.GetFullPath(path)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return full.Equals(repo, StringComparison.OrdinalIgnoreCase)
                || full.StartsWith(repo + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static WorkspaceSettings Read()
    {
        if (!File.Exists(SettingsPath))
        {
            var legacy = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TestX",
                "settings.json");
            if (File.Exists(legacy))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
                File.Copy(legacy, SettingsPath);
            }
            else
            {
                return new WorkspaceSettings();
            }
        }
        try
        {
            var parsed = JsonSerializer.Deserialize<WorkspaceSettings>(File.ReadAllText(SettingsPath), JsonOptions);
            return parsed ?? new WorkspaceSettings();
        }
        catch (JsonException)
        {
            return new WorkspaceSettings();
        }
    }

    private static void Save(WorkspaceSettings settings, string workspace)
    {
        settings.WorkspacePath = workspace;
        settings.RecentWorkspaces.RemoveAll(path => string.Equals(path, workspace, StringComparison.OrdinalIgnoreCase));
        settings.RecentWorkspaces.Insert(0, workspace);
        if (settings.RecentWorkspaces.Count > MaxRecent)
        {
            settings.RecentWorkspaces.RemoveRange(MaxRecent, settings.RecentWorkspaces.Count - MaxRecent);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
        var tmp = SettingsPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(tmp, SettingsPath, overwrite: true);
    }
}

internal sealed class WorkspaceSettings
{
    public string? WorkspacePath { get; set; }
    public List<string> RecentWorkspaces { get; set; } = [];
}
