importScripts("storage.js");
"use strict";
const WIKI_SIGNUP = "https://www.wiki-masters.com/signup";
const MAIL_URL = "https://10minutemail.com/";
const handledWindows = new Set();
const configuringWindows = new Set();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitForIncognitoTabs(windowId, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const win = await chrome.windows.get(windowId);
      if (!win.incognito) return [];
      const tabs = await chrome.tabs.query({windowId});
      if (tabs.length > 0) return tabs.sort((a,b) => (a.index||0)-(b.index||0));
    } catch (e) { return []; }
    await sleep(100);
  }
  return [];
}
async function closeAllIncognitoWindows() {
  const windows = await chrome.windows.getAll();
  const inc = windows.filter(w => w && w.incognito && w.id != null && w.id !== chrome.windows.WINDOW_ID_NONE);
  let closed = 0;
  for (const w of inc) { try { await chrome.windows.remove(w.id); closed++; } catch (e) {} }
  return closed;
}
async function openPrivateTabs(windowId) {
  if (configuringWindows.has(windowId) || handledWindows.has(windowId)) return;
  configuringWindows.add(windowId);
  try {
    const win = await chrome.windows.get(windowId);
    if (!win.incognito) return;
    const tabs = await waitForIncognitoTabs(windowId);
    if (!tabs.length) return;
    await chrome.tabs.update(tabs[0].id, {url: MAIL_URL, active: false});
    await sleep(200);
    const current = await chrome.tabs.query({windowId});
    const wikiTabs = current.filter(t => {
      try {
        const u = new URL(t.url || "");
        return u.protocol === "https:" &&
          (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") &&
          u.pathname === "/signup";
      } catch (e) { return false; }
    });
    let wiki = wikiTabs[0] || null;
    for (const d of wikiTabs.slice(1)) { try { await chrome.tabs.remove(d.id); } catch (e) {} }
    if (!wiki) wiki = await chrome.tabs.create({windowId, url: WIKI_SIGNUP, active: true});
    else await chrome.tabs.update(wiki.id, {active: true});
    if (wiki && wiki.id) { try { await chrome.windows.update(windowId, {focused: true}); } catch (e) {} }
    handledWindows.add(windowId);
  } catch (e) { console.warn("[WMPH] openPrivateTabs:", e); }
  finally { configuringWindows.delete(windowId); }
}
async function rotateMailboxForWindow(windowId) {
  try {
    const tabs = await chrome.tabs.query({windowId});
    const mailTab = tabs.find(t => {
      try { return new URL(t.url || "").hostname === "10minutemail.com"; } catch (e) { return false; }
    });
    if (!mailTab || !mailTab.id) return null;
    const r = await chrome.tabs.sendMessage(mailTab.id, {type: "wmph_email_rotate"});
    return (r && r.address) || null;
  } catch (e) { return null; }
}
async function refillSignupForWindow(windowId, email) {
  try {
    const tabs = await chrome.tabs.query({windowId});
    const targets = tabs.filter(t => {
      try {
        const u = new URL(t.url || "");
        return u.protocol === "https:" &&
          (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") &&
          u.pathname.startsWith("/signup");
      } catch (e) { return false; }
    });
    let sent = 0;
    for (const t of targets) {
      try { await chrome.tabs.sendMessage(t.id, {type:"wmph", action:"retrySignup", email:String(email)}); sent++; } catch (e) {}
    }
    return sent;
  } catch (e) { return 0; }
}
// ── Preset account switching ─────────────────────────────────────────────────
const WIKI_LOGIN  = "https://www.wiki-masters.com/login";
const WIKI_PULLS  = "https://www.wiki-masters.com/pulls";

function isWikiTab(tab) {
  try {
    const u = new URL((tab && tab.url) || "");
    return u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com";
  } catch (e) { return false; }
}

async function findOrCreateWikiTab(preferredTabId) {
  if (preferredTabId != null) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (isWikiTab(preferred)) return preferred;
    } catch (e) {}
  }
  const all = await chrome.tabs.query({});
  const existing = all.find(isWikiTab);
  if (existing) return existing;
  return await chrome.tabs.create({ url: WIKI_PULLS, active: true });
}

