/**
 * Script injetado em cada página durante a gravação (via `addInitScript`).
 *
 * Fica como string de propósito: assim o tsx/esbuild não reescreve o código
 * (helpers como `__name` quebrariam dentro do navegador).
 *
 * Ele escuta cliques, digitação, selects, checkboxes e Enter/Escape, gera
 * seletores estáveis para o elemento e envia cada evento ao Node por dois
 * canais (o Node descarta duplicados pelo `id`):
 *  1. `navigator.sendBeacon` para um host fictício interceptado com
 *     `context.route` — sobrevive a navegações (o CloakBrowser bloqueia
 *     `exposeBinding` e o console da página, então não dá para usá-los);
 *  2. uma fila em `window.__awDrain()` + sessionStorage, lida por polling —
 *     reserva para sites cuja CSP bloqueia o beacon.
 *
 * Mostra um painel de ferramentas minimalista no rodapé da página.
 */

import { GENERATORS } from "./generators.js";

export const EVENT_ENDPOINT = "https://aw-recorder.invalid/event";
export const EVENT_ROUTE = "https://aw-recorder.invalid/**";

export const RECORDER_SCRIPT = String.raw`
(() => {
  if (window.top !== window) return;
  if (window.__awRecorderInstalled) return;
  window.__awRecorderInstalled = true;

  // === CONSTANTS ===
  const TB = "__aw_tb";
  const MENU_ID = "__aw_rec_menu";
  const HL_ID = "__aw_hl";
  const GENERATORS = ${JSON.stringify(GENERATORS)};
  const QKEY = "__aw_rec_q";

  // === EVENT QUEUE ===
  const DOC = Math.random().toString(36).slice(2);
  let seq = 0;
  let queue = [];
  try { queue = JSON.parse(sessionStorage.getItem(QKEY) || "[]"); } catch (_) {}
  const persist = () => { try { sessionStorage.setItem(QKEY, JSON.stringify(queue)); } catch (_) {} };
  window.__awDrain = () => { const out = queue; queue = []; persist(); return out; };
  const send = (ev) => {
    ev.id = DOC + ":" + (seq++);
    ev.at = Date.now();
    queue.push(ev);
    if (queue.length > 500) queue.shift();
    persist();
    try { navigator.sendBeacon("${EVENT_ENDPOINT}", JSON.stringify(ev)); } catch (_) {}
    addToLog(ev);
  };

  // === SELECTOR GENERATION ===
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const attrEsc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const looksGenerated = (s) => /\d{4,}|[a-f0-9]{10,}|^:r|^ember\d|^react-|__/.test(s);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

  function labelOf(el) {
    if (el.labels && el.labels.length) return text(el.labels[0]);
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const ph = el.getAttribute("placeholder");
    return ph ? ph.trim() : "";
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && !looksGenerated(node.id) && unique("#" + cssEsc(node.id))) {
        parts.unshift("#" + cssEsc(node.id));
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  }

  function candidates(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    const push = (s) => { if (s && !out.includes(s)) out.push(s); };
    for (const a of ["data-testid", "data-test", "data-qa", "data-cy"]) {
      const v = el.getAttribute(a);
      if (v && unique("[" + a + '="' + attrEsc(v) + '"]')) push("[" + a + '="' + attrEsc(v) + '"]');
    }
    if (el.id && !looksGenerated(el.id) && unique("#" + cssEsc(el.id))) push("#" + cssEsc(el.id));
    const name = el.getAttribute("name");
    if (name && unique(tag + '[name="' + attrEsc(name) + '"]')) push(tag + '[name="' + attrEsc(name) + '"]');
    const aria = el.getAttribute("aria-label");
    if (aria && unique(tag + '[aria-label="' + attrEsc(aria) + '"]')) push(tag + '[aria-label="' + attrEsc(aria) + '"]');
    const ph = el.getAttribute("placeholder");
    if (ph && unique(tag + '[placeholder="' + attrEsc(ph) + '"]')) push(tag + '[placeholder="' + attrEsc(ph) + '"]');
    if (/^(button|a|summary)$/.test(tag) || el.getAttribute("role") === "button") {
      const t = text(el);
      if (t && t.length <= 60) {
        const same = Array.from(document.querySelectorAll(tag)).filter((n) => text(n) === t);
        if (same.length === 1) push(tag + ':has-text("' + attrEsc(t) + '")');
      }
    }
    if (/^(input|textarea|select)$/.test(tag) && el.labels && el.labels.length) {
      const l = text(el.labels[0]);
      if (l && l.length <= 60) push('internal:label="' + attrEsc(l) + '"s');
    }
    push(cssPath(el));
    return out;
  }

  function target(el) {
    const c = candidates(el);
    const hint = (labelOf(el) || text(el) || el.tagName.toLowerCase()).slice(0, 60);
    return { selector: c[0], fallbacks: c.slice(1, 5), hint };
  }

  // === HELPERS ===
  const INTERACTIVE = "button, a, summary, label, select, textarea, input, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [onclick]";
  const isToggle = (el) => el && el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type);
  const isTextField = (el) => el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(checkbox|radio|submit|button|reset|image|file|range|color)$/i.test(el.type)));
  const fieldName = (el) => el.getAttribute("name") || el.id || labelOf(el) || el.type || "campo";
  const ours = (el) => el && el.closest && el.closest("#" + TB + ",#" + MENU_ID);

  // === UI STATE ===
  let pickMode = null;
  let stepNum = 0;
  let startMs = Date.now();
  let expanded = false;
  let lastHover = null;
  let logItems = [];
  let activeTab = "tools";

  // DOM refs (set in createToolbar)
  let toolbar = null;
  let panel = null;
  let logEl = null;
  let countEl = null;
  let timerEl = null;
  let pickBanner = null;
  let toggleBtn = null;
  let hlOverlay = null;
  let toolBtns = {};
  let toolsView = null;
  let helpView = null;
  let tabEls = {};

  // === TOOLBAR ===
  function createToolbar() {
    if (document.getElementById(TB) || !document.body) return;

    // Inject keyframe animation (may fail under strict CSP — non-critical)
    try {
      const style = document.createElement("style");
      style.textContent = "@keyframes __awp{0%,100%{opacity:1}50%{opacity:.35}}";
      (document.head || document.documentElement).appendChild(style);
    } catch (_) {}

    // Highlight overlay for pick mode
    hlOverlay = document.createElement("div");
    hlOverlay.id = HL_ID;
    hlOverlay.setAttribute("style", "position:fixed;pointer-events:none;border:2px solid #3b82f6;border-radius:3px;z-index:2147483646;display:none;transition:all 80ms ease-out");
    document.body.appendChild(hlOverlay);

    toolbar = document.createElement("div");
    toolbar.id = TB;
    toolbar.setAttribute("style", "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;font:12px -apple-system,system-ui,'Segoe UI',sans-serif;color:#d4d4d4;background:#0c0c0c;border-top:1px solid #222;display:flex;flex-direction:column");

    // --- Pick mode banner (hidden by default) ---
    pickBanner = document.createElement("div");
    pickBanner.setAttribute("style", "display:none;align-items:center;gap:8px;padding:7px 14px;background:#172554;color:#93c5fd;font-size:12px;border-bottom:1px solid #1e3a5f");
    const pickText = document.createElement("span");
    pickText.setAttribute("style", "flex:1");
    pickBanner.appendChild(pickText);
    const pickCancel = document.createElement("button");
    pickCancel.type = "button";
    pickCancel.textContent = "Cancelar";
    pickCancel.setAttribute("style", "background:none;border:none;color:#93c5fd;cursor:pointer;font:inherit;text-decoration:underline;padding:0");
    pickCancel.onclick = (e) => { e.preventDefault(); e.stopPropagation(); exitPick(); };
    pickBanner.appendChild(pickCancel);
    toolbar.appendChild(pickBanner);

    // --- Status bar ---
    const bar = document.createElement("div");
    bar.setAttribute("style", "display:flex;align-items:center;height:36px;padding:0 14px;gap:10px;cursor:pointer;user-select:none");
    bar.onclick = (e) => {
      if (e.target.closest("button")) return;
      togglePanel();
    };

    // Recording dot
    const dot = document.createElement("span");
    dot.setAttribute("style", "width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0;animation:__awp 1.4s ease-in-out infinite");
    bar.appendChild(dot);

    const recLabel = document.createElement("span");
    recLabel.textContent = "REC";
    recLabel.setAttribute("style", "font-weight:600;font-size:10px;letter-spacing:1px;color:#ef4444;margin-right:4px");
    bar.appendChild(recLabel);

    // Step count
    countEl = document.createElement("span");
    countEl.textContent = "0 passos";
    countEl.setAttribute("style", "color:#888;font-size:11px");
    bar.appendChild(countEl);

    // Spacer
    const spacer = document.createElement("span");
    spacer.setAttribute("style", "flex:1");
    bar.appendChild(spacer);

    // Timer
    timerEl = document.createElement("span");
    timerEl.textContent = "00:00";
    timerEl.setAttribute("style", "color:#555;font-size:11px;font-variant-numeric:tabular-nums");
    bar.appendChild(timerEl);

    // Expand toggle
    toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.innerHTML = "&#9650;";
    toggleBtn.setAttribute("style", "background:none;border:1px solid #333;border-radius:4px;color:#777;cursor:pointer;font-size:9px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;transition:all .15s;padding:0");
    toggleBtn.onmouseenter = () => { toggleBtn.style.borderColor = "#555"; toggleBtn.style.color = "#bbb"; };
    toggleBtn.onmouseleave = () => { toggleBtn.style.borderColor = "#333"; toggleBtn.style.color = "#777"; };
    toggleBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); };
    bar.appendChild(toggleBtn);

    // Stop button
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.textContent = "Parar";
    stopBtn.setAttribute("style", "background:transparent;border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font:11px inherit;padding:4px 12px;transition:all .15s;margin-left:2px");
    stopBtn.onmouseenter = () => { stopBtn.style.background = "#dc2626"; stopBtn.style.borderColor = "#dc2626"; stopBtn.style.color = "#fff"; };
    stopBtn.onmouseleave = () => { stopBtn.style.background = "transparent"; stopBtn.style.borderColor = "#333"; stopBtn.style.color = "#888"; };
    stopBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); try { window.close(); } catch (_) {} };
    bar.appendChild(stopBtn);

    toolbar.appendChild(bar);

    // --- Expandable panel ---
    panel = document.createElement("div");
    panel.setAttribute("style", "display:none;flex-direction:column;border-top:1px solid #1a1a1a");

    // --- Tab bar ---
    var tabBar = document.createElement("div");
    tabBar.setAttribute("style", "display:flex;border-bottom:1px solid #161616;gap:0");
    [["tools", "Ferramentas"], ["help", "Referência"]].forEach(function(pair) {
      var tb = document.createElement("button");
      tb.type = "button";
      tb.textContent = pair[1];
      var act = pair[0] === "tools";
      tb.setAttribute("style", "flex:1;padding:8px 0;background:none;border:none;border-bottom:2px solid " + (act ? "#3b82f6" : "transparent") + ";color:" + (act ? "#ddd" : "#666") + ";cursor:pointer;font:11px -apple-system,system-ui,sans-serif;font-weight:" + (act ? "600" : "400") + ";transition:all .15s;letter-spacing:.3px");
      tb.onclick = function(e) { e.preventDefault(); e.stopPropagation(); switchTab(pair[0]); };
      tabBar.appendChild(tb);
      tabEls[pair[0]] = tb;
    });
    panel.appendChild(tabBar);

    // --- Tools view (default active) ---
    toolsView = document.createElement("div");
    toolsView.setAttribute("style", "display:flex;flex-direction:column");

    // Tool buttons row
    const toolsRow = document.createElement("div");
    toolsRow.setAttribute("style", "display:flex;gap:5px;padding:8px 14px;border-bottom:1px solid #161616");

    const tools = [
      { id: "checkpoint", label: "Verificar", shortcut: "Alt+Click", icon: "✓", pickable: true,
        desc: "Clique no elemento que deve aparecer na página" },
      { id: "random", label: "Aleatório", shortcut: "Alt+G", icon: "✶", pickable: false,
        action: () => {
          const el = document.activeElement;
          if (!isTextField(el)) { showToast("Foque num campo de texto primeiro"); return; }
          openGenMenu(el);
        }},
      { id: "account", label: "Conta", shortcut: "Alt+M", icon: "☉", pickable: false,
        action: () => {
          const el = document.activeElement;
          if (!isTextField(el) && (!el || el.tagName !== "SELECT")) { showToast("Foque num campo primeiro"); return; }
          openMarkMenu(el);
        }},
      { id: "capture", label: "Capturar", shortcut: "Alt+S", icon: "▣", pickable: true,
        desc: "Clique no elemento para capturar seu valor" },
    ];

    tools.forEach((tool) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.tool = tool.id;
      btn.setAttribute("style", "flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 4px;background:#141414;border:1px solid #222;border-radius:6px;color:#999;cursor:pointer;font:inherit;font-size:11px;transition:all .15s;min-width:0");
      const iconSpan = document.createElement("span");
      iconSpan.textContent = tool.icon;
      iconSpan.setAttribute("style", "font-size:15px;line-height:1");
      btn.appendChild(iconSpan);
      const labelSpan = document.createElement("span");
      labelSpan.textContent = tool.label;
      labelSpan.setAttribute("style", "font-weight:500");
      btn.appendChild(labelSpan);
      const shortcutSpan = document.createElement("span");
      shortcutSpan.textContent = tool.shortcut;
      shortcutSpan.setAttribute("style", "font-size:9px;color:#555;margin-top:1px");
      btn.appendChild(shortcutSpan);
      btn.onmouseenter = () => { if (pickMode !== tool.id) { btn.style.background = "#1a1a1a"; btn.style.borderColor = "#3b82f6"; btn.style.color = "#ddd"; } };
      btn.onmouseleave = () => { if (pickMode !== tool.id) { btn.style.background = "#141414"; btn.style.borderColor = "#222"; btn.style.color = "#999"; } };
      btn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (tool.pickable) {
          if (pickMode === tool.id) { exitPick(); return; }
          if (pickMode) exitPick();
          enterPick(tool.id, tool.desc);
        } else {
          if (pickMode) exitPick();
          tool.action();
        }
      };
      toolsRow.appendChild(btn);
      toolBtns[tool.id] = btn;
    });
    toolsView.appendChild(toolsRow);

    // Step log header
    const logHeader = document.createElement("div");
    logHeader.textContent = "Passos gravados";
    logHeader.setAttribute("style", "padding:6px 14px 4px;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.5px");
    toolsView.appendChild(logHeader);

    // Step log container
    logEl = document.createElement("div");
    logEl.setAttribute("style", "max-height:140px;overflow-y:auto;padding:0 14px 8px;scrollbar-width:thin;scrollbar-color:#333 transparent");
    const empty = document.createElement("div");
    empty.setAttribute("style", "color:#444;font-size:11px;padding:8px 0;text-align:center");
    empty.textContent = "Os passos aparecem aqui conforme você interage";
    empty.id = "__aw_empty";
    logEl.appendChild(empty);
    toolsView.appendChild(logEl);
    panel.appendChild(toolsView);

    // --- Help view (hidden by default) ---
    helpView = document.createElement("div");
    helpView.setAttribute("style", "display:none;flex-direction:column;padding:10px 14px;gap:10px;max-height:280px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#333 transparent");
    var helpSections = [
      { title: "AÇÕES AUTOMÁTICAS", items: [
        ["Clique", "Grava o clique. No replay, clica no mesmo elemento."],
        ["Digitar", "Cria variável {{nome}} com o texto. Senhas não são salvas no arquivo."],
        ["Select", "Grava a opção escolhida no dropdown."],
        ["Checkbox", "Grava marcar ou desmarcar o campo."],
        ["Enter / Esc", "Grava a tecla pressionada no elemento."],
        ["Navegação", "Detectada automaticamente: goto (digitou URL) ou waitForUrl (causada por clique)."],
      ]},
      { title: "FERRAMENTAS", items: [
        ["✓ Verificar  Alt+Click", "Marca elemento como checkpoint. No replay, confirma que está visível."],
        ["✶ Aleatório  Alt+G", "Gera valor aleatório (nome, email, senha…) novo a cada execução."],
        ["☉ Conta  Alt+M", "Marca campo como login ou senha. No replay, salva credenciais em .accounts.jsonl."],
        ["▣ Capturar  Alt+S", "Lê texto do elemento e salva como {{read.nome}} para usar depois."],
      ]},
      { title: "NO REPLAY", items: [
        ["--set var=valor", "Sobrescreve variáveis (ex: --set password=abc123)."],
        ["--resume", "Continua do ponto onde falhou, com cookies preservados."],
        ["--headed", "Abre o navegador visível para acompanhar ou depurar."],
        ["CAPTCHA", "Resolvido automaticamente se CAPTCHA_SOLVER_API_KEY estiver configurada."],
      ]},
    ];
    helpSections.forEach(function(sec) {
      var hdr = document.createElement("div");
      hdr.textContent = sec.title;
      hdr.setAttribute("style", "font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.5px;padding-bottom:2px");
      helpView.appendChild(hdr);
      sec.items.forEach(function(item) {
        var row = document.createElement("div");
        row.setAttribute("style", "display:flex;gap:10px;padding:2px 0;line-height:1.45");
        var lbl = document.createElement("span");
        lbl.textContent = item[0];
        lbl.setAttribute("style", "color:#93c5fd;font-size:11px;min-width:140px;flex-shrink:0;font-weight:500");
        var dsc = document.createElement("span");
        dsc.textContent = item[1];
        dsc.setAttribute("style", "color:#888;font-size:11px");
        row.appendChild(lbl);
        row.appendChild(dsc);
        helpView.appendChild(row);
      });
    });
    panel.appendChild(helpView);

    toolbar.appendChild(panel);
    document.body.appendChild(toolbar);

    // Timer interval
    setInterval(updateTimer, 1000);
  }

  function togglePanel() {
    expanded = !expanded;
    panel.style.display = expanded ? "flex" : "none";
    toggleBtn.innerHTML = expanded ? "&#9660;" : "&#9650;";
  }

  function switchTab(tab) {
    activeTab = tab;
    if (toolsView) toolsView.style.display = tab === "tools" ? "flex" : "none";
    if (helpView) helpView.style.display = tab === "help" ? "flex" : "none";
    for (var k in tabEls) {
      var a = k === tab;
      tabEls[k].style.borderBottomColor = a ? "#3b82f6" : "transparent";
      tabEls[k].style.color = a ? "#ddd" : "#666";
      tabEls[k].style.fontWeight = a ? "600" : "400";
    }
  }

  function updateCount() {
    if (countEl) countEl.textContent = stepNum + (stepNum === 1 ? " passo" : " passos");
  }

  function updateTimer() {
    if (!timerEl) return;
    const s = Math.floor((Date.now() - startMs) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    timerEl.textContent = mm + ":" + ss;
  }

  function describeEvent(ev) {
    const h = ev.hint ? '"' + ev.hint.slice(0, 30) + '"' : "";
    switch (ev.kind) {
      case "click": return ev.alt ? "✓ verificar " + h : "clicar " + h;
      case "input": return "preencher " + h;
      case "select": return "selecionar " + h;
      case "check": return (ev.checked ? "marcar " : "desmarcar ") + h;
      case "key": return "tecla " + ev.key;
      case "generate": return "aleatório " + (GENERATORS[ev.gen] || ev.gen);
      case "markAccount": return "conta: " + (ev.role === "identifier" ? "login" : "senha");
      case "captureValue": return "capturar {{" + ev.saveAs + "}}";
      default: return ev.kind;
    }
  }

  function addToLog(ev) {
    if (!logEl) return;
    // Remove empty state
    const empty = document.getElementById("__aw_empty");
    if (empty) empty.remove();
    // Debounce: update existing entry for same input field
    if (ev.kind === "input") {
      const last = logItems[logItems.length - 1];
      if (last && last.kind === "input" && last.selector === ev.selector) {
        last.textEl.textContent = describeEvent(ev);
        return;
      }
    }
    stepNum++;
    const item = document.createElement("div");
    item.setAttribute("style", "display:flex;gap:8px;padding:3px 0;line-height:1.5;font-size:11px;transition:background .3s");
    const num = document.createElement("span");
    num.setAttribute("style", "color:#444;min-width:18px;text-align:right;flex-shrink:0;font-variant-numeric:tabular-nums");
    num.textContent = stepNum;
    const txt = document.createElement("span");
    txt.setAttribute("style", "color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
    txt.textContent = describeEvent(ev);
    item.appendChild(num);
    item.appendChild(txt);
    logEl.appendChild(item);
    logItems.push({ el: item, textEl: txt, kind: ev.kind, selector: ev.selector });
    logEl.scrollTop = logEl.scrollHeight;
    updateCount();
    // Brief highlight
    item.style.background = "#0d1f0d";
    setTimeout(function() { item.style.background = "transparent"; }, 500);
    // Auto-expand on first step
    if (stepNum === 1 && !expanded) togglePanel();
  }

  // === TOAST ===
  function showToast(msg) {
    const existing = document.getElementById("__aw_toast");
    if (existing) existing.remove();
    const t = document.createElement("div");
    t.id = "__aw_toast";
    t.textContent = msg;
    t.setAttribute("style", "position:fixed;bottom:50px;left:50%;transform:translateX(-50%);background:#1e293b;color:#94a3b8;font:12px -apple-system,system-ui,sans-serif;padding:8px 16px;border-radius:6px;z-index:2147483647;pointer-events:none;opacity:1;transition:opacity .3s");
    document.body.appendChild(t);
    setTimeout(function() { t.style.opacity = "0"; }, 1500);
    setTimeout(function() { t.remove(); }, 1800);
  }

  // === PICK MODE ===
  function enterPick(mode, desc) {
    pickMode = mode;
    if (pickBanner) {
      pickBanner.style.display = "flex";
      pickBanner.querySelector("span").textContent = desc || "";
    }
    var btn = toolBtns[mode];
    if (btn) { btn.style.background = "#172554"; btn.style.borderColor = "#3b82f6"; btn.style.color = "#93c5fd"; }
    document.body.style.cursor = "crosshair";
  }

  function exitPick() {
    var prev = pickMode;
    pickMode = null;
    if (pickBanner) pickBanner.style.display = "none";
    if (prev && toolBtns[prev]) {
      var btn = toolBtns[prev];
      btn.style.background = "#141414"; btn.style.borderColor = "#222"; btn.style.color = "#999";
    }
    hideHighlight();
    document.body.style.cursor = "";
  }

  function showHighlight(el) {
    if (!hlOverlay) return;
    var r = el.getBoundingClientRect();
    hlOverlay.style.display = "block";
    hlOverlay.style.left = (r.left - 2) + "px";
    hlOverlay.style.top = (r.top - 2) + "px";
    hlOverlay.style.width = r.width + "px";
    hlOverlay.style.height = r.height + "px";
  }

  function hideHighlight() {
    if (hlOverlay) hlOverlay.style.display = "none";
  }

  // Pick mode hover
  document.addEventListener("mousemove", function(e) {
    if (!pickMode) return;
    var el = e.target;
    if (!(el instanceof Element) || ours(el)) { hideHighlight(); return; }
    showHighlight(el);
  }, true);

  // === EVENT LISTENERS ===

  // Pick mode: Escape cancels
  document.addEventListener("keydown", function(e) {
    if (pickMode && e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      exitPick();
    }
  }, true);

  // Clicks
  document.addEventListener("click", function(e) {
    if (!e.isTrusted) return;
    var raw = e.target;
    if (!(raw instanceof Element) || ours(raw)) return;

    // Pick mode: checkpoint
    if (pickMode === "checkpoint") {
      e.preventDefault(); e.stopPropagation();
      send(Object.assign({ kind: "click", alt: true }, target(raw)));
      flash(raw);
      exitPick();
      return;
    }
    // Pick mode: capture
    if (pickMode === "capture") {
      e.preventDefault(); e.stopPropagation();
      exitPick();
      openSaveMenu(raw);
      return;
    }

    var el = raw.closest(INTERACTIVE) || raw;

    // Alt+click = checkpoint
    if (e.altKey) {
      e.preventDefault(); e.stopPropagation();
      send(Object.assign({ kind: "click", alt: true }, target(raw)));
      flash(raw);
      return;
    }
    if (isTextField(el) || el.tagName === "SELECT" || isToggle(el)) return;
    if (el.tagName === "LABEL" && (isToggle(el.control) || isTextField(el.control))) return;
    send(Object.assign({ kind: "click", alt: false }, target(el)));
  }, true);

  // Input
  document.addEventListener("input", function(e) {
    var el = e.target;
    if (!e.isTrusted || !isTextField(el) || ours(el)) return;
    send(Object.assign({ kind: "input", value: el.value, inputType: (el.type || "text").toLowerCase(), field: fieldName(el) }, target(el)));
  }, true);

  // Change (select / checkbox)
  document.addEventListener("change", function(e) {
    var el = e.target;
    if (!(el instanceof Element) || ours(el)) return;
    if (el.tagName === "SELECT") {
      send(Object.assign({ kind: "select", value: el.value, field: fieldName(el) }, target(el)));
    } else if (isToggle(el) && e.isTrusted) {
      send(Object.assign({ kind: "check", checked: el.checked }, target(el)));
    }
  }, true);

  // Alt+M: mark account field
  document.addEventListener("keydown", function(e) {
    if (!e.isTrusted || !e.altKey || e.code !== "KeyM") return;
    var el = document.activeElement;
    if (!isTextField(el) && (!el || el.tagName !== "SELECT")) return;
    e.preventDefault(); e.stopPropagation();
    openMarkMenu(el);
  }, true);

  // Alt+S: capture value
  document.addEventListener("keydown", function(e) {
    if (!e.isTrusted || !e.altKey || e.code !== "KeyS") return;
    e.preventDefault(); e.stopPropagation();
    var el = document.activeElement && document.activeElement !== document.body
      ? document.activeElement : lastHover;
    if (!el || !(el instanceof Element) || ours(el)) return;
    openSaveMenu(el);
  }, true);

  document.addEventListener("mouseover", function(e) {
    if (!pickMode) lastHover = e.target;
  }, true);

  // Alt+G: random value
  document.addEventListener("keydown", function(e) {
    if (!e.isTrusted || !e.altKey || e.code !== "KeyG") return;
    var el = document.activeElement;
    if (!isTextField(el)) return;
    e.preventDefault(); e.stopPropagation();
    openGenMenu(el);
  }, true);

  // Enter/Escape keys
  document.addEventListener("keydown", function(e) {
    if (!e.isTrusted || (e.key !== "Enter" && e.key !== "Escape")) return;
    if (document.getElementById(MENU_ID)) return;
    var el = e.target;
    if (!(el instanceof Element) || ours(el)) return;
    if (e.key === "Enter" && el.tagName === "TEXTAREA") return;
    send(Object.assign({ kind: "key", key: e.key }, target(el)));
  }, true);

  // === VISUAL FEEDBACK ===
  function flash(el) {
    var prev = el.style.outline;
    el.style.outline = "3px solid #22c55e";
    setTimeout(function() { el.style.outline = prev; }, 600);
  }

  // === MENUS ===
  function closeMenu() {
    var m = document.getElementById(MENU_ID);
    if (m) m.remove();
  }

  // Generator menu (Alt+G)
  function openGenMenu(field) {
    closeMenu();
    var r = field.getBoundingClientRect();
    var m = document.createElement("div");
    m.id = MENU_ID;
    m.setAttribute("style", "position:fixed;z-index:2147483647;left:" + Math.max(4, r.left) + "px;top:" + Math.min(window.innerHeight - 260, r.bottom + 4) + "px;background:#141414;color:#d4d4d4;font:12px -apple-system,system-ui,sans-serif;border-radius:8px;padding:4px;box-shadow:0 8px 32px #000a;border:1px solid #222;min-width:190px");
    var title = document.createElement("div");
    title.textContent = "Valor aleatório por execução:";
    title.setAttribute("style", "padding:6px 10px 4px;color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.3px");
    m.appendChild(title);
    var kinds = Object.keys(GENERATORS);
    kinds.forEach(function(kind, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.dataset.gen = kind;
      b.textContent = (i + 1) + ". " + GENERATORS[kind];
      b.setAttribute("style", "display:block;width:100%;text-align:left;background:none;border:0;color:inherit;padding:7px 10px;border-radius:5px;cursor:pointer;font:inherit;transition:background .1s");
      b.onmouseenter = function() { b.style.background = "#1e293b"; };
      b.onmouseleave = function() { b.style.background = "none"; };
      b.onclick = function(ev) { ev.preventDefault(); ev.stopPropagation(); choose(kind); };
      m.appendChild(b);
    });
    var keys = function(ev) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(); field.focus(); return; }
      var n = Number(ev.key);
      if (n >= 1 && n <= kinds.length) { ev.preventDefault(); ev.stopPropagation(); choose(kinds[n - 1]); }
    };
    var outside = function(ev) { if (!ours(ev.target)) done(); };
    function done() {
      document.removeEventListener("keydown", keys, true);
      document.removeEventListener("mousedown", outside, true);
      closeMenu();
    }
    function choose(kind) {
      done();
      send(Object.assign({ kind: "generate", gen: kind, inputType: (field.type || "text").toLowerCase() }, target(field)));
      field.focus();
    }
    document.addEventListener("keydown", keys, true);
    document.addEventListener("mousedown", outside, true);
    document.body.appendChild(m);
  }

  // Account mark menu (Alt+M)
  function openMarkMenu(field) {
    closeMenu();
    var r = field.getBoundingClientRect();
    var m = document.createElement("div");
    m.id = MENU_ID;
    m.setAttribute("style", "position:fixed;z-index:2147483647;left:" + Math.max(4, r.left) + "px;top:" + Math.min(window.innerHeight - 120, r.bottom + 4) + "px;background:#141414;color:#d4d4d4;font:12px -apple-system,system-ui,sans-serif;border-radius:8px;padding:4px;box-shadow:0 8px 32px #000a;border:1px solid #222;min-width:200px");
    var title = document.createElement("div");
    title.textContent = "Este campo é:";
    title.setAttribute("style", "padding:6px 10px 4px;color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.3px");
    m.appendChild(title);
    var roles = [["identifier", "1. Login / E-mail da conta"], ["password", "2. Senha da conta"]];
    var keys = function(ev) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(); field.focus(); return; }
      if (ev.key === "1") { ev.preventDefault(); ev.stopPropagation(); choose("identifier"); }
      if (ev.key === "2") { ev.preventDefault(); ev.stopPropagation(); choose("password"); }
    };
    var outside = function(ev) { if (!ours(ev.target)) done(); };
    function done() {
      document.removeEventListener("keydown", keys, true);
      document.removeEventListener("mousedown", outside, true);
      closeMenu();
    }
    function choose(role) {
      done();
      send(Object.assign({ kind: "markAccount", role: role }, target(field)));
      flash(field);
      field.focus();
    }
    roles.forEach(function(pair) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = pair[1];
      b.setAttribute("style", "display:block;width:100%;text-align:left;background:none;border:0;color:inherit;padding:7px 10px;border-radius:5px;cursor:pointer;font:inherit;transition:background .1s");
      b.onmouseenter = function() { b.style.background = "#1e293b"; };
      b.onmouseleave = function() { b.style.background = "none"; };
      b.onclick = function(ev) { ev.preventDefault(); ev.stopPropagation(); choose(pair[0]); };
      m.appendChild(b);
    });
    document.addEventListener("keydown", keys, true);
    document.addEventListener("mousedown", outside, true);
    document.body.appendChild(m);
  }

  // Capture value menu (Alt+S)
  function openSaveMenu(el) {
    closeMenu();
    var val = (el.value !== undefined && el.value !== "") ? el.value
      : (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!val) { showToast("Elemento sem valor para capturar"); return; }
    var preview = val.length > 40 ? val.slice(0, 37) + "..." : val;

    var r = el.getBoundingClientRect();
    var m = document.createElement("div");
    m.id = MENU_ID;
    m.setAttribute("style", "position:fixed;z-index:2147483647;left:" + Math.max(4, r.left) + "px;top:" + Math.min(window.innerHeight - 160, r.bottom + 4) + "px;background:#141414;color:#d4d4d4;font:12px -apple-system,system-ui,sans-serif;border-radius:8px;padding:10px;box-shadow:0 8px 32px #000a;border:1px solid #222;min-width:250px;max-width:350px");
    var title = document.createElement("div");
    title.textContent = "Capturar: " + JSON.stringify(preview);
    title.setAttribute("style", "padding:0 0 6px;color:#666;font-size:11px;word-break:break-all");
    m.appendChild(title);
    var label = document.createElement("div");
    label.textContent = "Nome da variável (ex.: telefone, codigo):";
    label.setAttribute("style", "padding:0 0 4px;font-size:12px");
    m.appendChild(label);
    var inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = "nome";
    inp.setAttribute("style", "width:100%;box-sizing:border-box;padding:6px 10px;border:1px solid #333;border-radius:5px;background:#1a1a1a;color:#d4d4d4;font:12px -apple-system,system-ui,sans-serif;outline:none;transition:border-color .15s");
    inp.onfocus = function() { inp.style.borderColor = "#3b82f6"; };
    inp.onblur = function() { inp.style.borderColor = "#333"; };
    m.appendChild(inp);
    var hint = document.createElement("div");
    hint.textContent = "Enter confirmar · Esc cancelar";
    hint.setAttribute("style", "padding:5px 0 0;color:#555;font-size:10px");
    m.appendChild(hint);

    var keys = function(ev) {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(); return; }
      if (ev.key === "Enter") {
        ev.preventDefault(); ev.stopPropagation();
        var name = inp.value.trim().replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
        if (!name) { inp.style.borderColor = "#ef4444"; return; }
        done();
        flash(el);
        send(Object.assign({ kind: "captureValue", saveAs: name, value: val }, target(el)));
      }
    };
    var outside = function(ev) { if (!ours(ev.target)) done(); };
    function done() {
      document.removeEventListener("keydown", keys, true);
      document.removeEventListener("mousedown", outside, true);
      closeMenu();
    }
    document.addEventListener("keydown", keys, true);
    document.addEventListener("mousedown", outside, true);
    document.body.appendChild(m);
    setTimeout(function() { inp.focus(); }, 50);
  }

  // === INIT ===
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", createToolbar);
  else createToolbar();
})();
`;
