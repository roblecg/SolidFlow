namespace SolidFlow;

internal static class RepoRoot
{
    public static string ExeDirectory()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrEmpty(processPath))
        {
            var dir = Path.GetDirectoryName(processPath);
            if (!string.IsNullOrEmpty(dir)) return dir;
        }

        return AppContext.BaseDirectory;
    }

    public static string Find()
    {
        var bundled = Path.Combine(ExeDirectory(), "app");
        if (IsSolidFlowRoot(bundled)) return bundled;

        var dir = new DirectoryInfo(ExeDirectory());
        for (var i = 0; i < 8 && dir is not null; i++)
        {
            if (IsSolidFlowRoot(dir.FullName)) return dir.FullName;
            dir = dir.Parent;
        }

        throw new InvalidOperationException(
            "SolidFlow.exe must stay next to its app folder, or inside the solidFlow project folder.");
    }

    public static string FindNode()
    {
        var bundled = Path.Combine(ExeDirectory(), "node", "node.exe");
        if (File.Exists(bundled)) return bundled;

        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var entry in path.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(entry.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }

        throw new InvalidOperationException(
            "Node.js was not found. Keep the node folder next to SolidFlow.exe, or install Node.js 24 or newer.");
    }

    private static bool IsSolidFlowRoot(string dir)
    {
        var packageJson = Path.Combine(dir, "package.json");
        if (!File.Exists(packageJson)) return false;
        var text = File.ReadAllText(packageJson);
        return text.Contains("\"name\": \"solidFlow\"", StringComparison.Ordinal) ||
            text.Contains("\"name\":\"solidFlow\"", StringComparison.Ordinal);
    }
}
