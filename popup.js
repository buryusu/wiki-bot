const $ = s => document.querySelector(s);
const DEFAULTS = {enabled:true,pollMs:120,actionDelay:250,viewDelay:180,retryDelay:500,navigationDelay:150,emailPollMs:500,emailFillDelay:150,signupFillDelay:150,signupSubmitDelay:150,signupButtonPollMs:75,signupButtonTimeoutMs:15000,otpSubmitDelay:150,autoStartupGate:true,autoSignup:true,autoSwitch:false,autoCloseAndRestart:false,signupResultTimeoutMs:20000,signupResultPollMs:250,usernameMinLength:3,usernameMaxLength:24};
let currentSettings = Object.assign({}, DEFAULTS);
async function activeTab() {
  const t = await chrome.tabs.query({active:true,currentWindow:true});
  return t[0];
}
function allowed(url) {
  try {
    const u = new URL(url);
    return (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") && (u.pathname === "/pull" || u.pathname.startsWith("/pulls"));
  } catch (e) { return false; }
}
function updateInputs() {
  const keys = ["pollMs","actionDelay","viewDelay","retryDelay","navigationDelay","emailPollMs","emailFillDelay","signupFillDelay","signupSubmitDelay","signupButtonPollMs","signupButtonTimeoutMs","otpSubmitDelay","signupResultTimeoutMs","signupResultPollMs"];
  for (const k of keys) {
    const el = $("#" + k), out = $("#" + k + "Out");
    if (!el || !out) continue;
    el.value = currentSettings[k]; out.textContent = currentSettings[k];
  }
  for (const k of ["autoStartupGate","autoSignup","autoSwitch","autoCloseAndRestart"]) {
    const el = $("#" + k); if (el) el.checked = !!currentSettings[k];
  }
}
async function send(action, extra) {
  extra = extra || {};
  const t = await activeTab();
  if (!t || !t.id) throw new Error("No tab");
  return chrome.tabs.sendMessage(t.id, Object.assign({type:"wmph", action}, extra));
}
async function refresh() {
  const tab = await activeTab();
  const ok = allowed(tab && tab.url);
  let isStartup = false;
  try { isStartup = new URL((tab && tab.url) || "").pathname === "/pull"; } catch (e) {}
  $("#site").textContent = isStartup ? "Page /pull détectée — validation du captcha requise" : (ok ? "Page /pulls détectée" : "WikiMasters : mode repos (va dans /pull ou /pulls)");
  try {
    const state = await send("getState");
    currentSettings = Object.assign({}, DEFAULTS, state.settings || {});
    $("#status").textContent = state.halted ? "Légendaire trouvée — arrêt" : state.status;
    $("#packs").textContent = "Packs parcourus : " + state.packs;
    $("#toggle").disabled = !state.inPulls;
    $("#toggle").textContent = !state.inPulls ? "Mode repos" : (state.enabled ? "Arrêter l'automatisation" : "Démarrer l'automatisation");
  } catch (e) {
    $("#status").textContent = ok ? "Recharge la page" : "Mode repos";
    $("#packs").textContent = "Packs parcourus : —";
    $("#toggle").disabled = true; $("#toggle").textContent = "Page non chargée";
  }
  updateInputs();
  refreshAccounts().catch(() => {});
}
$("#toggle").addEventListener("click", async () => {
  try { await send("toggle"); } catch (e) {}
  await refresh();
});
const sliderKeys = ["pollMs","actionDelay","viewDelay","retryDelay","navigationDelay","emailPollMs","emailFillDelay","signupFillDelay","signupSubmitDelay","signupButtonPollMs","signupButtonTimeoutMs","otpSubmitDelay","signupResultTimeoutMs","signupResultPollMs"];
for (const k of sliderKeys) {
  const el = $("#" + k);
  if (!el) continue;
  el.addEventListener("input", async e => {
    currentSettings[k] = Number(e.target.value);
    $("#" + k + "Out").textContent = currentSettings[k];
    try { await send("updateSettings", {settings:{[k]: currentSettings[k]}}); } catch (err) {}
  });
}
for (const k of ["autoStartupGate","autoSignup","autoSwitch","autoCloseAndRestart"]) {
  const el = $("#" + k);
  if (!el) continue;
  el.addEventListener("change", async e => {
    currentSettings[k] = !!e.target.checked;
    try { await send("updateSettings", {settings:{[k]: currentSettings[k]}}); } catch (err) {}
  });
}
$("#reset").addEventListener("click", async () => {
  try {
    const r = await send("resetSettings");
    currentSettings = Object.assign({}, DEFAULTS, r.settings || {});
  } catch (e) { currentSettings = Object.assign({}, DEFAULTS); }
  updateInputs();
  await refresh();
});
async function refreshAccounts() {
  const summary = $("#accountsSummary"), list = $("#accountsList");
  if (!summary || !list) return;
  try {
    const r = await send("getAccounts");
    const accounts = (r && r.accounts) || {};
    const emails = Object.keys(accounts);
    if (!emails.length) { summary.textContent = "Aucun compte enregistré."; list.innerHTML = ""; return; }
    const tp = emails.reduce((s, e) => s + (accounts[e].totalPacks || 0), 0);
    summary.textContent = emails.length + " compte(s) — " + tp + " pack(s)";
    list.innerHTML = emails.map(email => {
      const a = accounts[email];
      const cls = a.signupStatus === "success" ? "status-ok" : a.signupStatus === "failed" ? "status-fail" : "status-pending";
      const last = a.lastUpdated ? a.lastUpdated.slice(0, 19).replace("T", " ") : "—";
      return '<div class="account-row"><div class="email">' + email + '</div><div class="meta"><span class="' + cls + '">' + (a.signupStatus || "pending") + '</span> · ' + (a.totalPacks || 0) + ' pack(s) · ' + last + '</div></div>';
    }).join("");
  } catch (e) { summary.textContent = "Erreur de chargement des comptes."; list.innerHTML = ""; }
}
$("#closeIncognito").addEventListener("click", async () => {
  const status = $("#closeIncognitoStatus"), button = $("#closeIncognito");
  button.disabled = true; status.textContent = "Fermeture des fenêtres privées…";
  try {
    const r = await chrome.runtime.sendMessage({type:"wmph", action:"closeAllIncognitoWindows"});
    if (r && r.ok) status.textContent = r.closed ? (r.closed + " fenêtre(s) privée(s) fermée(s).") : "Aucune fenêtre privée à fermer.";
    else status.textContent = "Impossible de fermer les fenêtres privées.";
  } catch (e) { status.textContent = "Erreur lors de la fermeture."; }
  finally { button.disabled = false; }
});
$("#exportJSON").addEventListener("click", async () => {
  const status = $("#accountsStatus");
  try {
    const r = await send("exportJSON");
    if (!r || !r.json) throw new Error("no data");
    const url = URL.createObjectURL(new Blob([r.json], {type:"application/json"}));
    chrome.downloads.download({url, filename: "wmph-accounts-" + new Date().toISOString().slice(0, 10) + ".json", saveAs: true});
    status.textContent = "Export JSON lancé.";
  } catch (e) { status.textContent = "Erreur export JSON."; }
});
$("#exportCSV").addEventListener("click", async () => {
  const status = $("#accountsStatus");
  try {
    const r = await send("exportCSV");
    if (!r || !r.csv) throw new Error("no data");
    const url = URL.createObjectURL(new Blob([r.csv], {type:"text/csv"}));
    chrome.downloads.download({url, filename: "wmph-accounts-" + new Date().toISOString().slice(0, 10) + ".csv", saveAs: true});
    status.textContent = "Export CSV lancé.";
  } catch (e) { status.textContent = "Erreur export CSV."; }
});
$("#viewCollection").addEventListener("click", () => {
  chrome.tabs.create({ url: "viewer.html" });
  window.close();
});
$("#clearAccounts").addEventListener("click", async () => {
  const status = $("#accountsStatus");
  if (!confirm("Effacer tous les comptes et packs enregistrés ?")) return;
  try { await send("clearAccounts"); status.textContent = "Comptes effacés."; await refreshAccounts(); }
  catch (e) { status.textContent = "Erreur lors de l'effacement."; }
});

// ── Preset accounts ──────────────────────────────────────────────────────────

let presetAccounts = [];
let presetIndex    = 0;

function setPresetStatus(msg, color) {
  const el = $("#presetStatus");
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || "#94a3b8";
}

function renderPresetList() {
  const summary = $("#presetSummary");
  const active  = $("#presetActive");
  const list    = $("#presetList");
  const prevBtn = $("#presetPrev");
  const nextBtn = $("#presetNext");
  if (!summary || !list) return;

  if (!presetAccounts.length) {
    summary.textContent = "Aucun compte chargé.";
    if (active) active.classList.add("hidden");
    list.innerHTML = "";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  summary.textContent = `${presetAccounts.length} compte(s) — actif : ${presetIndex + 1}/${presetAccounts.length}`;

  const cur = presetAccounts[presetIndex];
  if (active && cur) {
    active.classList.remove("hidden");
    active.innerHTML =
      `<div class="pa-label">Compte actif <span class="pa-idx">${presetIndex + 1} / ${presetAccounts.length}</span></div>` +
      `<div class="pa-email">${cur.email}</div>`;
  }

  list.innerHTML = presetAccounts.map((a, i) => {
    const cls = i === presetIndex ? "preset-row active-preset" : "preset-row";
    return `<div class="${cls}" data-idx="${i}">` +
      `<span class="pr-idx">${i + 1}</span>` +
      `<span class="pr-email">${a.email}</span>` +
      `<span class="pr-del" data-del="${i}" title="Supprimer">✕</span>` +
    `</div>`;
  }).join("");

  list.querySelectorAll(".preset-row").forEach(row => {
    row.addEventListener("click", async e => {
      if (e.target.dataset.del !== undefined) return;
      const idx = Number(row.dataset.idx);
      if (isNaN(idx)) return;
      await switchToPresetIndex(idx);
    });
  });

  list.querySelectorAll(".pr-del").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const idx = Number(btn.dataset.del);
      if (isNaN(idx)) return;
      presetAccounts.splice(idx, 1);
      if (presetIndex >= presetAccounts.length) presetIndex = Math.max(0, presetAccounts.length - 1);
      await savePresets();
      renderPresetList();
    });
  });

  if (prevBtn) prevBtn.disabled = presetAccounts.length < 2;
  if (nextBtn) nextBtn.disabled = presetAccounts.length < 2;
}

