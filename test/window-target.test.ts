import { describe, expect, it } from "vitest";
import { FlowError } from "../src/types.js";
import {
  describeWindowQuery,
  hwndForBounds,
  outerBounds,
  pageFileName,
  parseWindowQuery,
  urlMatchesFile
} from "../src/driver/window-target.js";

describe("window target", () => {
  it("matches a page file and ignores the caption", () => {
    expect(urlMatchesFile("file:///C:/Program%20Files/Kyocera/renderer/ProxySettings.html", "ProxySettings.html")).toBe(
      true
    );
    expect(urlMatchesFile("http://127.0.0.1:5173/AppUpdate.html?dev=1", "appupdate.html")).toBe(true);
    expect(urlMatchesFile("file:///app/JobList.html", "Proxy settings")).toBe(false);
    expect(urlMatchesFile("file:///app/OrgLogin.html", "OrgLogin.html")).toBe(true);
    expect(pageFileName("file:///C:/Program%20Files/Kyocera/renderer/AppUpdate.html")).toBe("AppUpdate.html");
    expect(pageFileName("http://127.0.0.1:5173/AppUpdate.html?dev=1")).toBe("AppUpdate.html");
  });

  it("reads a file, a caption, or a heading", () => {
    expect(parseWindowQuery("Update available")).toEqual({
      file: "Update available",
      title: "Update available",
      text: "Update available",
      any: true
    });
    expect(parseWindowQuery({ file: "ProxySettings.html", timeout: 1000 })).toEqual({
      file: "ProxySettings.html",
      any: false
    });
    expect(parseWindowQuery({ title: "Proxy settings", text: "Direct connection" })).toEqual({
      title: "Proxy settings",
      text: "Direct connection",
      any: false
    });
    expect(describeWindowQuery(parseWindowQuery("Update available"))).toBe('"Update available"');
    expect(describeWindowQuery(parseWindowQuery({ file: "ProxySettings.html" }))).toBe('file "ProxySettings.html"');
    expect(() => parseWindowQuery("")).toThrow(FlowError);
    expect(() => parseWindowQuery({})).toThrow(/file, title, or text/);
  });

  it("pairs a window by size and keeps two close windows apart", () => {
    const proxy = { hwnd: "proxy", bounds: { x: 10, y: 20, width: 400, height: 328, dpi: 96 } };
    const update = { hwnd: "update", bounds: { x: 30, y: 40, width: 450, height: 240, dpi: 96 } };
    expect(hwndForBounds({ width: 400, height: 328 }, [proxy, update])).toBe("proxy");
    expect(hwndForBounds({ width: 450, height: 240 }, [proxy, update])).toBe("update");
    const scaled = { hwnd: "proxy", bounds: { x: 15, y: 30, width: 600, height: 492, dpi: 144 } };
    expect(hwndForBounds({ width: 400, height: 328 }, [scaled, update])).toBe("proxy");
    expect(
      hwndForBounds({ width: 400, height: 328 }, [
        proxy,
        { hwnd: "near", bounds: { x: 0, y: 0, width: 410, height: 336, dpi: 96 } }
      ])
    ).toBeNull();
    expect(hwndForBounds({ width: 80, height: 80 }, [proxy])).toBeNull();
    const measured = outerBounds({ left: -780, top: 219, width: 450, height: 240 });
    expect(measured).toEqual({ left: -780, top: 219, width: 450, height: 240 });
    expect(measured && hwndForBounds(measured, [update])).toBe("update");
    expect(outerBounds({ width: 0, height: 240 })).toBeNull();
    expect(outerBounds(null)).toBeNull();
  });
});
