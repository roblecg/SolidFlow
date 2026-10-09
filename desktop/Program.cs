namespace SolidFlow;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.SetColorMode(SystemColorMode.System);
        using var gate = new Mutex(true, "SolidFlow.Studio", out var created);
        if (!created)
        {
            MessageBox.Show(
                "SolidFlow is already open.",
                "SolidFlow",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        try
        {
            var workspace = WorkspaceStore.Saved();
            var repo = RepoRoot.Find();
            var node = RepoRoot.FindNode();
            using var studio = StudioProcess.Start(repo, node, workspace);
            if (workspace is not null) StudioProcess.UseWorkspace(studio.Url, workspace);
            var page = workspace is null ? studio.Url + "?welcome=1" : studio.Url;
            Application.Run(new StudioWindow(page, studio, workspace));
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "SolidFlow", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
