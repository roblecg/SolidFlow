import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  captionActionFor,
  captureNativeFrame,
  chooseNativePopup,
  clipRect,
  compositePageIntoFrame,
  headerNodes,
  hitHeader,
  imageToPage,
  invokeNativeControl,
  lastNativeFrameError,
  listNativePopups,
  readNativeText,
  setNativeText,
  nativeControlVisible,
  performCaptionAction,
  stopNativeFrameHost,
  type FrameLayout
} from "../src/driver/native-frame.js";

const sample: FrameLayout = {
  title: "CIM Document Exporter",
  maximized: false,
  width: 1000,
  height: 700,
  client: { x: 8, y: 40, width: 984, height: 652 },
  buttons: { x: 850, y: 0, width: 150, height: 40 },
  popup: false,
  controls: []
};

describe("native window header", () => {
  afterAll(() => {
    stopNativeFrameHost();
  });

  it("maps caption clicks to the title bar and window buttons", () => {
    const nodes = headerNodes(sample);
    expect(nodes.map(node => node.selector)).toEqual([
      "window:title",
      "window:minimize",
      "window:maximize",
      "window:close"
    ]);
    expect(hitHeader(sample, 40, 10)?.label).toBe("CIM Document Exporter");
    expect(hitHeader(sample, 990, 10)?.selector).toBe("window:close");
    expect(hitHeader(sample, 900, 10)?.selector).toBe("window:maximize");
    expect(hitHeader(sample, 860, 10)?.selector).toBe("window:minimize");
    expect(hitHeader(sample, 100, 80)).toBeNull();
  });

  it("labels the middle button Restore while the window is zoomed", () => {
    const zoomed = headerNodes({ ...sample, maximized: true });
    expect(zoomed.find(node => node.selector === "window:maximize")?.label).toBe("Restore");
  });

  it("converts a preview click inside the page back to page coordinates", () => {
    expect(imageToPage(sample, 8, 40, 492, 326)).toEqual({ x: 0, y: 0 });
    expect(imageToPage(sample, 8 + 984, 40 + 652, 492, 326)).toEqual({ x: 492, y: 326 });
    expect(imageToPage(sample, 4, 10, 492, 326)).toBeNull();
  });

  it("keeps page targets out of the title bar", () => {
    expect(clipRect({ x: 0, y: 20, width: 100, height: 40 }, sample.client)).toEqual({
      x: 8,
      y: 40,
      width: 92,
      height: 20
    });
  });

  it("paints the page into the client area and leaves the title bar untouched", () => {
    const frame = solid(10, 8, [240, 240, 240, 255]);
    const page = solid(4, 3, [10, 80, 200, 255]);
    const client = { x: 1, y: 2, width: 4, height: 3 };
    const out = PNG.sync.read(compositePageIntoFrame(PNG.sync.write(frame), PNG.sync.write(page), client));
    expect(pixel(out, 0, 0)).toEqual([240, 240, 240, 255]);
    expect(pixel(out, 1, 2)).toEqual([10, 80, 200, 255]);
    expect(pixel(out, 9, 7)).toEqual([240, 240, 240, 255]);
  });

  it("makes a captured title bar visible when PrintWindow left its alpha at zero", () => {
    const frame = solid(4, 4, [0, 0, 0, 0]);
    frame.data[0] = 240;
    frame.data[1] = 240;
    frame.data[2] = 240;
    frame.data[3] = 0;
    const page = solid(2, 2, [12, 90, 180, 255]);
    const out = PNG.sync.read(
      compositePageIntoFrame(PNG.sync.write(frame), PNG.sync.write(page), { x: 1, y: 2, width: 2, height: 2 })
    );
    expect(pixel(out, 0, 0)).toEqual([240, 240, 240, 255]);
    expect(pixel(out, 1, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 1, 2)).toEqual([12, 90, 180, 255]);
  });

  it("ignores windows that were already open and follows a new folder window", () => {
    const baseline = new Set(["main"]);
    const adopted = new Set<string>();
    const windows = [
      { hwnd: "main", title: "CIM Document Exporter" },
      { hwnd: "folder", title: "Select output folder" }
    ];
    expect(chooseNativePopup(windows, baseline, adopted)?.title).toBe("Select output folder");
    adopted.add("folder");
    expect(chooseNativePopup(windows, baseline, adopted)).toBeNull();
  });

  it("turns a double tap on the title into restore or maximize", () => {
    expect(captionActionFor("tapOn", "window:close")).toBe("close");
    expect(captionActionFor("tapOn", "window:title")).toBe("title");
    expect(captionActionFor("doubleTapOn", "window:title")).toBe("toggleZoom");
    expect(captionActionFor("tapOn", "login-region")).toBeNull();
  });

  it("captures a real window title bar", async () => {
    if (process.platform !== "win32") return;
    const root = process.env.SystemRoot || "C:\\Windows";
    const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const probe = spawn(
      exe,
      ["-NoProfile", "-Sta", "-WindowStyle", "Hidden", "-Command", probeScript()],
      { windowsHide: false, stdio: "ignore" }
    );
    try {
      const frame = await waitForFrame(probe.pid ?? 0, exe);
      expect(frame, lastNativeFrameError()).toBeTruthy();
      if (!frame) return;
      expect(frame.title).toContain("Target App Probe");
      expect(frame.client.y).toBeGreaterThanOrEqual(16);
      expect(frame.client.y).toBeLessThan(frame.height / 2);
      expect(frame.buttons.x).toBeGreaterThan(frame.width / 2);
      const png = PNG.sync.read(frame.png);
      expect(png.width).toBe(frame.width);
      expect(png.height).toBe(frame.height);
      expect(stripVariance(png, frame.client.y)).toBeGreaterThan(15);
      const page = solid(Math.max(1, frame.client.width), Math.max(1, frame.client.height), [12, 90, 180, 255]);
      const combined = PNG.sync.read(compositePageIntoFrame(frame.png, PNG.sync.write(page), frame.client));
      const header = pixel(png, Math.floor(frame.width / 5), Math.floor(frame.client.y / 2));
      expect(pixel(combined, Math.floor(frame.width / 5), Math.floor(frame.client.y / 2))).toEqual(header);
      expect(pixel(combined, frame.client.x + 2, frame.client.y + 2)).toEqual([12, 90, 180, 255]);
      const close = hitHeader(frame, frame.width - 8, Math.floor(frame.client.y / 2));
      expect(close?.selector).toBe("window:close");
      expect(await nativeControlVisible({ pid: probe.pid ?? 0, appPath: exe }, "window:close")).toBe(true);
      await performCaptionAction({ pid: probe.pid ?? 0, appPath: exe }, "close");
      expect(await exitedWithin(probe, 5_000)).toBe(true);
    } finally {
      if (probe.exitCode == null && !probe.killed) probe.kill();
    }
  }, 40_000);

  it("detects a folder picker owned by the app and can cancel it", async () => {
    if (process.platform !== "win32") return;
    const root = process.env.SystemRoot || "C:\\Windows";
    const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const probe = spawn(exe, ["-NoProfile", "-Sta", "-WindowStyle", "Hidden", "-Command", folderScript()], {
      windowsHide: false,
      stdio: "ignore"
    });
    try {
      const popup = await waitForPopupWindow(probe.pid ?? 0, exe, "Select output folder");
      expect(popup, lastNativeFrameError()).toBeTruthy();
      if (!popup) return;
      expect(popup.title).toContain("Select output folder");
      const frame = await captureNativeFrame({ pid: probe.pid ?? 0, appPath: exe, hwnd: popup.hwnd });
      expect(frame?.popup).toBe(true);
      expect(frame?.controls.some(control => control.label === "Cancel")).toBe(true);
      await invokeNativeControl({ pid: probe.pid ?? 0, appPath: exe, hwnd: popup.hwnd }, "Cancel");
      const gone = await waitUntil(async () => {
        const windows = await listNativePopups({ pid: probe.pid ?? 0, appPath: exe });
        return !windows.some(window => window.hwnd === popup.hwnd);
      }, 5_000);
      expect(gone).toBe(true);
    } finally {
      if (probe.exitCode == null && !probe.killed) probe.kill();
    }
  }, 40_000);

  it("types into the folder name box instead of the Folder label", async () => {
    if (process.platform !== "win32") return;
    const root = process.env.SystemRoot || "C:\\Windows";
    const exe = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const probe = spawn(exe, ["-NoProfile", "-Sta", "-WindowStyle", "Hidden", "-Command", pickerScript()], {
      windowsHide: false,
      stdio: "ignore"
    });
    try {
      const popup = await waitForPopupWindow(probe.pid ?? 0, exe, "Select output folder");
      expect(popup, lastNativeFrameError()).toBeTruthy();
      if (!popup) return;
      const frame = await captureNativeFrame({ pid: probe.pid ?? 0, appPath: exe, hwnd: popup.hwnd });
      const field = frame?.controls.find(control => control.label === "Folder:" && control.tag === "edit");
      expect(field?.bounds.width).toBeGreaterThan(200);
      const app = { pid: probe.pid ?? 0, appPath: exe, hwnd: popup.hwnd };
      await invokeNativeControl(app, "Folder:");
      await setNativeText(app, "Folder:", "C:\\Temp\\solidflow-folder-box");
      expect(await readNativeText(app, "Folder:")).toBe("C:\\Temp\\solidflow-folder-box");
      await invokeNativeControl(app, "Cancel");
    } finally {
      if (probe.exitCode == null && !probe.killed) probe.kill();
    }
  }, 40_000);
});