async function waitForTabUrl(tabId, predicate, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  return new Promise(resolve => {
    let settled = false;
    const finish = tab => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(check);
      resolve(tab || null);
    };
    function check(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === "complete" && predicate(tab.url || "")) {
        finish(tab);
      }
    }
    const timeout = setTimeout(() => finish(null), timeoutMs);
    chrome.tabs.onUpdated.addListener(check);
    // Also resolve immediately if already on the right page
    chrome.tabs.get(tabId).then(t => {
      if (predicate(t.url || "")) finish(t);
    }).catch(() => {});
  });
}

async function clearWikiAuthState(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {type: "wmph", action: "clearSiteSession"});
  } catch (e) {
    // A newly created tab may not have received the content script yet. It has
    // no previous WikiMasters session to clear, so navigating to login is safe.
    return {ok: false, error: String(e)};
  }
}

async function clearWikiBrowserData() {
  // The site can keep a Supabase session in cookies, IndexedDB, a service
  // worker, or local storage. Clear only its two permitted origins.
  await chrome.browsingData.remove(
    {origins: ["https://www.wiki-masters.com", "https://wiki-masters.com"]},
    {
      cookies: true,
      localStorage: true,
      indexedDB: true,
      cacheStorage: true,
      serviceWorkers: true
    }
  );
}

async function doSwitchAccount(email, password, preferredTabId) {
  try {
    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
      return {ok: false, error: "Identifiants incomplets"};
    }
    // 1. Store pending login creds
    await wmphSetLoginPending({ email, password });

    // 2. Prefer the tab from which the popup was opened, then any Wiki tab.
    const tab = await findOrCreateWikiTab(preferredTabId);
    const tabId = tab.id;

    // 3. Clear both the page-level token and all browser storage for the site.
    // This is scoped to WikiMasters; no data for other sites is touched.
    await clearWikiAuthState(tabId);
    await clearWikiBrowserData();

    // 4. Load the login page. The content script fills and submits it.
    await chrome.tabs.update(tabId, { url: WIKI_LOGIN });

    // 5. Wait only long enough to report navigation failures; the content script
    // handles the form as soon as Chrome injects it.
    const loginTab = await waitForTabUrl(tabId, url => {
      try { const u = new URL(url); return u.pathname.startsWith("/login"); } catch (e) { return false; }
    }, 10000);
    return loginTab ? {ok: true} : {ok: false, error: "La page de connexion n’a pas chargé"};
  } catch (e) {
    console.warn("[WMPH] switchAccount error:", e);
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg || msg.type !== "wmph" || msg.action !== "switchPresetAccount") return;
  doSwitchAccount(msg.email, msg.password, msg.tabId)
    .then(r => send(r))
    .catch(e => send({ ok: false, error: String(e) }));
  return true;
});

// ── Auto-switch trigger (fired from content script when no packs) ─────────────
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg || msg.type !== "wmph_auto_switch") return;
  (async () => {
    try {
      const d = await chrome.storage.local.get([
        "wmph_preset_accounts", "wmph_preset_index", "wmph_settings"
      ]);
      const settings = d.wmph_settings || {};
      if (!settings.autoSwitch) { send({ ok: false, reason: "disabled" }); return; }
      const accounts = d.wmph_preset_accounts || [];
      if (!accounts.length) { send({ ok: false, reason: "no_presets" }); return; }
      const cur = typeof d.wmph_preset_index === "number" ? d.wmph_preset_index : 0;
      const next = (cur + 1) % accounts.length;
      await chrome.storage.local.set({ wmph_preset_index: next });
      const creds = accounts[next];
      const r = await doSwitchAccount(creds.email, creds.password);
      send({ ok: r.ok, next, email: creds.email });
    } catch (e) { send({ ok: false, error: String(e) }); }
  })();
  return true;
});

