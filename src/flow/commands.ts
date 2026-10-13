export type CommandCategory =
  | "Navigation"
  | "Assertions"
  | "Text"
  | "Timing & Sequences"
  | "Screenshots & Recordings"
  | "App State"
  | "Phone Settings"
  | "External Resources"
  | "SolidFlow";

export type CommandInsert =
  | { type: "bare" }
  | { type: "selector" }
  | { type: "input" }
  | { type: "template"; body: string };

export type CommandInfo = {
  name: string;
  category: CommandCategory;
  summary: string;
  docs: string;
  available: boolean;
  reason?: string;
  usesSelector: boolean;
  insert: CommandInsert;
  yaml: string;
};

const ALIASES: Record<string, string> = {
  doubleTap: "doubleTapOn",
  longPress: "longPressOn"
};

const UNAVAILABLE: Record<string, string> = {
  addMedia: "addMedia targets the device photo gallery. This desktop driver cannot add media to a phone gallery.",
  assertNoDefectsWithAI: "assertNoDefectsWithAI calls a hosted AI service, which is not part of SolidFlow.",
  assertWithAI: "assertWithAI calls a hosted AI service, which is not part of SolidFlow.",
  extractTextWithAI: "extractTextWithAI calls a hosted AI service, which is not part of SolidFlow.",
  clearKeychain: "clearKeychain is an iOS keychain command. There is no keychain on this desktop driver.",
  setAirplaneMode: "setAirplaneMode would change the computer's network. SolidFlow does not toggle airplane mode.",
  toggleAirplaneMode: "toggleAirplaneMode would change the computer's network. SolidFlow does not toggle airplane mode.",
  startRecording: "Screen recording is not available on the WebView2 driver. Use takeScreenshot for each step.",
  stopRecording: "Screen recording is not available on the WebView2 driver. Use takeScreenshot for each step.",
  travel: "travel changes the device clock. SolidFlow does not change the Windows system time."
};

type Spec = Omit<CommandInfo, "docs" | "yaml">;

