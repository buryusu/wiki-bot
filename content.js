(function () {
  "use strict";
  var WIKI_HOSTS = new Set(["www.wiki-masters.com", "wiki-masters.com"]);
  if (!WIKI_HOSTS.has(location.hostname)) return;
  var STORAGE_KEY = "wmph_settings";
  var DEFAULTS = {
    enabled:true, pollMs:120, actionDelay:250, viewDelay:180, retryDelay:500,
    navigationDelay:150, signupFillDelay:150, signupSubmitDelay:150,
    signupButtonPollMs:75, signupButtonTimeoutMs:15000, otpSubmitDelay:150,
    autoStartupGate:true, autoSignup:true, autoSwitch:false, autoCloseAndRestart:false, signupResultTimeoutMs:20000,
    signupResultPollMs:250, usernameMinLength:3, usernameMaxLength:24
  };
  var settings = Object.assign({}, DEFAULTS);
  var halted=false, busy=false, observer=null, timer=null, navigationTimer=null;
  var lastUrl=location.href, inPulls=false, inPullStartup=false;
  var startupListenerInstalled=false, startupValidated=false, startupWaitingForPack=false;
  var startupWatchTimer=null, startupGateObserver=null, urlWatcher=null, startupUserGestureAt=0;
  var signupResultWatcher=null, lastSignupEmail=null, currentAccountEmail=null;
  var currentPackCards=[], currentPackStartedAt=null, packCounter=0;
  var noOpenButtonSince=0;
  var sawPullGate=false, captchaConfirmed=false;
  var state = {status:"Repos", packs:0};
  var sleep = function (ms) { return new Promise(function (r) { return setTimeout(r, Math.max(0, Number(ms) || 0)); }); };
  var normalize = function (s) { return (s || "").replace(/\s+/g, " ").trim(); };
  var isWiki = function () { return WIKI_HOSTS.has(location.hostname); };
  var isPullsPage = function () { try { return isWiki() && new URL(location.href).pathname.startsWith("/pulls"); } catch (e) { return false; } };
  var isPullStartupPage = function () { try { return isWiki() && /^\/pull\/?$/.test(new URL(location.href).pathname); } catch (e) { return false; } };
  var isSignupPage = function () { try { return isWiki() && new URL(location.href).pathname.startsWith("/signup"); } catch (e) { return false; } };
  var isLoginPage  = function () { try { return isWiki() && /^\/login(\/?$|\/)/i.test(new URL(location.href).pathname); } catch (e) { return false; } };
  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }
  function allButtons() { return Array.from(document.querySelectorAll("button")).filter(isVisible); }
  function findStartupGate() {
    var cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(function (i) {
      var l = i.closest("label");
      return /je ne suis pas un robot/i.test(normalize((l && l.innerText) || ""));
    });
    if (!cb) return {checkbox:null, button:null};
    var l = cb.closest("label");
    var c = cb.closest("div.relative") || (l && l.parentElement);
    var btns = Array.from((c || document).querySelectorAll("button")).filter(isVisible);
    var btn = btns.find(function (b) { return normalize(b.innerText || b.textContent) === "Continuer"; }) || null;
    return {checkbox:cb, button:btn};
  }
  function findOpenPackButton() {
    var img = Array.from(document.querySelectorAll('img[alt="Ouvrir un paquet"]')).find(isVisible);
    if (img) { var b = img.closest("button"); if (b && !b.disabled) return b; }
    return allButtons().find(function (b) {
      var t = normalize(b.innerText);
      return /^Ouvrir$/.test(t) && !b.disabled && !/pack pro/i.test((b.parentElement && b.parentElement.innerText) || "");
    }) || null;
  }
  var findContinueButton = function () { return allButtons().find(function (b) { return normalize(b.innerText) === "Continuer"; }) || null; };
  var findMoreCardsButton = function () { return allButtons().find(function (b) { return /^Encore \d+ carte/.test(normalize(b.innerText)); }) || null; };
  var viewerIsOpen = function () { return !!findContinueButton() || !!findMoreCardsButton() || !!document.querySelector(".legendary-shimmer-sheen"); };
  function findNextButton() {
    var all = allButtons();
    for (var i = 0; i < all.length; i++) {
      if (all[i].querySelector('polyline[points="9 18 15 12 9 6"]')) return all[i];
    }
    var m = findMoreCardsButton();
    if (m) {
      var row = m.parentElement;
      if (row) {
        var btns = Array.from(row.querySelectorAll("button")).filter(isVisible);
        if (btns.length) return btns[btns.length-1];
      }
    }
    return null;
  }
  function setStatus(s) { state.status = s; renderOverlay(); }
  function makeOverlay() {
    if (document.getElementById("wmph-overlay")) return;
    var box = document.createElement("div");
    box.id = "wmph-overlay";
    box.innerHTML = '<div id="wmph-title">Pack Hunter</div><div id="wmph-status">Repos</div><div id="wmph-packs">Packs parcourus : 0</div><button id="wmph-toggle" type="button">-</button>';
    Object.assign(box.style, {
      position:"fixed", right:"16px", bottom:"16px", zIndex:"2147483647", width:"220px",
      padding:"12px", borderRadius:"12px", background:"rgba(15,23,42,.96)", color:"#fff",
      font:"13px/1.4 system-ui,sans-serif", boxShadow:"0 10px 35px rgba(0,0,0,.35)",
      border:"1px solid rgba(255,255,255,.12)"
    });
    Object.assign(box.querySelector("#wmph-title").style, {fontWeight:"700", marginBottom:"5px"});
    Object.assign(box.querySelector("#wmph-status").style, {color:"#94a3b8", marginBottom:"3px"});
    Object.assign(box.querySelector("#wmph-packs").style, {color:"rgba(255,255,255,.65)", fontSize:"12px", marginBottom:"9px"});
    Object.assign(box.querySelector("#wmph-toggle").style, {width:"100%", border:"0", borderRadius:"8px", padding:"8px", cursor:"pointer", fontWeight:"700"});
    box.querySelector("#wmph-toggle").addEventListener("click", function () {
      if (!inPulls) return;
      if (sawPullGate && !captchaConfirmed) return;
      if (halted) {
        halted = false; settings.enabled = true;
        saveSettings().then(function () { setStatus("Recherche d'un pack..."); runLoop(); });
      } else {
        settings.enabled = !settings.enabled;
        saveSettings().then(function () {
          if (!settings.enabled) { busy = false; setStatus("Arrêté"); clearScheduled(); }
          else { setStatus("Recherche d'un pack..."); runLoop(); }
        });
      }
    });
    document.documentElement.appendChild(box);
    renderOverlay();
  }
  function renderOverlay() {
    var box = document.getElementById("wmph-overlay");
    if (!box) return;
    var st = box.querySelector("#wmph-status");
    var pk = box.querySelector("#wmph-packs");
    var bt = box.querySelector("#wmph-toggle");
    pk.textContent = "Packs parcourus : " + state.packs;
    if (sawPullGate && !captchaConfirmed) {
      st.textContent = "Captcha non validé - attente"; st.style.color = "#fbbf24";
      bt.textContent = "Attente captcha"; bt.style.background = "#475569"; bt.style.color = "#fff"; bt.disabled = true; return;
    }
    if (inPullStartup) {
      st.textContent = "En attente de validation"; st.style.color = "#fbbf24";
      bt.textContent = "Attente"; bt.style.background = "#475569"; bt.style.color = "#fff"; bt.disabled = true;
    } else if (!inPulls) {
      st.textContent = "Repos - hors /pulls"; st.style.color = "#94a3b8";
      bt.textContent = "Aller dans /pulls"; bt.style.background = "#475569"; bt.style.color = "#fff"; bt.disabled = true;
    } else if (halted) {
      st.textContent = state.status; st.style.color = "#f87171";
      bt.textContent = "Reprendre"; bt.style.background = "#ef4444"; bt.style.color = "#fff"; bt.disabled = false;
    } else if (settings.enabled) {
      st.textContent = state.status; st.style.color = "#4ade80";
      bt.textContent = "Arrêter"; bt.style.background = "#22c55e"; bt.style.color = "#052e16"; bt.disabled = false;
    } else {
      st.textContent = "Arrêté"; st.style.color = "#fbbf24";
      bt.textContent = "Démarrer"; bt.style.background = "#f59e0b"; bt.style.color = "#1c1917"; bt.disabled = false;
    }
  }
  function clearScheduled() {
    if (timer) clearTimeout(timer); timer = null;
    if (navigationTimer) clearTimeout(navigationTimer); navigationTimer = null;
    if (startupWatchTimer) clearTimeout(startupWatchTimer); startupWatchTimer = null;
  }
  async function saveSettings() { await chrome.storage.local.set({[STORAGE_KEY]: settings}); }
  async function loadSettings() {
    var d = await chrome.storage.local.get(STORAGE_KEY);
    settings = Object.assign({}, DEFAULTS, d[STORAGE_KEY] || {});
  }
  async function waitForPackResult(timeout) {
    timeout = timeout || 12000;
    var s = Date.now();
    while (Date.now() - s < timeout) {
      if (!inPulls || !settings.enabled || halted) return false;
      if (viewerIsOpen()) return true;
      await sleep(settings.pollMs);
    }
    return false;
  }
  function extractCardInfo() {
    var card = document.querySelector(".rounded-2xl");
    if (!card) return null;
    var n = card.querySelector("h3");
    var name = normalize((n && n.innerText) || (n && n.textContent) || "");
    if (!name) return null;
    var img = card.querySelector("img");
    var imgAlt = (img && img.getAttribute("alt")) || "";
    var rarity = "";
    var divs = card.querySelectorAll("div");
    for (var i = 0; i < divs.length; i++) {
      var el = divs[i];
      if (!isVisible(el)) continue;
      var cls = typeof el.className === "string" ? el.className : "";
      if (cls.indexOf("absolute") === -1 || cls.indexOf("top-2") === -1 || cls.indexOf("left-2") === -1) continue;
      var t = normalize(el.textContent);
      if (/^(L|UR|SR|R|PC|C)$/.test(t)) { rarity = t; break; }
    }
    if (!rarity) {
      var shimmer = card.querySelector(".legendary-shimmer-sheen");
      if (shimmer || /legendary|l[ée]gendaire/i.test(imgAlt)) rarity = "L";
    }
    return {name: name, rarity: rarity || "unknown", imgAlt: imgAlt};
  }
  async function inspectCurrentCard() {
    await sleep(settings.viewDelay);
    if (!inPulls || !settings.enabled || halted) return false;
    var info = extractCardInfo();
    if (info) currentPackCards.push(info);
    var more = findMoreCardsButton();
    if (more) {
      var next = findNextButton();
      if (!next || next.disabled) { setStatus("Attente de la prochaine carte..."); await sleep(settings.retryDelay); return true; }
      next.click(); await sleep(settings.viewDelay); return true;
    }
    var cont = findContinueButton();
    if (cont) {
      if (currentAccountEmail && currentPackCards.length) {
        packCounter++;
        var pack = {
          packId: "p_" + Date.now() + "_" + packCounter,
          openedAt: currentPackStartedAt ? new Date(currentPackStartedAt).toISOString() : new Date().toISOString(),
          closedAt: new Date().toISOString(),
          cards: currentPackCards.slice()
        };
        wmphAppendPack(currentAccountEmail, pack).catch(function () {});
      }
      currentPackCards = []; currentPackStartedAt = null;
      cont.click(); state.packs++; renderOverlay();
      await sleep(settings.actionDelay); return true;
    }
    return true;
  }
  async function runLoop() {
    if (busy || !inPulls || !settings.enabled || halted) return;
    if (sawPullGate && !captchaConfirmed) { setStatus("Captcha non validé - attente"); return; }
    busy = true;
    try {
      while (inPulls && settings.enabled && !halted) {
        if (sawPullGate && !captchaConfirmed) { setStatus("Captcha non validé - attente"); break; }
        if (viewerIsOpen()) {
          noOpenButtonSince = 0;
          setStatus("Analyse du pack...");
          if (!(await inspectCurrentCard())) break;
          continue;
        }
        var open = findOpenPackButton();
        if (open && !open.disabled) {
          noOpenButtonSince = 0;
          setStatus("Ouverture du pack...");
          currentPackStartedAt = Date.now();
          currentPackCards = [];
          open.click();
          var appeared = await waitForPackResult();
          if (!appeared && inPulls && settings.enabled) { setStatus("Attente du résultat..."); await sleep(settings.retryDelay); }
          continue;
        }
        if (document.body.innerText.indexOf("Sanction anti-triche") !== -1) {
          settings.enabled = false; halted = true;
          await saveSettings(); setStatus("Arrêt : restriction anti-triche"); break;
        }
        var body = normalize(document.body.innerText);
        // Do not switch merely because the page contains a pack counter. Only
        // an explicit zero / no-more-packs message may trigger auto-switch.
        var noPacksNow = /(?:aucun|0)\s+(?:paquet|pack|pull)s?\s+disponibles?|plus\s+(?:de\s+)?(?:paquets?|packs?|pulls?)|no\s+(?:packs?|pulls?)\s+(?:available|remaining)|no\s+more\s+(?:packs?|pulls?)/i.test(body);
        if (!noOpenButtonSince) noOpenButtonSince = Date.now();
        var emptyAfterCompletedPacks = state.packs > 0 &&
          Date.now() - noOpenButtonSince >= Math.max(1500, (Number(settings.retryDelay) || 500) * 4);
        var noPacksConfirmed = noPacksNow || emptyAfterCompletedPacks;
        setStatus(noPacksConfirmed ? "Aucun pack disponible" : "Recherche d'un pack...");
        if (noPacksConfirmed && settings.autoCloseAndRestart) { triggerAutoCloseAndRestart(); break; }
        if (noPacksConfirmed && settings.autoSwitch) { triggerAutoSwitch(); break; }
        await sleep(settings.retryDelay);
      }
    } finally { busy = false; renderOverlay(); }
  }
  function resetForNavigation() {
    clearScheduled(); busy = false; halted = false;
    noOpenButtonSince = 0;
    loginFillAttempted = false; // allow re-fill on new page
    if (isLoginPage()) tryFillLogin();
    inPulls = isPullsPage();
    inPullStartup = isPullStartupPage();
    if (inPullStartup) { sawPullGate = true; captchaConfirmed = false; }
    startupWaitingForPack = false; startupUserGestureAt = 0;
    if (!inPullStartup) startupValidated = false;
    installStartupGateSensor();
    state.status = inPulls
      ? (settings.enabled ? "Recherche d'un pack..." : "Arrêté")
      : (inPullStartup ? "En attente de validation" : "Repos");
    renderOverlay();
    if (inPulls && settings.enabled && (!sawPullGate || captchaConfirmed)) {
      timer = setTimeout(function () { runLoop(); }, Math.max(0, Number(settings.navigationDelay) || 150));
    }
  }
  function checkUrlChange() {
    var c = location.href;
    if (c === lastUrl) return;
    lastUrl = c;
    if (navigationTimer) clearTimeout(navigationTimer);
    navigationTimer = setTimeout(resetForNavigation, Math.max(0, Number(settings.navigationDelay) || 150));
  }
  function installNavigationHooks() {
    if (installNavigationHooks._i) return;
    installNavigationHooks._i = true;
    var op = history.pushState, or = history.replaceState;
    history.pushState = function () { var r = op.apply(this, arguments); queueMicrotask(checkUrlChange); return r; };
    history.replaceState = function () { var r = or.apply(this, arguments); queueMicrotask(checkUrlChange); return r; };
    window.addEventListener("popstate", checkUrlChange, true);
    window.addEventListener("hashchange", checkUrlChange, true);
    if (urlWatcher) clearInterval(urlWatcher);
    urlWatcher = setInterval(checkUrlChange, 100);
  }
  function startAfterStartupGate() {
    if (!isWiki() || !startupValidated) return;
    captchaConfirmed = true;
    startupWaitingForPack = true; inPullStartup = false; inPulls = isPullsPage();
    setStatus("Validation détectée - démarrage...");
    if (startupWatchTimer) clearTimeout(startupWatchTimer);
    var s = Date.now(), timeout = 20000, poll = Math.max(50, Number(settings.pollMs) || 120);
    var watch = function () {
      if (!isWiki() || !startupValidated) return;
      if (isPullsPage()) { startupWaitingForPack = false; resetForNavigation(); return; }
      var open = findOpenPackButton();
      if (isPullStartupPage() && open && !open.disabled) {
        startupWaitingForPack = false; inPulls = true; inPullStartup = false;
        state.status = settings.enabled ? "Recherche d'un pack..." : "Arrêté";
        renderOverlay();
        if (settings.enabled && !busy && !halted) runLoop();
        return;
      }
      if (Date.now() - s < timeout) startupWatchTimer = setTimeout(watch, poll);
      else { startupWaitingForPack = false; setStatus("Validation OK - interface introuvable"); }
    };
    watch();
  }
  function installStartupGateSensor() {
    if (startupListenerInstalled) return;
    startupListenerInstalled = true;
    document.addEventListener("change", function (e) {
      if (!isPullStartupPage()) return;
      sawPullGate = true;
      var i = e.target instanceof HTMLInputElement ? e.target : null;
      if (!i || i.type !== "checkbox") return;
      var l = i.closest("label");
      if (!/je ne suis pas un robot/i.test(normalize((l && l.innerText) || ""))) return;
      if (e.isTrusted) startupUserGestureAt = Date.now();
      if (i.checked) { startupValidated = false; inPullStartup = true; setStatus("Vérification cochée"); }
      else { startupValidated = false; inPullStartup = true; setStatus("En attente de validation"); }
    }, true);
    document.addEventListener("click", function (e) {
      if (!isPullStartupPage()) return;
      sawPullGate = true;
      var t = e.target instanceof Element ? e.target.closest("button") : null;
      if (!t) return;
      var g = findStartupGate();
      var btxt = normalize(t.innerText || t.textContent);
      if (!g.checkbox || !g.checkbox.checked || btxt !== "Continuer" || t.disabled) return;
      startupUserGestureAt = Date.now(); startupValidated = true; captchaConfirmed = true;
      setStatus("Validation détectée");
      startAfterStartupGate();
    }, true);
    if (startupGateObserver) startupGateObserver.disconnect();
    startupGateObserver = new MutationObserver(function () {
      if (!isPullStartupPage()) return;
      sawPullGate = true;
      var g = findStartupGate();
      var cb = g.checkbox, btn = g.button;
      if (cb) {
        inPullStartup = true;
        if (cb.checked && btn && !btn.disabled) {
          setStatus("Vérification prête");
          if (settings.autoStartupGate && !startupValidated) {
            startupValidated = true; startupUserGestureAt = Date.now();
            setTimeout(function () { try { if (btn && !btn.disabled) { btn.click(); captchaConfirmed = true; } } catch (e) {} },
              Math.max(50, Number(settings.signupFillDelay) || 150));
          }
        } else if (!cb.checked) {
          setStatus("En attente de validation");
          if (settings.autoStartupGate && !startupValidated) {
            setTimeout(function () { try { if (!cb.checked && !cb.disabled) cb.click(); } catch (e) {} },
              Math.max(50, Number(settings.signupFillDelay) || 150));
          }
        }
        return;
      }
      if (!startupValidated && startupUserGestureAt && Date.now() - startupUserGestureAt < 3000 && findOpenPackButton()) {
        startupValidated = true; captchaConfirmed = true; startAfterStartupGate();
      }
    });
    if (document.documentElement) {
      startupGateObserver.observe(document.documentElement, {
        subtree:true, childList:true, attributes:true, attributeFilter:["disabled","class","checked"]
      });
    }
  }
  function reportSignupResult(ok, reason) {
    if (currentAccountEmail) {
      wmphUpsertAccount(currentAccountEmail, {
        signupStatus: ok ? "success" : "failed",
        failureReason: ok ? null : (reason || null)
      }).catch(function () {});
    }
    try {
      chrome.runtime.sendMessage({
        type:"wmph_signup_result", ok: ok, reason: reason || null,
        email: lastSignupEmail || currentAccountEmail
      });
    } catch (e) {}
  }
  function detectSignupError() {
    var sels = ['[role="alert"]', ".text-red-500", ".text-red-600", ".text-destructive", "[data-error]"];
    for (var i = 0; i < sels.length; i++) {
      var nodes = Array.from(document.querySelectorAll(sels[i])).filter(isVisible);
      for (var j = 0; j < nodes.length; j++) {
        var t = normalize(nodes[j].innerText || nodes[j].textContent);
        if (!t) continue;
        if (/d[ée]j[àa]\s+(utilis|pris)|existe\s+d[ée]j[àa]|invalide|incorrect|refus|erreur|trop\s+(court|long)/i.test(t)) return t;
      }
    }
    return null;
  }
  function watchSignupResult() {
    if (signupResultWatcher) clearInterval(signupResultWatcher);
    var s = Date.now();
    var to = Math.max(2000, Number(settings.signupResultTimeoutMs) || 20000);
    var p = Math.max(100, Number(settings.signupResultPollMs) || 250);
    signupResultWatcher = setInterval(function () {
      if (!isSignupPage()) {
        clearInterval(signupResultWatcher); signupResultWatcher = null;
        reportSignupResult(true, "navigated"); return;
      }
      var e = detectSignupError();
      if (e) {
        clearInterval(signupResultWatcher); signupResultWatcher = null;
        reportSignupResult(false, e);
        setStatus("Inscription refusée : " + e.slice(0, 60)); return;
      }
      if (Date.now() - s > to) {
        clearInterval(signupResultWatcher); signupResultWatcher = null;
        reportSignupResult(false, "timeout"); setStatus("Inscription : timeout");
      }
    }, p);
  }
  function setReactInputValue(input, value) {
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (d && d.set) d.set.call(input, value); else input.value = value;
    } catch (e) { input.value = value; }
    input.dispatchEvent(new Event("input", {bubbles:true}));
    input.dispatchEvent(new Event("change", {bubbles:true}));
    input.dispatchEvent(new Event("blur", {bubbles:true}));
  }
  function waitForCreateAccountButton() {
    var delay = Math.max(0, Number(settings.signupSubmitDelay) || 150);
    var poll = Math.max(25, Number(settings.signupButtonPollMs) || 75);
    var to = Math.max(1000, Number(settings.signupButtonTimeoutMs) || 15000);
    setTimeout(function () {
      var s = Date.now(); var clicked = false;
      var clickable = function (b) {
        if (!b || !document.contains(b) || !isSignupPage()) return false;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        var st = getComputedStyle(b);
        if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") return false;
        var r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      var check = function () {
        if (clicked || !isSignupPage()) return;
        var b = Array.from(document.querySelectorAll('button[type="submit"]')).find(function (x) { return /cr[ée]er\s+mon\s+compte/i.test(normalize(x.innerText || x.textContent)); })
          || Array.from(document.querySelectorAll("button")).find(function (x) { return /cr[ée]er\s+mon\s+compte/i.test(normalize(x.innerText || x.textContent)); });
        if (clickable(b)) { clicked = true; b.click(); watchSignupResult(); return; }
        if (Date.now() - s < to) setTimeout(check, poll);
      };
      check();
    }, delay);
  }
  async function fillSignup(email, delay) {
    if (!email || !isSignupPage()) return false;
    var v = String(email).trim();
    var at = v.indexOf("@");
    if (at <= 0 || at === v.length - 1) return false;
    var user = v.slice(0, at), em = v;
    if (user.length < (settings.usernameMinLength || 3) || user.length > (settings.usernameMaxLength || 24)) return false;
    if (delay == null) delay = settings.signupFillDelay;
    if (delay > 0) await sleep(delay);
    lastSignupEmail = em; currentAccountEmail = em;
    wmphUpsertAccount(em, {username: user, password: em, signupStatus: "pending"}).catch(function () {});
    wmphSetCurrentEmail(em).catch(function () {});
    var u = document.querySelector("#username") || document.querySelector('input[autocomplete="username"]');
    var ei = document.querySelector("#email") || document.querySelector('input[type="email"][autocomplete="email"]');
    var p = document.querySelector("#password") || document.querySelector('input[type="password"][autocomplete="new-password"]');
    if (!u || !ei || !p) return false;
    setReactInputValue(u, user);
    setReactInputValue(ei, em);
    setReactInputValue(p, em);
    var checks = Array.from(document.querySelectorAll('#signup-form input[type="checkbox"], form input[type="checkbox"]'));
    for (var i = 0; i < checks.length; i++) { if (!checks[i].checked && !checks[i].disabled) checks[i].click(); }
    var ok = u.value === user && ei.value === em && p.value === em && checks.every(function (c) { return c.checked || c.disabled; });
    if (ok) waitForCreateAccountButton();
    return ok;
  }
  function fillOtp(code) {
    if (!code) return false;
    var i = document.querySelector("#signup-otp-code") || document.querySelector('input[name="otp"]');
    if (!i || i.disabled || i.readOnly) return false;
    var v = String(code).trim();
    if (!/^\d{6,12}$/.test(v)) return false;
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (d && d.set) d.set.call(i, v); else i.value = v;
    } catch (e) { i.value = v; }
    i.dispatchEvent(new Event("input", {bubbles:true}));
    i.dispatchEvent(new Event("change", {bubbles:true}));
    i.dispatchEvent(new Event("blur", {bubbles:true}));
    i.focus();
    var sb = Array.from(document.querySelectorAll("button")).find(function (b) {
      if (!isVisible(b) || b.disabled) return false;
      return /v[ée]rifier\s+et\s+continuer/i.test(normalize(b.innerText || b.textContent));
    });
    if (sb) {
      var delay = Math.max(0, Number(settings.otpSubmitDelay) || 150);
      setTimeout(function () {
        var s = Date.now(); var mw = 10000, ce = 75;
        var clickable = function (b) {
          if (!b || !document.contains(b) || !isSignupPage()) return false;
          if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
          if (!isVisible(b)) return false;
          var st = getComputedStyle(b);
          if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") return false;
          var r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        var w = function () {
          if (!isSignupPage()) return;
          var cb = Array.from(document.querySelectorAll("button")).find(function (b) { return /v[ée]rifier\s+et\s+continuer/i.test(normalize(b.innerText || b.textContent)); });
          if (clickable(cb)) { cb.click(); watchSignupResult(); return; }
          if (Date.now() - s < mw) setTimeout(w, ce);
        };
        w();
      }, delay);
    }
    return true;
  }
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area !== "local" || !ch[STORAGE_KEY]) return;
    settings = Object.assign({}, DEFAULTS, ch[STORAGE_KEY].newValue || {});
    renderOverlay();
    if (inPulls && settings.enabled && !halted) {
      clearScheduled();
      timer = setTimeout(runLoop, settings.navigationDelay);
    }
  });
  chrome.runtime.onMessage.addListener(function (msg, _s, send) {
    if (!msg || msg.type !== "wmph") return;
    if (msg.action === "fillOtp") { send({filled: fillOtp(msg.code)}); return true; }
    if (msg.action === "fillSignup") {
      var d = Number(msg.delay != null ? msg.delay : settings.signupFillDelay) || 0;
      fillSignup(msg.email, d).then(function (f) { send({filled: f}); });
      return true;
    }
    if (msg.action === "getState") {
      send({enabled:settings.enabled, halted:halted, status:state.status, packs:state.packs, inPulls:inPulls, settings:settings});
      return true;
    }
    if (msg.action === "toggle") {
      settings.enabled = !settings.enabled;
      if (!settings.enabled) { clearScheduled(); setStatus("Arrêté"); }
      else if (inPulls) { halted = false; setStatus("Recherche d'un pack..."); runLoop(); }
      saveSettings().then(function () { send({enabled:settings.enabled, halted:halted, status:state.status, packs:state.packs, inPulls:inPulls, settings:settings}); });
      return true;
    }
    if (msg.action === "updateSettings") {
      settings = Object.assign({}, settings, msg.settings || {});
      saveSettings().then(function () {
        if (inPulls && settings.enabled && !halted) { clearScheduled(); timer = setTimeout(runLoop, settings.navigationDelay); }
        send({settings:settings});
      });
      return true;
    }
    if (msg.action === "resetSettings") {
      settings = Object.assign({}, DEFAULTS);
      saveSettings().then(function () { send({settings:settings}); });
      return true;
    }
    if (msg.action === "retrySignup") {
      lastSignupEmail = msg.email || lastSignupEmail;
      if (signupResultWatcher) { clearInterval(signupResultWatcher); signupResultWatcher = null; }
      fillSignup(lastSignupEmail, 0).then(function (f) { send({filled: f}); });
      return true;
    }
    if (msg.action === "getAccounts") { wmphGetAccounts().then(function (a) { send({accounts:a}); }); return true; }
    if (msg.action === "getCurrentAccount") { wmphGetCurrentEmail().then(function (e) { send({email:e}); }); return true; }
    if (msg.action === "clearAccounts") { wmphClearAll().then(function () { send({ok:true}); }); return true; }
    if (msg.action === "exportJSON") { wmphExportJSON().then(function (j) { send({json:j}); }); return true; }
    if (msg.action === "exportCSV") { wmphExportCSV().then(function (c) { send({csv:c}); }); return true; }
    if (msg.action === "clearSiteSession") {
      // Supabase persists its browser session under sb-*-auth-token keys.
      // Keep unrelated site preferences intact while removing auth tokens.
      var removed = 0;
      [localStorage, sessionStorage].forEach(function (store) {
        try {
          Object.keys(store).forEach(function (key) {
            if (/^sb-[a-z0-9]+-auth-token(?:$|-)/i.test(key)) {
              store.removeItem(key);
              removed++;
            }
          });
        } catch (e) {}
      });
      send({ok:true, removed:removed});
      return true;
    }
  });
  // ── Preset account login filler ──────────────────────────────────────────
  var loginFillAttempted = false;
  var loginWatcher = null;

  async function tryFillLogin() {
    if (!isLoginPage() || loginFillAttempted) return;
    var creds = null;
    try {
      var d = await chrome.storage.local.get("wmph_login_pending");
      creds = d["wmph_login_pending"] || null;
    } catch (e) {}
    if (!creds || !creds.email || !creds.password) return;

    loginFillAttempted = true;
    // Small delay so React can hydrate
    await sleep(Math.max(400, Number(settings.signupFillDelay) || 400));
    if (!isLoginPage()) return;

    // Common login input selectors
    var emailInput = document.querySelector('input[type="email"]')
      || document.querySelector('input[name="email"]')
      || document.querySelector('#email')
      || document.querySelector('input[autocomplete="email"]')
      || document.querySelector('input[autocomplete="username"]');

    var passInput  = document.querySelector('input[type="password"]')
      || document.querySelector('input[name="password"]')
      || document.querySelector('#password')
      || document.querySelector('input[autocomplete="current-password"]');

    if (!emailInput || !passInput) {
      // Retry: DOM might not be ready yet
      loginFillAttempted = false;
      setTimeout(tryFillLogin, 500);
      return;
    }

    setReactInputValue(emailInput, creds.email);
    setReactInputValue(passInput, creds.password);

    // Submit
    await sleep(200);
    var submitBtn = Array.from(document.querySelectorAll('button[type="submit"], button'))
      .find(function (b) {
        if (!isVisible(b) || b.disabled) return false;
        var t = normalize(b.innerText || b.textContent);
        return /connexion|se connecter|login|sign.?in|continuer/i.test(t);
      });

    if (submitBtn) {
      await sleep(150);
      submitBtn.click();
      // Clear pending creds after submit
      try { await chrome.storage.local.remove("wmph_login_pending"); } catch (e) {}
    }
  }

  function installLoginSensor() {
    if (loginWatcher) return;
    var obs = new MutationObserver(function () {
      if (isLoginPage() && !loginFillAttempted) tryFillLogin();
    });
    obs.observe(document.documentElement, { subtree: true, childList: true });
    loginWatcher = obs;
    if (isLoginPage()) tryFillLogin();
  }

  // ── Auto-switch: fire when no packs and autoSwitch is enabled ────────────
  var autoSwitchCooldown = false;

  async function triggerAutoSwitch() {
    if (autoSwitchCooldown || !settings.autoSwitch) return;
    autoSwitchCooldown = true;
    setStatus("Changement de compte…");
    try {
      await chrome.runtime.sendMessage({ type: "wmph_auto_switch" });
    } catch (e) {}
    // Cooldown to avoid spam: 30 seconds
    setTimeout(function () { autoSwitchCooldown = false; }, 30000);
  }

  async function triggerAutoCloseAndRestart() {
    setStatus("Fermeture et relance...");
    try {
      await chrome.runtime.sendMessage({ type: "wmph_auto_close_restart" });
    } catch (e) {}
  }

  async function init() {
    installNavigationHooks();
    installStartupGateSensor();
    installLoginSensor();
    await loadSettings();
    var start = function () {
      try {
        makeOverlay();
        inPulls = isPullsPage();
        inPullStartup = isPullStartupPage();
        if (inPullStartup) { sawPullGate = true; captchaConfirmed = false; }
        if (observer) observer.disconnect();
        observer = new MutationObserver(function () {
          if (isPullStartupPage()) { inPullStartup = true; installStartupGateSensor(); }
          if (!inPulls || !settings.enabled || busy || halted) return;
          if (sawPullGate && !captchaConfirmed) return;
          clearScheduled();
          timer = setTimeout(runLoop, Math.max(0, Number(settings.pollMs) || 120));
        });
        if (document.documentElement) {
          observer.observe(document.documentElement, {
            subtree:true, childList:true, attributes:true, attributeFilter:["disabled","class"]
          });
        }
        resetForNavigation();
      } catch (e) { console.error("[WMPH] init", e); }
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, {once:true});
    else start();
  }
  init().catch(function (e) { console.error("[WikiMasters Pack Hunter]", e); setStatus("Erreur d'initialisation"); });
})();
