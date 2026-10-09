namespace SolidFlow;

internal static class RepoRoot
{
    public static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++)
        {
            var packageJson = Path.Combine(dir.FullName, "package.json");
            if (File.Exists(packageJson))
            {
                var text = File.ReadAllText(packageJson);
                if (text.Contains("\"name\": \"solidFlow\"", StringComparison.Ordinal) ||
                    text.Contains("\"name\":\"solidFlow\"", StringComparison.Ordinal))
                {
                    return dir.FullName;
                }
            }
            dir = dir.Parent;
        }

        throw new InvalidOperationException(
            "SolidFlow.exe must stay inside the solidFlow project folder so it can find package.json.");
    }

    public static string FindNode()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var entry in path.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(entry.Trim(), "node.exe");
            if (File.Exists(candidate)) return candidate;
        }

        throw new InvalidOperationException(
            "Node.js was not found on PATH. Install Node.js 24 or newer, then open SolidFlow again.");
    }
}