async function savePresets() {
  await chrome.storage.local.set({
    wmph_preset_accounts: presetAccounts,
    wmph_preset_index: presetIndex
  });
}

async function loadPresets() {
  const d = await chrome.storage.local.get(["wmph_preset_accounts","wmph_preset_index"]);
  presetAccounts = Array.isArray(d.wmph_preset_accounts) ? d.wmph_preset_accounts : [];
  presetIndex    = typeof d.wmph_preset_index === "number" ? d.wmph_preset_index : 0;
  if (presetIndex >= presetAccounts.length) presetIndex = 0;
  renderPresetList();
}

function parseImportedFile(text, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const isJson = ext === "json" || text.trimStart().startsWith("[") || text.trimStart().startsWith("{");
  if (isJson) {
    try {
      const parsed = JSON.parse(text);
      let rows;
      if (Array.isArray(parsed)) rows = parsed;
      else if (parsed && Array.isArray(parsed.accounts)) rows = parsed.accounts;
      else if (parsed && parsed.accounts && typeof parsed.accounts === "object") rows = Object.entries(parsed.accounts).map(([email, account]) => Object.assign({email}, account));
      else if (parsed && typeof parsed.email === "string") rows = [parsed];
      else if (parsed && typeof parsed === "object") rows = Object.entries(parsed).map(([email, account]) => Object.assign({email}, account));
      else rows = [];
      const accounts = rows
        .filter(o => o && typeof o.email === "string" && typeof o.password === "string")
        .map(o => ({email: o.email.trim(), password: o.password}))
        .filter(o => o.email && o.password);
      if (!accounts.length) throw new Error("Aucun compte avec email et password trouvé");
      return accounts;
    } catch (e) { throw new Error("JSON invalide : " + e.message); }
  }
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error("Fichier vide");
  let start = 0;
  if (/^email[,;\t]/i.test(lines[0])) start = 1;
  const sep = /[,;\t]/.exec(lines[start] || lines[0]);
  const delim = sep ? sep[0] : ",";
  const result = [];
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(delim).map(p => p.trim().replace(/^"|"$/g, ""));
    if (parts.length >= 2 && parts[0] && parts[1]) {
      result.push({ email: parts[0], password: parts[1] });
    }
  }
  if (!result.length) throw new Error("Aucun compte valide trouvé dans le fichier");
  return result;
}

