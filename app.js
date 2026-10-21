(() => {
  const CFG = window.APP_CONFIG;
  const P = CFG.STORAGE_PREFIX;

  // Storage. Every access is guarded; if storage is blocked the app still works in memory.
  const mem = {};
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`${P}:${key}`);
        if (raw != null) return JSON.parse(raw);
      } catch {}
      return key in mem ? mem[key] : fallback;
    },
    set(key, value) {
      mem[key] = value;
      try { localStorage.setItem(`${P}:${key}`, JSON.stringify(value)); } catch {}
    },
    remove(key) {
      delete mem[key];
      try { localStorage.removeItem(`${P}:${key}`); } catch {}
    },
  };

  const DEFAULTS = { count: 5, lang: "en", theme: "auto" };
  const settings = { ...DEFAULTS, ...store.get("settings", {}) };
  let entries = store.get("entries", {});

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Dates as local YYYY-MM-DD keys.
  const pad = (n) => String(n).padStart(2, "0");
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const todayKey = () => keyOf(new Date());

  const state = {
    view: "day",
    date: todayKey(),
    month: null,
    lastToday: todayKey(),
  };

  // i18n
  const strings = () => window.I18N[settings.lang] || window.I18N.en;
  const t = (key, vars = {}) => {
    let s = strings()[key] ?? window.I18N.en[key] ?? key;
    if (typeof s !== "string") return s;
    return s.replace(/\{(\w+)\}/g, (_, v) => (v === "name" ? CFG.APP_NAME : vars[v] ?? ""));
  };
  const fmt = (d, opts) => new Intl.DateTimeFormat(strings().locale, opts).format(d);

  // Entries helpers
  const linesFor = (k) => entries[k] || [];
  const filledCount = (k) => linesFor(k).filter((s) => s && s.trim()).length;
  const lastFilledIndex = (k) => {
    const l = linesFor(k);
    for (let i = l.length - 1; i >= 0; i--) if (l[i] && l[i].trim()) return i;
    return -1;
  };

  let saveTimer = null;
  const editedDays = new Set();
  function saveEntries() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushEntries, 250);
  }

  function flushEntries() {
    clearTimeout(saveTimer);
    store.set("entries", entries);
    if (editedDays.size) { Drive.schedule([...editedDays]); editedDays.clear(); }
  }

  const compact = (lines) => (lines || []).filter((s) => s && s.trim()).map((s) => s.trim());

  // Days coming from the Google Doc (his other devices write there too).
  function applyRemote(remote) {
    let changed = false;
    for (const [k, lines] of Object.entries(remote)) {
      if (editedDays.has(k)) continue;
      if (JSON.stringify(compact(entries[k])) === JSON.stringify(lines)) continue;
      if (lines.length) entries[k] = lines; else delete entries[k];
      changed = true;
    }
    if (!changed) return;
    store.set("entries", entries);
    if (document.activeElement?.matches("textarea")) return;
    if (state.view === "day") renderDay();
    if (state.view === "cal") renderCal();
  }

  function saveSettings() { store.set("settings", settings); }

  // Theme + static texts
  function applyTheme() {
    const root = document.documentElement;
    if (settings.theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
    const dark = settings.theme === "dark" ||
      (settings.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    $$('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", dark ? "#2A1E19" : "#F4ECE1"));
  }

  function applyTexts() {
    document.documentElement.lang = settings.lang;
    document.title = CFG.APP_NAME;
    $('meta[name="apple-mobile-web-app-title"]').setAttribute("content", CFG.APP_NAME);
    $$("[data-name]").forEach((el) => (el.textContent = CFG.APP_NAME));
    $$("[data-text]").forEach((el) => (el.textContent = t(el.dataset.text)));
    $$("[data-label]").forEach((el) => {
      el.setAttribute("aria-label", t(el.dataset.label));
      el.title = t(el.dataset.label);
    });
  }

  // Views
  function show(view) {
    state.view = view;
    $("#view-day").hidden = view !== "day";
    $("#view-cal").hidden = view !== "cal";
    $("#view-settings").hidden = view !== "settings";
    if (view !== "cal") window.scrollTo(0, 0);
    if (view === "day") renderDay();
    if (view === "cal") renderCal();
    if (view === "settings") renderSettings();
  }

  // Day view
  function renderDay() {
    const k = state.date;
    const d = parseKey(k);
    const today = todayKey();
    const weekday = fmt(d, { weekday: "long" });
    const eyebrow = k === today ? `${t("today")} · ${weekday}`
      : k === addDays(today, -1) ? `${t("yesterday")} · ${weekday}`
      : weekday;
    const sameYear = d.getFullYear() === new Date().getFullYear();

    $("#day-eyebrow").textContent = eyebrow;
    $("#day-title").textContent = fmt(d, { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
    Shapes.mount($("#day-art"), k);
    $("#next-day").disabled = k >= today;
    $("#go-today").hidden = k === today;

    const list = $("#lines");
    list.innerHTML = "";
    const lines = linesFor(k);
    const total = Math.max(settings.count, lastFilledIndex(k) + 1);
    const placeholders = t("placeholders");

    for (let i = 0; i < total; i++) {
      const li = document.createElement("li");
      li.className = "line";
      const dot = document.createElement("span");
      dot.className = "dot";
      const ta = document.createElement("textarea");
      ta.rows = 1;
      ta.value = lines[i] || "";
      ta.placeholder = placeholders[i % placeholders.length];
      ta.setAttribute("aria-label", t("lineLabel", { n: i + 1 }));
      ta.spellcheck = true;
      ta.dataset.index = i;
      li.classList.toggle("filled", !!ta.value.trim());
      li.append(dot, ta);
      list.append(li);
    }
    // Measure after layout settles, otherwise the first measurement can be at the wrong width.
    requestAnimationFrame(resizeAll);
    updateDayState();
  }

  function autosize(ta) {
    if (!ta.offsetParent) return; // hidden view: measure when it is shown again
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  const resizeAll = () => $$("#lines textarea").forEach(autosize);

  // celebrate: a little wobble of the shapes when the day has just been completed.
  function updateDayState(celebrate = false) {
    const view = $("#view-day");
    const complete = filledCount(state.date) >= settings.count;
    if (celebrate && complete && !view.classList.contains("complete")) Shapes.poke($("#day-art"));
    view.classList.toggle("complete", complete);
  }

  function onLineInput(e) {
    const ta = e.target;
    if (ta.tagName !== "TEXTAREA") return;
    const i = Number(ta.dataset.index);
    const k = state.date;
    const lines = (entries[k] = linesFor(k).slice());
    while (lines.length <= i) lines.push("");
    lines[i] = ta.value;
    // Trim trailing empty lines; drop the day entirely if nothing is left.
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) delete entries[k];
    ta.parentElement.classList.toggle("filled", !!ta.value.trim());
    autosize(ta);
    updateDayState(true);
    editedDays.add(k);
    saveEntries();
  }

  function onLineKey(e) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const ta = e.target;
    if (ta.tagName !== "TEXTAREA") return;
    e.preventDefault();
    const next = ta.parentElement.nextElementSibling?.querySelector("textarea");
    if (next) next.focus(); else ta.blur();
  }

  function goToDay(k) {
    const today = todayKey();
    state.date = k > today ? today : k;
    if (state.view !== "day") show("day"); else renderDay();
  }

  // Calendar view: every month from cal.start to this month, stacked vertically.
  const MIN_YEAR = 2000;
  const cal = { start: null, pickerYear: null, visible: null };
  const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  const monthId = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const thisMonth = () => firstOfMonth(new Date());
  const hasEntriesIn = (y, m) => {
    const prefix = `${y}-${pad(m + 1)}-`;
    return Object.keys(entries).some((k) => k.startsWith(prefix) && filledCount(k) > 0);
  };

  function openCal() {
    const now = thisMonth();
    let start = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const first = Object.keys(entries).sort()[0];
    if (first && parseKey(first) < start) start = firstOfMonth(parseKey(first));
    const selected = firstOfMonth(parseKey(state.date));
    if (selected < start) start = selected;
    cal.start = start;
    closePicker();
    show("cal");
    scrollToMonth(selected);
  }

  function renderCal() {
    // Monday-first week.
    const week = $("#cal-week");
    week.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const span = document.createElement("span");
      span.textContent = fmt(new Date(2024, 0, 1 + i), { weekday: "narrow" }); // 1 Jan 2024 was a Monday
      week.append(span);
    }
    const list = $("#cal-months");
    list.innerHTML = "";
    // Upcoming months, greyed out: until December, and always at least two.
    const now = thisMonth();
    const ahead = Math.max(2, 11 - now.getMonth());
    list.append(monthsFragment(cal.start, new Date(now.getFullYear(), now.getMonth() + ahead, 1)));
    updateChip();
  }

  function monthsFragment(from, to) {
    const frag = document.createDocumentFragment();
    for (let m = new Date(from); m <= to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      frag.append(monthBlock(m));
    }
    return frag;
  }

  function monthBlock(m) {
    const today = todayKey();
    const section = document.createElement("section");
    section.className = m > thisMonth() ? "cal-month future" : "cal-month";
    section.dataset.month = monthId(m);
    const title = document.createElement("h3");
    title.className = "cal-month-title";
    title.textContent = fmt(m, { month: "long" });
    const year = document.createElement("small");
    year.textContent = m.getFullYear();
    title.append(year);

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    const offset = (m.getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) grid.append(document.createElement("span"));
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const d = new Date(m.getFullYear(), m.getMonth(), day);
      const k = keyOf(d);
      const b = document.createElement("button");
      b.className = "cal-day";
      b.textContent = day;
      b.dataset.key = k;
      const n = filledCount(k);
      if (n >= settings.count) b.classList.add("full");
      else if (n > 0) b.classList.add("some");
      if (k === today) b.classList.add("today");
      if (k === state.date && k !== today) b.classList.add("selected");
      b.disabled = k > today;
      b.setAttribute("aria-label", fmt(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
      grid.append(b);
    }
    section.append(title, grid);
    return section;
  }

  // Add older months above without making the view jump.
  function extendBack(to) {
    const target = firstOfMonth(to);
    if (target.getFullYear() < MIN_YEAR || target >= cal.start) return;
    const before = document.documentElement.scrollHeight;
    const until = new Date(cal.start.getFullYear(), cal.start.getMonth() - 1, 1);
    $("#cal-months").prepend(monthsFragment(target, until));
    cal.start = target;
    window.scrollBy(0, document.documentElement.scrollHeight - before);
  }

  function headerBottom() {
    return $("#cal-header").getBoundingClientRect().bottom;
  }

  function scrollToMonth(d) {
    const m = firstOfMonth(d);
    // Keep a year of room above the target so scrolling up doesn't immediately load more.
    extendBack(new Date(m.getFullYear(), m.getMonth() - 12, 1));
    const el = document.querySelector(`.cal-month[data-month="${monthId(m)}"]`);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - headerBottom() + 4;
    window.scrollTo({ top, behavior: "instant" });
    cal.visible = m;
    updateChip();
  }

  function visibleMonth() {
    const limit = headerBottom() + 60;
    let current = null;
    for (const el of $$(".cal-month")) {
      if (el.getBoundingClientRect().top <= limit) current = el;
      else break;
    }
    const id = (current || $(".cal-month"))?.dataset.month;
    if (!id) return thisMonth();
    const [y, mo] = id.split("-").map(Number);
    return new Date(y, mo - 1, 1);
  }

  function updateChip() {
    const m = cal.visible || thisMonth();
    $("#cal-chip-text").textContent = fmt(m, { month: "long", year: "numeric" });
    $("#cal-today").disabled = monthId(m) === monthId(thisMonth());
  }

  let scrollTick = false;
  function onCalScroll() {
    if (state.view !== "cal" || scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      cal.visible = visibleMonth();
      updateChip();
      if (window.scrollY < 200) extendBack(new Date(cal.start.getFullYear(), cal.start.getMonth() - 12, 1));
    });
  }

  // Month/year picker under the chip
  function openPicker() {
    cal.pickerYear = (cal.visible || thisMonth()).getFullYear();
    renderPicker();
    $("#cal-picker").hidden = false;
    $("#cal-chip").setAttribute("aria-expanded", "true");
  }

  function closePicker() {
    $("#cal-picker").hidden = true;
    $("#cal-chip").setAttribute("aria-expanded", "false");
  }

  function renderPicker() {
    const y = cal.pickerYear;
    const now = thisMonth();
    const shown = cal.visible || now;
    $("#picker-year").textContent = y;
    $("#prev-year").disabled = y <= MIN_YEAR;
    $("#next-year").disabled = y >= now.getFullYear();
    const box = $("#picker-months");
    box.innerHTML = "";
    for (let m = 0; m < 12; m++) {
      const d = new Date(y, m, 1);
      const b = document.createElement("button");
      b.textContent = fmt(d, { month: "short" }).replace(".", "");
      b.dataset.month = m;
      b.disabled = d > now;
      if (hasEntriesIn(y, m)) b.classList.add("has");
      if (y === shown.getFullYear() && m === shown.getMonth()) b.classList.add("current");
      b.setAttribute("aria-label", fmt(d, { month: "long", year: "numeric" }));
      box.append(b);
    }
  }

  // Settings view
  function renderSettings() {
    $$(".seg").forEach((seg) => {
      const current = String(settings[seg.dataset.setting]);
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === current)));
    });
    Shapes.mount($("#privacy-art"), "privacy");
    $("#file-status").textContent = "";
    renderDrive();
  }

  function onSeg(e) {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    const key = b.closest(".seg").dataset.setting;
    settings[key] = key === "count" ? Number(b.dataset.value) : b.dataset.value;
    saveSettings();
    if (key === "theme") applyTheme();
    if (key === "lang") applyTexts();
    renderSettings();
  }

  // Drive status in settings and on the day view
  function renderDrive() {
    const s = Drive.status();
    // Always visible; until the Google values are in config.js it shows as not set up yet.
    const ready = s.available && s.canLink;
    const status = $("#drive-status");
    const when = s.lastSync ? fmt(new Date(s.lastSync), { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : "";
    status.textContent = !s.available ? t("driveUnavailable")
      : s.state === "badlink" ? t("driveBadLink")
      : s.state === "notdoc" && !s.linked ? t("driveNotDoc")
      : !s.linked ? (s.state === "error" ? t("driveError") : t("driveOff"))
      : s.state === "syncing" ? t("driveSyncing")
      : s.state === "paused" ? t("drivePaused")
      : s.state === "missing" ? t("driveMissing")
      : s.state === "notdoc" ? t("driveNotDoc")
      : s.state === "unknown" ? t("driveUnknown")
      : s.state === "error" ? t("driveError")
      : s.lastSync ? t("driveOk", { when }) : "";

    $("#drive-setup").hidden = s.linked;
    $("#drive-linked").hidden = !s.linked;
    const link = $("#drive-link");
    // Without an API key only "create a new doc" works, so the link field is hidden then.
    link.hidden = s.available && !s.canLink;
    link.disabled = !ready;
    link.placeholder = t("driveLinkPlaceholder");
    const connect = $("#drive-connect");
    connect.disabled = !s.available;
    connect.textContent = !link.hidden && link.value.trim() ? t("driveLinkThis") : t("driveCreate");
    $("#drive-resume-settings").hidden = s.state !== "paused";
    const open = $("#drive-open");
    open.hidden = !s.docId;
    if (s.docId) open.href = `https://docs.google.com/document/d/${s.docId}/edit`;
    $("#drive-resume").hidden = !(s.linked && s.state === "paused");
  }

  // Export / import
  function exportFile() {
    const data = { app: P, version: 1, exportedAt: new Date().toISOString(), settings, entries };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${CFG.APP_NAME.toLowerCase()}-backup-${todayKey()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importFile(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const status = $("#file-status");
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    const incoming = data && data.app === P && data.entries && typeof data.entries === "object" ? data.entries : null;
    if (!incoming) { status.textContent = t("importBad"); return; }
    if (!confirm(t("importConfirm"))) return;

    // Merge: keep everything already written, fill only empty slots.
    let days = 0;
    for (const [k, lines] of Object.entries(incoming)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !Array.isArray(lines)) continue;
      const mine = linesFor(k).slice();
      lines.forEach((line, i) => {
        if (typeof line === "string" && line.trim() && !(mine[i] && mine[i].trim())) mine[i] = line;
      });
      for (let i = 0; i < mine.length; i++) if (mine[i] == null) mine[i] = "";
      while (mine.length && !mine[mine.length - 1].trim()) mine.pop();
      if (mine.length) { entries[k] = mine; days++; editedDays.add(k); }
    }
    flushEntries();
    status.textContent = t("importDone", { n: days });
  }

  // Installed app on a computer: open as a small window the first time.
  function sizeWindow() {
    const standalone = matchMedia("(display-mode: standalone)").matches;
    const desktop = matchMedia("(pointer: fine)").matches;
    if (!standalone || !desktop || store.get("sized", false)) return;
    try { window.resizeTo(400, 680); } catch {}
    store.set("sized", true);
  }

  // When the app stays open past midnight, follow the new day.
  function checkNewDay() {
    const today = todayKey();
    if (today === state.lastToday) return;
    const wasOnToday = state.date === state.lastToday;
    state.lastToday = today;
    if (wasOnToday) state.date = today;
    if (state.view === "day" && !document.activeElement?.matches("textarea")) renderDay();
  }

  function bind() {
    $("#lines").addEventListener("input", onLineInput);
    $("#lines").addEventListener("keydown", onLineKey);
    $("#prev-day").addEventListener("click", () => goToDay(addDays(state.date, -1)));
    $("#next-day").addEventListener("click", () => goToDay(addDays(state.date, 1)));
    $("#go-today").addEventListener("click", () => goToDay(todayKey()));
    $("#open-cal").addEventListener("click", openCal);
    $("#open-settings").addEventListener("click", () => show("settings"));
    $$("[data-back]").forEach((b) => b.addEventListener("click", () => show("day")));
    $("#cal-months").addEventListener("click", (e) => {
      const b = e.target.closest(".cal-day");
      if (b && !b.disabled) goToDay(b.dataset.key);
    });
    $("#cal-chip").addEventListener("click", () => ($("#cal-picker").hidden ? openPicker() : closePicker()));
    $("#cal-today").addEventListener("click", () => { closePicker(); scrollToMonth(thisMonth()); });
    $("#prev-year").addEventListener("click", () => { cal.pickerYear--; renderPicker(); });
    $("#next-year").addEventListener("click", () => { cal.pickerYear++; renderPicker(); });
    $("#picker-months").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-month]");
      if (!b || b.disabled) return;
      closePicker();
      scrollToMonth(new Date(cal.pickerYear, Number(b.dataset.month), 1));
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
    window.addEventListener("scroll", onCalScroll, { passive: true });
    $$(".seg").forEach((s) => s.addEventListener("click", onSeg));
    $("#export").addEventListener("click", exportFile);
    $("#import").addEventListener("change", importFile);
    $("#drive-connect").addEventListener("click", () => {
      const link = $("#drive-link").value.trim();
      Drive.connect(link).then(() => { if (Drive.status().linked) $("#drive-link").value = ""; });
    });
    $("#drive-link").addEventListener("input", renderDrive);
    $("#drive-resume").addEventListener("click", () => Drive.resume());
    $("#drive-resume-settings").addEventListener("click", () => Drive.resume());
    $("#drive-disconnect").addEventListener("click", () => {
      if (confirm(t("driveDisconnectConfirm"))) Drive.disconnect();
    });

    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);
    window.addEventListener("resize", resizeAll);
    document.fonts?.ready.then(resizeAll);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { checkNewDay(); Drive.schedule(); }
      else flushEntries();
    });
    setInterval(checkNewDay, 60 * 1000);
    window.addEventListener("pagehide", flushEntries);
    window.addEventListener("storage", (e) => {
      if (e.key === `${P}:entries` && !document.activeElement?.matches("textarea")) {
        entries = store.get("entries", {});
        if (state.view === "day") renderDay();
        if (state.view === "cal") renderCal();
      }
    });
  }

  function init() {
    applyTheme();
    applyTexts();
    bind();
    Drive.init({
      clientId: CFG.GOOGLE_CLIENT_ID,
      apiKey: CFG.GOOGLE_API_KEY,
      appId: CFG.GOOGLE_PROJECT_NUMBER,
      lang: () => settings.lang,
      docName: CFG.DOC_NAME,
      appName: CFG.APP_NAME,
      store,
      getEntries: () => entries,
      applyRemote,
      onChange: renderDrive,
    });
    show("day");
    renderDrive();
    sizeWindow();

    // Ask the browser not to clear this data when space runs low.
    navigator.storage?.persist?.().catch(() => {});

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  init();
})();
