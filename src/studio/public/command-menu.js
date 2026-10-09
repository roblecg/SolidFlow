const CATEGORIES = [
  "Navigation",
  "Assertions",
  "Text",
  "Timing & Sequences",
  "Screenshots & Recordings",
  "App State",
  "Phone Settings",
  "External Resources",
  "SolidFlow"
];

const QUICK = ["tapOn", "assertVisible", "scrollUntilVisible"];

async function loadCommands(selector) {
  const query = selector ? `?selector=${encodeURIComponent(selector)}` : "";
  const res = await fetch(`/api/commands${query}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body.commands || [];
}

function button(label, className, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  if (className) el.className = className;
  el.textContent = label;
  el.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    onClick(el);
  };
  return el;
}

function place(panel, anchor, width) {
  const rect = anchor.getBoundingClientRect();
  const openLeft = rect.right + width + 8 > window.innerWidth;
  panel.style.left = (openLeft ? Math.max(8, rect.left - width - 6) : rect.right + 6) + "px";
  panel.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - 360)) + "px";
}

function clearFlyouts(root) {
  root.querySelectorAll(".flyout").forEach(node => node.remove());
}

function leafMenu(command, options) {
  const panel = document.createElement("div");
  panel.className = "flyout";
  const preview = document.createElement("div");
  preview.className = "hint";
  preview.textContent = command.yaml;
  panel.append(preview);
  panel.append(
    button("Insert & Run", "", () => options.onRun(command.yaml)),
    button("Insert", "", () => options.onInsert(command.yaml)),
    button("Copy", "", async () => {
      await navigator.clipboard.writeText(command.yaml);
      options.onStatus?.("Copied");
    }),
    button("View docs", "", () => {
      window.open(command.docs, "_blank", "noopener");
    })
  );
  return panel;
}

function commandList(commands, options) {
  const panel = document.createElement("div");
  panel.className = "flyout";
  for (const command of commands) {
    const row = button(command.name, "sub", anchor => {
      panel.querySelectorAll(".flyout").forEach(node => node.remove());
      if (!command.available) return;
      const leaf = leafMenu(command, options);
      panel.append(leaf);
      place(leaf, anchor, 280);
    });
    if (!command.available) {
      row.disabled = true;
      row.title = command.reason || "Not available on the desktop driver";
    } else {
      row.append(document.createTextNode(""));
      const chev = document.createElement("span");
      chev.textContent = "›";
      row.append(chev);
    }
    panel.append(row);
  }
  return panel;
}

function categoryMenu(commands, options) {
  const panel = document.createElement("div");
  panel.className = "flyout";
  const groups = CATEGORIES.map(category => ({
    category,
    commands: commands.filter(command => command.category === category)
  })).filter(group => group.commands.length);
  groups.push({
    category: "All (Alphabetical)",
    commands: commands.slice().sort((a, b) => a.name.localeCompare(b.name))
  });
  for (const group of groups) {
    const row = button(group.category, "sub", anchor => {
      panel.querySelectorAll(":scope > .flyout").forEach(node => node.remove());
      const list = commandList(group.commands, options);
      panel.append(list);
      place(list, anchor, 240);
    });
    const chev = document.createElement("span");
    chev.textContent = "›";
    row.append(chev);
    panel.append(row);
  }
  return panel;
}

window.SolidFlowMenu = {
  async renderSidebar(host, onInsert) {
    const commands = await loadCommands("");
    host.innerHTML = "";
    for (const category of CATEGORIES) {
      const rows = commands.filter(command => command.category === category);
      if (!rows.length) continue;
      const title = document.createElement("div");
      title.className = "cmd-group";
      title.textContent = category;
      host.append(title);
      for (const command of rows) {
        const row = document.createElement("button");
        row.type = "button";
        row.textContent = command.name;
        row.title = command.available ? command.summary : command.reason || command.summary;
        row.disabled = !command.available;
        row.onclick = async () => {
          if (!command.available) return;
          const selector = window.SolidFlowMenu.currentSelector ? window.SolidFlowMenu.currentSelector() : "";
          const fresh = await loadCommands(selector);
          const match = fresh.find(item => item.name === command.name);
          if (match) onInsert(match.yaml);
        };
        host.append(row);
      }
    }
  },

  async open(menu, x, y, options) {
    clearFlyouts(menu);
    const commands = await loadCommands(options.selector || "");
    menu.innerHTML = "";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = options.selector || "No element selected";
    menu.append(hint);
    for (const name of QUICK) {
      const command = commands.find(item => item.name === name);
      if (!command) continue;
      menu.append(
        button(command.yaml, "yaml", () => {
          const leaf = leafMenu(command, options);
          menu.append(leaf);
          place(leaf, menu, 280);
        })
      );
    }
    const sep = document.createElement("div");
    sep.className = "sep";
    menu.append(sep);
    menu.append(
      button("Change selector", "sub", () => {
        const next = window.prompt("Selector", options.selector || "");
        if (!next || !next.trim()) return;
        options.selector = next.trim();
        void window.SolidFlowMenu.open(menu, x, y, options);
      })
    );
    menu.append(
      button("Selector commands", "sub", anchor => {
        clearFlyouts(menu);
        const list = commandList(
          commands.filter(command => command.usesSelector),
          options
        );
        menu.append(list);
        place(list, anchor, 240);
      })
    );
    menu.append(
      button("All commands", "sub", anchor => {
        clearFlyouts(menu);
        const list = categoryMenu(commands, options);
        menu.append(list);
        place(list, anchor, 260);
      })
    );
    menu.querySelectorAll("button.sub").forEach(row => {
      const chev = document.createElement("span");
      chev.textContent = "›";
      row.append(chev);
    });
    menu.hidden = false;
    menu.style.left = Math.min(x, window.innerWidth - 280) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 320)) + "px";
  }
};