async function switchToPresetIndex(idx) {
  if (!presetAccounts.length) { setPresetStatus("Aucun compte chargé.", "#f87171"); return; }
  presetIndex = ((idx % presetAccounts.length) + presetAccounts.length) % presetAccounts.length;
  await savePresets();
  renderPresetList();
  const creds = presetAccounts[presetIndex];
  setPresetStatus(`Connexion en cours avec ${creds.email}…`, "#fbbf24");
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: "wmph",
      action: "switchPresetAccount",
      email: creds.email,
      password: creds.password,
      tabId: tab && tab.id
    });
    if (!result || !result.ok) throw new Error((result && result.error) || "Changement non démarré");
    setPresetStatus(`Connexion lancée : ${creds.email}`, "#4ade80");
  } catch (e) {
    setPresetStatus("Erreur : " + e.message, "#f87171");
  }
}

$("#presetImportBtn").addEventListener("click", () => { $("#presetImport").click(); });

$("#presetImport").addEventListener("change", async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  e.target.value = "";
  try {
    const text = await file.text();
    const parsed = parseImportedFile(text, file.name);
    const existing = new Set(presetAccounts.map(a => a.email));
    let added = 0;
    for (const a of parsed) {
      if (!existing.has(a.email)) { presetAccounts.push(a); added++; }
    }
    if (!added) {
      presetAccounts = parsed;
      setPresetStatus(`${parsed.length} compte(s) rechargé(s) (liste remplacée).`, "#fbbf24");
    } else {
      setPresetStatus(`${added} nouveau(x) compte(s) ajouté(s) — total : ${presetAccounts.length}.`, "#4ade80");
    }
    if (presetIndex >= presetAccounts.length) presetIndex = 0;
    await savePresets();
    renderPresetList();
  } catch (err) {
    setPresetStatus("Erreur : " + err.message, "#f87171");
  }
});

$("#presetPrev").addEventListener("click", () => switchToPresetIndex(presetIndex - 1));
$("#presetNext").addEventListener("click", () => switchToPresetIndex(presetIndex + 1));

$("#presetClear").addEventListener("click", async () => {
  if (!presetAccounts.length) return;
  if (!confirm(`Vider les ${presetAccounts.length} compte(s) prédéfinis ?`)) return;
  presetAccounts = [];
  presetIndex    = 0;
  await savePresets();
  renderPresetList();
  setPresetStatus("Liste vidée.", "#94a3b8");
});

loadPresets();
refresh();