function exitedWithin(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  if (child.exitCode != null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(child.exitCode != null), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function probeScript(): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'Target App Probe'",
    "$form.FormBorderStyle = 'Sizable'",
    "$form.StartPosition = 'Manual'",
    "$form.Location = New-Object System.Drawing.Point(60, 60)",
    "$form.ClientSize = New-Object System.Drawing.Size(640, 400)",
    "$form.Show()",
    "$deadline = [DateTime]::UtcNow.AddMinutes(2)",
    "while ($form.Visible -and [DateTime]::UtcNow -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }",
    "$form.Dispose()"
  ].join("; ");
}

function pickerScript(): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$source = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "[ComImport, Guid(\"DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7\")]",
    "class FileOpenDialogRCW {}",
    "[ComImport, Guid(\"d57c7288-d4ad-4768-be02-9d969532d960\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]",
    "interface IFileDialogProbe {",
    "  [PreserveSig] int Show(IntPtr parent);",
    "  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);",
    "  void SetFileTypeIndex(uint iFileType);",
    "  void GetFileTypeIndex(out uint piFileType);",
    "  void Advise(IntPtr pfde, out uint pdwCookie);",
    "  void Unadvise(uint dwCookie);",
    "  void SetOptions(uint fos);",
    "  void GetOptions(out uint fos);",
    "  void SetDefaultFolder(IntPtr psi);",
    "  void SetFolder(IntPtr psi);",
    "  void GetFolder(out IntPtr ppsi);",
    "  void GetCurrentSelection(out IntPtr ppsi);",
    "  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);",
    "  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);",
    "  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);",
    "  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);",
    "  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);",
    "  void GetResult(out IntPtr ppsi);",
    "  void AddPlace(IntPtr psi, uint fdap);",
    "  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);",
    "  void Close(int hr);",
    "  void SetClientGuid(ref Guid guid);",
    "  void ClearClientData();",
    "  void SetFilter(IntPtr pFilter);",
    "}",
    "public static class FolderProbe {",
    "  public static void Show(IntPtr owner) {",
    "    IFileDialogProbe dialog = (IFileDialogProbe)new FileOpenDialogRCW();",
    "    dialog.SetOptions(0x20 | 0x40);",
    "    dialog.SetTitle(\"Select output folder\");",
    "    dialog.SetOkButtonLabel(\"Select Folder\");",
    "    dialog.Show(owner);",
    "  }",
    "}",
    "'@",
    "Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'Target App Probe'",
    "$form.StartPosition = 'Manual'",
    "$form.Location = New-Object System.Drawing.Point(40, 40)",
    "$form.ClientSize = New-Object System.Drawing.Size(480, 240)",
    "$form.Show()",
    "$timer = New-Object System.Windows.Forms.Timer",
    "$timer.Interval = 400",
    "$script:opened = $false",
    "$timer.Add_Tick({ if ($script:opened) { return }; $script:opened = $true; $timer.Stop(); [FolderProbe]::Show($form.Handle) })",
    "$timer.Start()",
    "$deadline = [DateTime]::UtcNow.AddMinutes(2)",
    "while ($form.Visible -and [DateTime]::UtcNow -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }",
    "$form.Dispose()"
  ].join("\n");
}