const SPECS: Spec[] = [
  { name: "tapOn", category: "Navigation", summary: "Tap an element, or a point on the screen.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "doubleTapOn", category: "Navigation", summary: "Double-tap an element or a point.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "longPressOn", category: "Navigation", summary: "Press an element for a long hold.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "scroll", category: "Navigation", summary: "Scroll the page. Direction is UP, DOWN, LEFT, or RIGHT.", available: true, usesSelector: false, insert: { type: "template", body: "- scroll:\n    direction: DOWN" } },
  { name: "scrollUntilVisible", category: "Navigation", summary: "Scroll until an element is visible.", available: true, usesSelector: true, insert: { type: "template", body: "- scrollUntilVisible:\n    element: {{q}}\n    direction: DOWN\n    timeout: 20000" } },
  { name: "swipe", category: "Navigation", summary: "Swipe LEFT, RIGHT, UP, or DOWN.", available: true, usesSelector: false, insert: { type: "template", body: "- swipe:\n    direction: LEFT" } },
  { name: "back", category: "Navigation", summary: "Go back to the previous page.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "pressKey", category: "Navigation", summary: "Press a key such as Enter, Tab, Escape, or an arrow key.", available: true, usesSelector: false, insert: { type: "template", body: "- pressKey: Enter" } },
  { name: "assertVisible", category: "Assertions", summary: "Assert that an element is visible.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "assertNotVisible", category: "Assertions", summary: "Assert that an element is not visible.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "assertTrue", category: "Assertions", summary: "Assert that a JavaScript expression is true. Use output and solidflow.copiedText.", available: true, usesSelector: false, insert: { type: "template", body: '- assertTrue: "output.ready === true"' } },
  { name: "assertDarkMode", category: "Assertions", summary: "Assert that the page is using dark color scheme.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "assertLightMode", category: "Assertions", summary: "Assert that the page is using light color scheme.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "assertWithAI", category: "Assertions", summary: "AI assertion.", available: false, reason: UNAVAILABLE.assertWithAI, usesSelector: false, insert: { type: "template", body: '- assertWithAI: "description"' } },
  { name: "assertNoDefectsWithAI", category: "Assertions", summary: "AI visual defect check.", available: false, reason: UNAVAILABLE.assertNoDefectsWithAI, usesSelector: false, insert: { type: "bare" } },
  { name: "inputText", category: "Text", summary: "Type into the selected field, or into the focused field when no field is selected.", available: true, usesSelector: true, insert: { type: "input" } },
  { name: "eraseText", category: "Text", summary: "Clear a field, or delete N characters from the focused field.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "copyTextFrom", category: "Text", summary: "Copy an element's text into solidflow.copiedText.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "pasteText", category: "Text", summary: "Type solidflow.copiedText into the focused field.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "setClipboard", category: "Text", summary: "Set solidflow.copiedText to a value.", available: true, usesSelector: false, insert: { type: "template", body: '- setClipboard: "text"' } },
  { name: "extendedWaitUntil", category: "Timing & Sequences", summary: "Wait until an element is visible or hidden, with your own timeout.", available: true, usesSelector: true, insert: { type: "template", body: "- extendedWaitUntil:\n    visible: {{q}}\n    timeout: 10000" } },
  { name: "waitForAnimationToEnd", category: "Timing & Sequences", summary: "Wait until CSS animations on the page finish.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "repeat", category: "Timing & Sequences", summary: "Repeat commands a number of times, or while an element is visible.", available: true, usesSelector: true, insert: { type: "template", body: "- repeat:\n    times: 2\n    commands:\n      - tapOn: {{q}}" } },
  { name: "retry", category: "Timing & Sequences", summary: "Retry a block of commands until it succeeds.", available: true, usesSelector: true, insert: { type: "template", body: "- retry:\n    maxRetries: 3\n    commands:\n      - tapOn: {{q}}" } },
  { name: "runFlow", category: "Timing & Sequences", summary: "Run another flow file, or an inline list of commands.", available: true, usesSelector: false, insert: { type: "template", body: "- runFlow:\n    file: subflow.yaml" } },
  { name: "evalScript", category: "Timing & Sequences", summary: "Run JavaScript in the flow. Assign variables on output.", available: true, usesSelector: false, insert: { type: "template", body: '- evalScript: "output.ready = true"' } },
  { name: "takeScreenshot", category: "Screenshots & Recordings", summary: "Save a screenshot into the run report.", available: true, usesSelector: false, insert: { type: "template", body: "- takeScreenshot: screen" } },
  { name: "assertScreenshot", category: "Screenshots & Recordings", summary: "Compare the screen with a baseline PNG.", available: true, usesSelector: false, insert: { type: "template", body: "- assertScreenshot: screen" } },
  { name: "startRecording", category: "Screenshots & Recordings", summary: "Start a screen recording.", available: false, reason: UNAVAILABLE.startRecording, usesSelector: false, insert: { type: "bare" } },
  { name: "stopRecording", category: "Screenshots & Recordings", summary: "Stop a screen recording.", available: false, reason: UNAVAILABLE.stopRecording, usesSelector: false, insert: { type: "bare" } },
  { name: "launchApp", category: "App State", summary: "Launch the app. clearState relaunches from a fresh profile.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "stopApp", category: "App State", summary: "Stop the app and keep its data.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "killApp", category: "App State", summary: "Force-stop the app. Set clearState: true to wipe its profile.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "clearState", category: "App State", summary: "Delete the app profile and stop the app.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "clearKeychain", category: "App State", summary: "Clear the iOS keychain.", available: false, reason: UNAVAILABLE.clearKeychain, usesSelector: false, insert: { type: "bare" } },
  { name: "hideKeyboard", category: "Phone Settings", summary: "Blur the focused field. Desktop apps have no soft keyboard.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "setOrientation", category: "Phone Settings", summary: "Switch the viewport between PORTRAIT and LANDSCAPE.", available: true, usesSelector: false, insert: { type: "template", body: "- setOrientation: LANDSCAPE" } },
  { name: "setLocation", category: "Phone Settings", summary: "Set the browser geolocation used by the page.", available: true, usesSelector: false, insert: { type: "template", body: "- setLocation:\n    latitude: 0\n    longitude: 0" } },
  { name: "setDarkMode", category: "Phone Settings", summary: "Set the page color scheme to dark or light.", available: true, usesSelector: false, insert: { type: "template", body: "- setDarkMode: true" } },
  { name: "toggleDarkMode", category: "Phone Settings", summary: "Toggle the page color scheme.", available: true, usesSelector: false, insert: { type: "bare" } },
  { name: "setPermissions", category: "Phone Settings", summary: "Grant or deny browser permissions: location, camera, microphone, notifications, clipboard.", available: true, usesSelector: false, insert: { type: "template", body: "- setPermissions:\n    permissions:\n      location: allow" } },
  { name: "setAirplaneMode", category: "Phone Settings", summary: "Toggle device airplane mode.", available: false, reason: UNAVAILABLE.setAirplaneMode, usesSelector: false, insert: { type: "template", body: "- setAirplaneMode: true" } },
  { name: "toggleAirplaneMode", category: "Phone Settings", summary: "Toggle device airplane mode.", available: false, reason: UNAVAILABLE.toggleAirplaneMode, usesSelector: false, insert: { type: "bare" } },
  { name: "travel", category: "Phone Settings", summary: "Change the device clock.", available: false, reason: UNAVAILABLE.travel, usesSelector: false, insert: { type: "template", body: "- travel:\n    time: 2026-01-01T00:00:00Z" } },
  { name: "openLink", category: "External Resources", summary: "Open an http or https URL in the app window.", available: true, usesSelector: false, insert: { type: "template", body: '- openLink: "https://example.com"' } },
  { name: "runScript", category: "External Resources", summary: "Run a JavaScript file from the flow directory.", available: true, usesSelector: false, insert: { type: "template", body: "- runScript:\n    file: script.js" } },
  { name: "addMedia", category: "External Resources", summary: "Add a file to the device gallery.", available: false, reason: UNAVAILABLE.addMedia, usesSelector: false, insert: { type: "template", body: "- addMedia:\n    files:\n      - photo.png" } },
  { name: "extractTextWithAI", category: "External Resources", summary: "Extract text with a hosted AI service.", available: false, reason: UNAVAILABLE.extractTextWithAI, usesSelector: false, insert: { type: "template", body: '- extractTextWithAI:\n    query: "the title"' } },
  { name: "assertText", category: "SolidFlow", summary: "Assert an element's text. mode can be partial or regex.", available: true, usesSelector: true, insert: { type: "template", body: "- assertText:\n    target: {{q}}\n    text: expected" } },
  { name: "waitForVisible", category: "SolidFlow", summary: "Wait up to 30 seconds for an element to appear.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "waitForHidden", category: "SolidFlow", summary: "Wait until an element is hidden.", available: true, usesSelector: true, insert: { type: "selector" } },
  { name: "executeScript", category: "SolidFlow", summary: "Run JavaScript inside the app page.", available: true, usesSelector: false, insert: { type: "template", body: '- executeScript: "document.title"' } },
  { name: "executeShellCommand", category: "SolidFlow", summary: "Run a local command. Requires SOLIDFLOW_ALLOW_SHELL=1 and an argument list.", available: true, usesSelector: false, insert: { type: "template", body: "- executeShellCommand:\n    args:\n      - echo\n      - hello" } },
  { name: "waitForPopup", category: "SolidFlow", summary: "Wait for the next window from the connected app, including a folder picker, then continue there. A separate system browser is not followed. Optional timeout is milliseconds.", available: true, usesSelector: false, insert: { type: "template", body: "- waitForPopup:\n    timeout: 10000" } },
  { name: "switchToMain", category: "SolidFlow", summary: "Return to the original app window.", available: true, usesSelector: false, insert: { type: "bare" } },
  {
    name: "section",
    category: "SolidFlow",
    summary: "Group commands into a named section for Results reporting.",
    available: true,
    usesSelector: false,
    insert: {
      type: "template",
      body: "- section:\n    number: 1\n    name: Section name\n    description: What this section covers\n    steps:"
    }
  },
  {
    name: "archiveData",
    category: "SolidFlow",
    summary:
      "Copy or move (cut) a folder's contents into this run's test-results/.../archive. Waits until transfer finishes. action: copy | move.",
    available: true,
    usesSelector: false,
    insert: {
      type: "template",
      body: "- archiveData:\n    action: move\n    location: path/to/folder"
    }
  }
];

export function canonicalCommand(name: string): string {
  return ALIASES[name] ?? name;
}

export function unavailableReason(name: string): string | undefined {
  return UNAVAILABLE[canonicalCommand(name)];
}

export function quoteYaml(value: string): string {
  return /[:#\n"']|\s/.test(value) ? JSON.stringify(value) : value;
}

export function commandYaml(spec: Pick<Spec, "name" | "insert" | "usesSelector">, selector: string): string {
  const quoted = quoteYaml(selector || "Selector");
  if (spec.insert.type === "bare") return `- ${spec.name}`;
  if (spec.insert.type === "selector") return `- ${spec.name}: ${quoted}`;
  if (spec.insert.type === "input") {
    return selector ? `- inputText: ${JSON.stringify(`${selector}|`)}` : `- inputText: ""`;
  }
  return spec.insert.body.replaceAll("{{q}}", quoted);
}

export function listCommands(selector = ""): CommandInfo[] {
  return SPECS.map(spec => ({
    ...spec,
    docs: `https://docs.maestro.dev/reference/commands-available/${spec.name.toLowerCase()}`,
    yaml: commandYaml(spec, spec.usesSelector ? selector : "")
  }));
}

export const MAESTRO_COMMAND_NAMES = [
  "addMedia",
  "assertDarkMode",
  "assertLightMode",
  "assertNoDefectsWithAI",
  "assertNotVisible",
  "assertScreenshot",
  "assertTrue",
  "assertVisible",
  "assertWithAI",
  "back",
  "clearKeychain",
  "clearState",
  "copyTextFrom",
  "doubleTapOn",
  "eraseText",
  "evalScript",
  "extendedWaitUntil",
  "extractTextWithAI",
  "hideKeyboard",
  "inputText",
  "killApp",
  "launchApp",
  "longPressOn",
  "openLink",
  "pasteText",
  "pressKey",
  "repeat",
  "retry",
  "runFlow",
  "runScript",
  "scroll",
  "scrollUntilVisible",
  "setAirplaneMode",
  "setClipboard",
  "setDarkMode",
  "setLocation",
  "setOrientation",
  "setPermissions",
  "startRecording",
  "stopApp",
  "stopRecording",
  "swipe",
  "takeScreenshot",
  "tapOn",
  "toggleAirplaneMode",
  "toggleDarkMode",
  "travel",
  "waitForAnimationToEnd"
] as const;
