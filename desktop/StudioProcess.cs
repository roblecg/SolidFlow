using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace SolidFlow;

internal sealed class StudioProcess : IDisposable
{
    private readonly Process? _process;
    private readonly bool _owned;

    private StudioProcess(string url, Process? process, bool owned)
    {
        Url = url;
        _process = process;
        _owned = owned;
    }

    public string Url { get; }

    public static StudioProcess Start(string repo, string nodeExe, string? workspace)
    {
        var tsx = Path.Combine(repo, "node_modules", "tsx", "dist", "cli.mjs");
        var cli = Path.Combine(repo, "src", "cli.ts");
        if (!File.Exists(tsx) || !File.Exists(cli))
        {
            throw new InvalidOperationException(
                "SolidFlow dependencies are missing. In the solidFlow folder, run pnpm install, then open SolidFlow again.");
        }

        for (var port = 4317; port < 4330; port++)
        {
            if (AcceptsStudio(port))
            {
                return new StudioProcess($"http://127.0.0.1:{port}/", null, owned: false);
            }
            if (PortInUse(port)) continue;

            var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    WorkingDirectory = repo,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                }
            };
            if (!string.IsNullOrWhiteSpace(workspace))
            {
                process.StartInfo.Environment["SOLIDFLOW_WORKSPACE"] = workspace;
            }
            process.StartInfo.ArgumentList.Add(tsx);
            process.StartInfo.ArgumentList.Add(cli);
            process.StartInfo.ArgumentList.Add("studio");
            process.StartInfo.ArgumentList.Add(port.ToString());
            process.StartInfo.ArgumentList.Add("--no-browser");

            var log = new System.Text.StringBuilder();
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data is not null) log.AppendLine(e.Data);
            };
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is not null) log.AppendLine(e.Data);
            };
            if (!process.Start())
            {
                throw new InvalidOperationException("Could not start the SolidFlow server.");
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            var ready = WaitUntilReady(port, process, TimeSpan.FromSeconds(20));
            if (ready) return new StudioProcess($"http://127.0.0.1:{port}/", process, owned: true);

            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new InvalidOperationException(
                "SolidFlow did not start." + Environment.NewLine + log);
        }

        throw new InvalidOperationException("No free local port was available for SolidFlow.");
    }

    public static void UseWorkspace(string studioUrl, string workspace)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
        var payload = JsonSerializer.Serialize(new Dictionary<string, string> { ["path"] = workspace });
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(studioUrl), "api/workspace"))
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json")
        };
        using var response = client.Send(request);
        using var reader = new StreamReader(response.Content.ReadAsStream());
        var body = reader.ReadToEnd();
        if (response.StatusCode == HttpStatusCode.Conflict)
        {
            throw new InvalidOperationException("A test is running. Wait for it to finish before changing the workspace.");
        }
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                "Could not open that workspace. Close any other SolidFlow window, then open SolidFlow again."
                + Environment.NewLine + body);
        }
    }

    public void Dispose()
    {
        if (!_owned || _process is null || _process.HasExited) return;
        try
        {
            _process.Kill(entireProcessTree: true);
            _process.WaitForExit(3000);
        }
        catch (InvalidOperationException)
        {
            // The process already exited.
        }
    }

    private static bool WaitUntilReady(int port, Process process, TimeSpan timeout)
    {
        var started = DateTime.UtcNow;
        while (DateTime.UtcNow - started < timeout)
        {
            if (process.HasExited) return false;
            if (AcceptsStudio(port)) return true;
            Thread.Sleep(200);
        }
        return false;
    }

    private static bool AcceptsStudio(int port)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) };
            using var response = client.Send(new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/"));
            using var reader = new StreamReader(response.Content.ReadAsStream());
            var body = reader.ReadToEnd();
            return body.Contains("SolidFlow", StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static bool PortInUse(int port)
    {
        try
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            var result = socket.BeginConnect(IPAddress.Loopback, port, null, null);
            var connected = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
            if (!connected) return false;
            socket.EndConnect(result);
            return socket.Connected;
        }
        catch
        {
            return false;
        }
    }
}