// ── Auto-close and restart (infinite loop) ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg || msg.type !== "wmph_auto_close_restart") return;
  (async () => {
    try {
      const d = await chrome.storage.local.get(["wmph_settings"]);
      const settings = d.wmph_settings || {};
      if (!settings.autoCloseAndRestart) { send({ ok: false, reason: "disabled" }); return; }
      
      // Close all incognito windows
      await closeAllIncognitoWindows();
      
      // Wait a bit to ensure cleanup is done
      await sleep(1000);
      
      // Create a new incognito window, which will trigger onCreated and start the process
      await chrome.windows.create({incognito: true});
      
      send({ ok: true });
    } catch (e) { send({ ok: false, error: String(e) }); }
  })();
  return true;
});

chrome.windows.onCreated.addListener(w => {
  if (w && w.incognito) { handledWindows.delete(w.id); setTimeout(() => openPrivateTabs(w.id), 250); }
});
chrome.windows.onRemoved.addListener(id => { handledWindows.delete(id); configuringWindows.delete(id); });
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (!msg || msg.type !== "wmph" || msg.action !== "closeAllIncognitoWindows") return;
  closeAllIncognitoWindows().then(n => send({ok:true, closed:n})).catch(e => send({ok:false, error:String(e)}));
  return true;
});
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.type !== "wmph_email_code" || !msg.code) return;
  (async () => {
    try {
      const wid = (sender && sender.tab && sender.tab.windowId) || msg.sourceWindowId;
      if (wid == null) { send({ok:false, error:"no window"}); return; }
      const tabs = await chrome.tabs.query({windowId: wid});
      const targets = tabs.filter(t => {
        try {
          const u = new URL(t.url || "");
          return u.protocol === "https:" && (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com");
        } catch (e) { return false; }
      });
      let sent = 0;
      for (const t of targets) {
        try { await chrome.tabs.sendMessage(t.id, {type:"wmph", action:"fillOtp", code:String(msg.code)}); sent++; } catch (e) {}
      }
      send({ok:true, sent});
    } catch (e) { send({ok:false, error:String(e)}); }
  })();
  return true;
});
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.type !== "wmph_email_address" || !msg.email) return;
  (async () => {
    try {
      const wid = (sender && sender.tab && sender.tab.windowId) || msg.sourceWindowId;
      if (wid == null) { send({ok:false, error:"no window"}); return; }
      const tabs = await chrome.tabs.query({windowId: wid});
      const targets = tabs.filter(t => {
        try {
          const u = new URL(t.url || "");
          return u.protocol === "https:" &&
            (u.hostname === "www.wiki-masters.com" || u.hostname === "wiki-masters.com") &&
            u.pathname.startsWith("/signup");
        } catch (e) { return false; }
      });
      let sent = 0;
      for (const t of targets) {
        try { await chrome.tabs.sendMessage(t.id, {type:"wmph", action:"fillSignup", email:String(msg.email), delay:msg.delay}); sent++; } catch (e) {}
      }
      send({ok:true, sent});
    } catch (e) { send({ok:false, error:String(e)}); }
  })();
  return true;
});
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.type !== "wmph_signup_result") return;
  (async () => {
    try {
      if (msg.ok) { send({ok:true, noop:true}); return; }
      const wid = sender && sender.tab && sender.tab.windowId;
      if (wid == null) { send({ok:false, error:"no window"}); return; }
      const reason = String(msg.reason || "");
      const dup = /d[ée]j[àa]|existe|pris|utilis/i.test(reason);
      const to = reason === "timeout";
      if (!dup && !to) { send({ok:false, retried:false, reason}); return; }
      const newAddr = await rotateMailboxForWindow(wid);
      if (!newAddr) { send({ok:false, retried:false, error:"rotation failed"}); return; }
      const sent = await refillSignupForWindow(wid, newAddr);
      send({ok:true, retried: sent > 0, newAddress: newAddr, sent});
    } catch (e) { send({ok:false, error:String(e)}); }
  })();
  return true;
});
