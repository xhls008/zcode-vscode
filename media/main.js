// ZCode chat webview frontend. Plain browser JS (no bundler, CSP-locked). Talks
// to the extension host over postMessage; renders streaming answers, tool chips,
// reasoning folds, and plan/permission approval modals.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  const transcript = document.getElementById("transcript");
  const interactionHost = document.getElementById("interaction");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");
  const chipModel = document.getElementById("chip-model");
  const chipMode = document.getElementById("chip-mode");
  const chipThought = document.getElementById("chip-thought");
  const chipContext = document.getElementById("chip-context");

  let current = null; // the in-progress assistant bubble's DOM refs

  // ---- markdown rendering (escape-first, minimal, safe) ------------------

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInline(text) {
    // Escape, stash inline code, then apply emphasis/links, then restore code.
    let s = escapeHtml(text);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return "\x00" + (codes.length - 1) + "\x00";
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      const safe = /^https?:\/\//.test(u) ? u : "#";
      return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + t + "</a>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
    s = s.replace(/\x00(\d+)\x00/g, function (_, i) {
      return "<code>" + escapeHtml(codes[Number(i)]) + "</code>";
    });
    return s;
  }

  function renderMarkdown(md) {
    const lines = md.split("\n");
    let html = "";
    let i = 0;
    let listOpen = null; // "ul" | "ol" | null

    function closeList() {
      if (listOpen) {
        html += "</" + listOpen + ">";
        listOpen = null;
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        closeList();
        const lang = fence[1].trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // consume closing fence
        html +=
          '<div class="code-panel">' +
          (lang ? '<div class="code-lang">' + escapeHtml(lang) + "</div>" : "") +
          "<pre><code>" +
          escapeHtml(buf.join("\n")) +
          "</code></pre></div>";
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length, 6);
        html += '<div class="md-h md-h' + level + '">' + renderInline(heading[2]) + "</div>";
        i++;
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        closeList();
        html += '<hr class="md-hr" />';
        i++;
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        closeList();
        html += '<blockquote>' + renderInline(quote[1]) + "</blockquote>";
        i++;
        continue;
      }

      const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ol) {
        if (listOpen !== "ol") {
          closeList();
          html += "<ol>";
          listOpen = "ol";
        }
        html += "<li>" + renderInline(ol[2]) + "</li>";
        i++;
        continue;
      }
      if (ul) {
        if (listOpen !== "ul") {
          closeList();
          html += "<ul>";
          listOpen = "ul";
        }
        html += "<li>" + renderInline(ul[1]) + "</li>";
        i++;
        continue;
      }

      if (line.trim() === "") {
        closeList();
        i++;
        continue;
      }

      // Paragraph: gather consecutive non-blank, non-special lines.
      closeList();
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^\s*```/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^\s*[-*+]\s/.test(lines[i]) &&
        !/^\s*\d+[.)]\s/.test(lines[i]) &&
        !/^>/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      html += "<p>" + renderInline(para.join("\n")).replace(/\n/g, "<br/>") + "</p>";
    }
    closeList();
    return html;
  }

  // ---- transcript bubbles ----------------------------------------------

  function scrollToBottom() {
    transcript.scrollTop = transcript.scrollHeight;
  }

  function addUserBubble(text) {
    const msg = el("div", "msg user");
    msg.appendChild(el("div", "role", "›"));
    const body = el("div", "body");
    body.appendChild(el("div", "content", text, true));
    msg.appendChild(body);
    transcript.appendChild(msg);
    scrollToBottom();
  }

  function addSystemLine(text, kind) {
    const line = el("div", "sysline " + (kind || ""));
    line.textContent = text;
    transcript.appendChild(line);
    scrollToBottom();
  }

  function addAssistantBubble() {
    const msg = el("div", "msg assistant");
    msg.appendChild(el("div", "role", "●"));
    const body = el("div", "body");
    const tools = el("div", "tools");
    const reasoning = el("details", "reasoning hidden");
    const rsum = el("summary", "", "reasoning");
    const rpre = el("pre", "reasoning-body");
    reasoning.appendChild(rsum);
    reasoning.appendChild(rpre);
    const content = el("div", "content");
    const meta = el("div", "meta");
    meta.innerHTML = '<span class="spinner"></span> thinking…';
    body.appendChild(tools);
    body.appendChild(reasoning);
    body.appendChild(content);
    body.appendChild(meta);
    msg.appendChild(body);
    transcript.appendChild(msg);
    current = { msg, tools, reasoning, rpre, content, meta, toolEls: {} };
    scrollToBottom();
  }

  function addAssistantHistory(text) {
    const msg = el("div", "msg assistant");
    msg.appendChild(el("div", "role", "●"));
    const body = el("div", "body");
    const content = el("div", "content");
    content.innerHTML = renderMarkdown(text);
    body.appendChild(content);
    msg.appendChild(body);
    transcript.appendChild(msg);
    scrollToBottom();
  }

  function el(tag, cls, text, plain) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) {
      if (plain) e.textContent = text;
      else e.textContent = text;
    }
    return e;
  }

  // ---- tool chips -------------------------------------------------------

  function toolLabel(tool) {
    let summary = "";
    try {
      const parsed = JSON.parse(tool.input || "{}");
      const parts = Object.values(parsed)
        .filter((v) => typeof v === "string")
        .map((s) => s.split("/").pop())
        .filter(Boolean);
      summary = parts.join(" ");
    } catch (_) {
      /* partial JSON mid-stream */
    }
    return summary ? tool.name + "  " + summary : tool.name;
  }

  function upsertTool(tool, finished) {
    if (!current) return;
    let chip = current.toolEls[tool.index];
    if (!chip) {
      chip = el("div", "tool-chip running");
      const head = el("div", "tool-head");
      head.appendChild(el("span", "tool-dot"));
      head.appendChild(el("span", "tool-name"));
      chip.appendChild(head);
      current.tools.appendChild(chip);
      current.toolEls[tool.index] = chip;
    }
    chip.querySelector(".tool-name").textContent = toolLabel(tool);
    if (finished) {
      chip.className = "tool-chip " + (tool.success ? "ok" : "fail");
      const head = chip.querySelector(".tool-head");
      if (tool.durationMs != null && !head.querySelector(".tool-dur")) {
        head.appendChild(el("span", "tool-dur", (tool.durationMs / 1000).toFixed(1) + "s"));
      }
      if (tool.output && !chip.querySelector(".tool-out")) {
        const det = el("details", "tool-out");
        det.appendChild(el("summary", "", "output"));
        const pre = el("pre");
        pre.textContent = tool.output;
        det.appendChild(pre);
        chip.appendChild(det);
      }
    }
    scrollToBottom();
  }

  // ---- interaction modal ------------------------------------------------

  function showInteraction(req) {
    interactionHost.className = "";
    interactionHost.innerHTML = "";
    const modal = el("div", "modal");
    modal.appendChild(el("div", "modal-title", req.prompt || req.toolName || "Approval required"));
    if (req.plan) {
      const pre = el("pre", "modal-plan");
      pre.textContent = req.plan;
      modal.appendChild(pre);
    }
    const q = req.questions && req.questions[0];
    if (q && q.question) {
      modal.appendChild(el("div", "modal-q", q.question));
    }
    const opts = el("div", "modal-opts");
    (q ? q.options : []).forEach((opt, index) => {
      const b = el("button", "modal-opt");
      b.textContent = opt.description ? opt.label + " — " + opt.description : opt.label;
      b.addEventListener("click", function () {
        vscode.postMessage({ type: "interactionReply", requestId: req.requestId, index: index });
      });
      opts.appendChild(b);
    });
    modal.appendChild(opts);
    interactionHost.appendChild(modal);
  }

  function hideInteraction() {
    interactionHost.className = "hidden";
    interactionHost.innerHTML = "";
  }

  // ---- footer state -----------------------------------------------------

  function updateState(s) {
    chipModel.textContent = s.modelLabel || s.modelId || "model";
    chipMode.textContent = s.mode || "mode";
    chipThought.textContent = "think: " + (s.thought || "?");
    if (s.contextWindow) {
      const pct = Math.min(100, Math.round((s.contextUsed / s.contextWindow) * 100));
      chipContext.textContent = pct + "% ctx";
      chipContext.classList.toggle("warn", pct >= 80);
    } else {
      chipContext.textContent = "";
    }
  }

  function setBusy(busy) {
    stopBtn.classList.toggle("hidden", !busy);
    sendBtn.classList.toggle("hidden", busy);
  }

  // ---- host → webview ---------------------------------------------------

  window.addEventListener("message", function (event) {
    const m = event.data;
    switch (m.type) {
      case "reset":
        transcript.innerHTML = "";
        current = null;
        hideInteraction();
        setBusy(false);
        break;
      case "turnStart":
        addAssistantBubble();
        setBusy(true);
        break;
      case "assistantText":
        if (!current) addAssistantBubble();
        current.content.innerHTML = renderMarkdown(m.text);
        scrollToBottom();
        break;
      case "reasoning":
        if (current) {
          current.reasoning.classList.remove("hidden");
          current.rpre.textContent = m.text;
        }
        break;
      case "toolStart":
        upsertTool(m.tool, false);
        break;
      case "toolFinish":
        upsertTool(m.tool, true);
        break;
      case "turnEnd":
        if (current) {
          if (m.info && m.info.error) {
            current.meta.innerHTML = '<span class="err">✗ ' + escapeHtml(m.info.error) + "</span>";
          } else if (m.info && m.info.note) {
            current.meta.textContent = m.info.note;
          } else {
            current.meta.textContent = "";
          }
        }
        current = null;
        setBusy(false);
        break;
      case "state":
        updateState(m.snapshot);
        break;
      case "interaction":
        showInteraction(m.request);
        break;
      case "interactionResolved":
        hideInteraction();
        break;
      case "notice":
        addSystemLine(m.text, "notice");
        break;
      case "error":
        addSystemLine(m.text, "error");
        setBusy(false);
        break;
      case "replay":
        (m.messages || []).forEach(function (msg) {
          if (msg.role === "user") addUserBubble(msg.preview);
          else addAssistantHistory(msg.preview);
        });
        break;
      case "focusInput":
        input.focus();
        break;
      default:
        break;
    }
  });

  // ---- composer + controls ---------------------------------------------

  function submit() {
    const text = input.value;
    if (text.trim() === "") return;
    addUserBubble(text);
    vscode.postMessage({ type: "send", text: text });
    input.value = "";
    autogrow();
  }

  function autogrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  input.addEventListener("input", autogrow);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  sendBtn.addEventListener("click", submit);
  stopBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "cancel" });
  });
  chipModel.addEventListener("click", function () {
    vscode.postMessage({ type: "pickModel" });
  });
  chipMode.addEventListener("click", function () {
    vscode.postMessage({ type: "pickMode" });
  });
  chipThought.addEventListener("click", function () {
    vscode.postMessage({ type: "pickThought" });
  });
  document.getElementById("btn-new").addEventListener("click", function () {
    vscode.postMessage({ type: "newSession" });
  });
  document.getElementById("btn-resume").addEventListener("click", function () {
    vscode.postMessage({ type: "resume" });
  });
  document.getElementById("btn-rewind").addEventListener("click", function () {
    vscode.postMessage({ type: "rewind" });
  });
  document.getElementById("btn-compact").addEventListener("click", function () {
    vscode.postMessage({ type: "compact" });
  });
})();