function folderScript(): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'Target App Probe'",
    "$form.StartPosition = 'Manual'",
    "$form.Location = New-Object System.Drawing.Point(80, 80)",
    "$form.ClientSize = New-Object System.Drawing.Size(640, 400)",
    "$form.Show()",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Title = 'Select output folder'",
    "$timer = New-Object System.Windows.Forms.Timer",
    "$timer.Interval = 400",
    "$script:opened = $false",
    "$timer.Add_Tick({ if ($script:opened) { return }; $script:opened = $true; $timer.Stop(); [void]$dialog.ShowDialog($form) })",
    "$timer.Start()",
    "$deadline = [DateTime]::UtcNow.AddMinutes(2)",
    "while ($form.Visible -and [DateTime]::UtcNow -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }",
    "$form.Dispose()"
  ].join("; ");
}

async function waitForPopupWindow(pid: number, appPath: string, title: string) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const windows = await listNativePopups({ pid, appPath });
    const found = windows.find(window => window.title.includes(title));
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

async function waitForFrame(pid: number, appPath: string) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const frame = await captureNativeFrame({ pid, appPath });
    if (frame?.title.includes("Target App Probe")) return frame;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

function solid(width: number, height: number, rgba: [number, number, number, number]): PNG {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return png;
}

function pixel(png: PNG, x: number, y: number): number[] {
  const i = (y * png.width + x) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0, png.data[i + 3] ?? 0];
}

function stripVariance(png: PNG, titleHeight: number): number {
  const y1 = Math.max(1, titleHeight);
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  const step = Math.max(1, Math.floor(png.width / 40));
  for (let y = 1; y < y1; y += Math.max(1, Math.floor(y1 / 3))) {
    for (let x = 4; x < png.width - 4; x += step) {
      const [r, g, b] = pixel(png, x, y);
      const lum = (r + g + b) / 3;
      sum += lum;
      sum2 += lum * lum;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}
