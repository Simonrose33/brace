// Optional sync with a Google Doc in his own Drive.
// Runs entirely in the browser: the token stays on this device and the data goes
// straight between this device and his Google Doc. The "drive.file" scope only lets
// the app see docs it created, or the one doc he picks himself.
//
// The doc is the shared reference between his devices, in the format he already uses:
//
//   29/09/2026
//   1. something
//   2. something
//
// The app reads every day from the doc, and only adds or rewrites the days he writes
// in the app. Anything else in the doc is never touched.
window.Drive = (() => {
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DEBOUNCE_MS = 3000;

  let cfg = null;
  let client = null;
  let timer = null;
  let busy = false;
  let again = false;
  let touched = new Set(); // days edited while a sync is running
  let state = "idle"; // idle | syncing | paused | error | missing | notdoc | unknown | badlink
  const loading = {};

  const data = () => cfg.store.get("drive", {});
  const setData = (patch) => cfg.store.set("drive", { ...data(), ...patch });
  const token = () => {
    const t = cfg.store.get("drive-token", null);
    return t && t.exp > Date.now() ? t.value : null;
  };
  const pad = (n) => String(n).padStart(2, "0");

  function setState(s) {
    state = s;
    cfg.onChange?.();
  }

  function loadScript(src) {
    if (!loading[src]) {
      loading[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { delete loading[src]; reject(new Error(src)); };
        document.head.append(s);
      });
    }
    return loading[src];
  }

  async function prepare() {
    await loadScript("https://accounts.google.com/gsi/client");
    if (!client) {
      client = google.accounts.oauth2.initTokenClient({ client_id: cfg.clientId, scope: SCOPE, callback: () => {} });
    }
    if (cfg.apiKey) {
      await loadScript("https://apis.google.com/js/api.js");
      await new Promise((resolve) => gapi.load("picker", resolve));
    }
  }

  // Must be called from a click so the Google popup isn't blocked.
  function requestToken() {
    return new Promise((resolve, reject) => {
      client.callback = (r) => {
        if (r.error) return reject(r);
        cfg.store.set("drive-token", { value: r.access_token, exp: Date.now() + (Number(r.expires_in) - 60) * 1000 });
        resolve(r.access_token);
      };
      client.error_callback = reject;
      client.requestAccessToken({ prompt: data().linked ? "" : "consent" });
    });
  }

  function docIdFromLink(text) {
    const s = (text || "").trim();
    const m = s.match(/\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/) || s.match(/^([\w-]{25,})$/);
    return m ? m[1] : null;
  }

  // Google's own file chooser, opened on the linked doc. Selecting it is what gives
  // the app access to that one file (and nothing else in his Drive).
  function pick(docId, accessToken) {
    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS).setMode(google.picker.DocsViewMode.LIST);
      if (docId && view.setFileIds) view.setFileIds(docId);
      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(cfg.apiKey)
        .setAppId(cfg.appId)
        .setLocale(cfg.lang())
        .setCallback((d) => {
          if (d.action === google.picker.Action.PICKED) resolve(d.docs[0].id);
          else if (d.action === google.picker.Action.CANCEL) resolve(null);
        })
        .build();
      picker.setVisible(true);
    });
  }

  async function api(url, accessToken, options = {}) {
    const r = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...options.headers },
    });
    if (!r.ok) { const e = new Error(String(r.status)); e.status = r.status; throw e; }
    return r.json();
  }

  async function createDoc(accessToken) {
    const doc = await api("https://www.googleapis.com/drive/v3/files?fields=id", accessToken, {
      method: "POST",
      body: JSON.stringify({ name: cfg.docName, mimeType: "application/vnd.google-apps.document" }),
    });
    return doc.id;
  }

  // ---- Reading the doc
  //
  // Flexible on purpose: we don't know exactly how he writes. A day starts with a short
  // line holding a date, in any of these shapes (a weekday around it is fine):
  //   29/09/2026 · 29/9/26 · 29.09.2026 · 29-09 · 2026-09-29 · 29 settembre 2026 ·
  //   Lunedì 29 settembre · Monday, September 29, 2026 · 29 Sep
  // The lines under it are the day's things: an automatic list, "1." / "1)", "-" / "•",
  // or plain lines right under the date.

  const MONTHS = {
    it: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"],
  };
  const WEEKDAYS = { // Monday first
    it: ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"],
    en: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  };
  const NUM_RE = /^(\d{1,2})\s*([.)])\s*/;
  const DASH_RE = /^([-–—•*·])\s+/;
  const fold = (w) => w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.$/, "");
  const startsCap = (w) => /^[A-ZÀ-Ý]/.test(w);

  function lookup(table, word) {
    const w = fold(word);
    if (w.length < 3) return null;
    for (const lang of ["it", "en"]) {
      const i = table[lang].findIndex((name) => fold(name).startsWith(w));
      if (i >= 0) return { lang, index: i, abbr: w.length < fold(table[lang][i]).length };
    }
    return null;
  }

  // First match of `re` in `t` whose word group is a month name.
  function monthMatch(re, t, group) {
    for (const m of t.matchAll(re)) {
      const month = lookup(MONTHS, m[group]);
      if (month) return { m, month };
    }
    return null;
  }

  function parseDate(t, fallbackYear) {
    if (t.length > 40) return null;
    let m, d, mo, y, fmt, hit;
    if ((m = t.match(/(\d{4})([/.-])(\d{1,2})\2(\d{1,2})(?!\d)/))) {
      y = +m[1]; mo = +m[3]; d = +m[4];
      fmt = { kind: "num", order: "ymd", sep: m[2] };
    } else if ((m = t.match(/(?<!\d)(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/))) {
      d = +m[1]; mo = +m[3]; y = m[4].length === 2 ? 2000 + +m[4] : +m[4];
      fmt = { kind: "num", order: "dmy", sep: m[2], shortYear: m[4].length === 2, raw: [m[1], m[3]] };
    } else if ((m = t.match(/(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})(?![\d/.-])/))) {
      d = +m[1]; mo = +m[3]; y = fallbackYear;
      fmt = { kind: "num", order: "dmy", sep: m[2], noYear: true, raw: [m[1], m[3]] };
    } else if ((hit = monthMatch(/(?<!\d)(\d{1,2})(?:°|º|st|nd|rd|th)?\s+(?:di\s+|of\s+)?([A-Za-zÀ-ÿ]{3,}\.?),?(?:\s+(\d{4}))?/g, t, 2))) {
      m = hit.m; d = +m[1]; mo = hit.month.index + 1; y = m[3] ? +m[3] : fallbackYear;
      fmt = { kind: "name", order: "dm", lang: hit.month.lang, year: !!m[3], cap: startsCap(m[2]), abbr: hit.month.abbr };
    } else if ((hit = monthMatch(/([A-Za-zÀ-ÿ]{3,}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(\d{4}))?/g, t, 1))) {
      m = hit.m; d = +m[2]; mo = hit.month.index + 1; y = m[3] ? +m[3] : fallbackYear;
      fmt = { kind: "name", order: "md", lang: hit.month.lang, year: !!m[3], cap: startsCap(m[1]), abbr: hit.month.abbr };
    } else {
      return null;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > new Date(y, mo, 0).getDate()) return null;

    // Besides the date, the line may only hold a weekday and at most one other word.
    const rest = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).replace(/[,.;:()|\-–—]/g, " ").split(/\s+/).filter(Boolean);
    let weekday = null;
    const leftover = rest.filter((w) => {
      const wd = !weekday && lookup(WEEKDAYS, w);
      if (!wd) return true;
      weekday = { lang: wd.lang, cap: startsCap(w), abbr: wd.abbr, first: t.indexOf(w) < m.index };
      return false;
    });
    if (leftover.length > 1) return null;
    fmt.weekday = weekday;
    return { key: `${y}-${pad(mo)}-${pad(d)}`, fmt };
  }

  function itemOf(p, t) {
    let m;
    if (p.bullet) return { kind: "list", value: t };
    if ((m = t.match(NUM_RE))) return { kind: "num", mark: m[2], value: t.slice(m[0].length) };
    if ((m = t.match(DASH_RE))) return { kind: "dash", mark: m[1], value: t.slice(m[0].length) };
    return { kind: "plain", value: t };
  }

  function isNumberedList(doc, listId) {
    const level = doc.lists?.[listId]?.listProperties?.nestingLevels?.[0];
    if (!level) return true;
    return !level.glyphSymbol && level.glyphType !== "GLYPH_TYPE_UNSPECIFIED";
  }

  function parseDoc(doc) {
    const content = doc.body.content;
    const blocks = [];
    let cur = null;
    let gap = false;
    let year = new Date().getFullYear();
    let texts = 0;
    for (const c of content) {
      if (!c.paragraph) { cur = null; continue; }
      const t = (c.paragraph.elements || []).map((e) => e.textRun?.content || "").join("").replace(/\n$/, "").trim();
      if (!t) { gap = true; continue; }
      texts++;
      const p = {
        start: c.startIndex,
        end: c.endIndex,
        bullet: !!c.paragraph.bullet,
        numbered: c.paragraph.bullet ? isNumberedList(doc, c.paragraph.bullet.listId) : false,
        style: c.paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT",
      };
      const date = !p.bullet && !NUM_RE.test(t) && !DASH_RE.test(t) && parseDate(t, year);
      if (date) {
        year = Number(date.key.slice(0, 4));
        cur = { key: date.key, date: { ...p, text: t, fmt: date.fmt }, items: [] };
        blocks.push(cur);
        gap = false;
        continue;
      }
      if (!cur) continue;
      const it = itemOf(p, t);
      // Plain text after a blank line, or after a list, is something else: the day is over.
      if (it.kind === "plain" && (gap || (cur.items.length && cur.items[0].kind !== "plain"))) { cur = null; continue; }
      cur.items.push({ ...p, ...it, raw: t });
      gap = false;
    }
    const last = content[content.length - 1];
    const lastText = (last.paragraph?.elements || []).map((e) => e.textRun?.content || "").join("").trim();
    return { blocks, texts, bodyEnd: last.endIndex, lastEmpty: !lastText };
  }

  function daysFrom(parsed) {
    const days = {};
    for (const b of parsed.blocks) {
      if (b.key in days) continue; // same date twice: the first one counts
      days[b.key] = b.items.map((i) => i.value).filter(Boolean);
    }
    return days;
  }

  // Match how he writes dates and lists, so new days look like his.
  function styleOf(parsed) {
    const first = parsed.blocks[0];
    const withItems = parsed.blocks.find((x) => x.items.length);
    // "09" or "9"? Only a day or month below 10 tells.
    let padded = true;
    for (const x of parsed.blocks) {
      const raw = x.date.fmt.raw;
      if (!raw) continue;
      const small = raw.find((r) => Number(r) < 10);
      if (small) { padded = small.length === 2; break; }
    }
    const it = withItems ? withItems.items[0] : { kind: "num", mark: "." };
    return {
      fmt: first ? first.date.fmt : { kind: "num", order: "dmy", sep: "/" },
      padded,
      dateStyle: first ? first.date.style : "NORMAL_TEXT",
      item: { kind: it.kind, mark: it.mark, numbered: it.kind === "list" ? it.numbered : true },
      ascending: parsed.blocks.length < 2 || parsed.blocks[0].key <= parsed.blocks[parsed.blocks.length - 1].key,
    };
  }

  const capital = (s, yes) => (yes ? s[0].toUpperCase() + s.slice(1) : s);

  function formatDate(key, st) {
    const [y, m, d] = key.split("-").map(Number);
    const f = st.fmt;
    let text;
    if (f.kind === "num") {
      const two = (n) => (st.padded ? pad(n) : String(n));
      if (f.order === "ymd") text = [y, pad(m), pad(d)].join(f.sep);
      else text = [two(d), two(m), ...(f.noYear ? [] : [f.shortYear ? String(y).slice(2) : y])].join(f.sep);
    } else {
      let month = MONTHS[f.lang][m - 1];
      month = capital(f.abbr ? month.slice(0, 3) : month, f.cap);
      text = f.order === "dm" ? `${d} ${month}` : `${month} ${d}`;
      if (f.year) text += (f.order === "md" ? ", " : " ") + y;
    }
    if (f.weekday) {
      let wd = WEEKDAYS[f.weekday.lang][(new Date(y, m - 1, d).getDay() + 6) % 7];
      wd = capital(f.weekday.abbr ? wd.slice(0, 3) : wd, f.weekday.cap);
      text = f.weekday.first ? `${wd}${f.weekday.lang === "en" ? "," : ""} ${text}` : `${text} ${wd}`;
    }
    return text;
  }

  function labelFor(item, i, v) {
    if (item.kind === "num") return `${i + 1}${item.mark} ${v}`;
    if (item.kind === "dash") return `${item.mark} ${v}`;
    return v;
  }

  // ---- Writing one day

  const range = (startIndex, endIndex) => ({ startIndex, endIndex });

  // Requests that make the doc show `lines` for that day. Applied in order by Google,
  // so edits go from the end of the doc towards the start and indices stay valid.
  function dayRequests(parsed, key, lines) {
    const st = styleOf(parsed);
    const block = parsed.blocks.find((b) => b.key === key);
    const reqs = [];

    if (block && block.items.length) {
      const items = block.items;
      const last = items[items.length - 1];
      const kind = items[0];
      const label = (i, v) => labelFor(kind, i, v);
      const keep = Math.min(lines.length, items.length);

      if (lines.length > items.length) {
        // New lines go right after the last one and inherit its list formatting.
        const extra = lines.slice(items.length).map((v, j) => "\n" + label(items.length + j, v)).join("");
        reqs.push({ insertText: { location: { index: last.end - 1 }, text: extra } });
      } else if (lines.length < items.length && lines.length > 0) {
        // Remove the extra lines, keeping the doc's final newline intact.
        reqs.push({ deleteContentRange: { range: range(items[lines.length - 1].end - 1, last.end - 1) } });
      } else if (lines.length === 0) {
        if (last.end < parsed.bodyEnd) {
          reqs.push({ deleteContentRange: { range: range(items[0].start, last.end) } });
        } else {
          reqs.push({ deleteContentRange: { range: range(block.date.end - 1, last.end - 1) } });
          reqs.push({ deleteParagraphBullets: { range: range(block.date.start, block.date.start + 1) } });
          reqs.push({ updateParagraphStyle: { range: range(block.date.start, block.date.start + 1), paragraphStyle: { namedStyleType: block.date.style }, fields: "namedStyleType" } });
        }
      }

      for (let i = keep - 1; i >= 0; i--) {
        const it = items[i];
        const text = label(i, lines[i]);
        if (it.raw === text) continue;
        if (it.end - 1 > it.start) reqs.push({ deleteContentRange: { range: range(it.start, it.end - 1) } });
        reqs.push({ insertText: { location: { index: it.start }, text } });
      }
      return reqs;
    }

    if (!lines.length) return reqs;
    const items = lines.map((v, i) => labelFor(st.item, i, v));

    if (block) {
      // A date with nothing under it yet.
      const at = block.date.end - 1;
      const text = "\n" + items.join("\n");
      reqs.push({ insertText: { location: { index: at }, text } });
      reqs.push(...newParagraphStyles(at + 1, at + text.length, st));
      return reqs;
    }

    // A new day: placed in date order, before the next day (or at the end).
    const next = parsed.blocks.find((b) => (st.ascending ? b.key > key : b.key < key));
    const dateLine = formatDate(key, st);
    if (next) {
      const at = next.date.start;
      const text = `${dateLine}\n${items.join("\n")}\n\n`;
      reqs.push({ insertText: { location: { index: at }, text } });
      reqs.push(...dateStyles(at, at + dateLine.length + 1, st));
      reqs.push(...newParagraphStyles(at + dateLine.length + 1, at + text.length - 1, st));
      reqs.push({ updateParagraphStyle: { range: range(at + text.length - 1, at + text.length), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
    } else {
      const at = parsed.bodyEnd - 1;
      const lead = parsed.blocks.length || !parsed.lastEmpty ? (parsed.lastEmpty ? "\n" : "\n\n") : "";
      const text = `${lead}${dateLine}\n${items.join("\n")}`;
      const dateAt = at + lead.length;
      reqs.push({ insertText: { location: { index: at }, text } });
      if (lead) {
        reqs.push({ deleteParagraphBullets: { range: range(at + 1, dateAt + 1) } });
        reqs.push({ updateParagraphStyle: { range: range(at + 1, dateAt + 1), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } });
      }
      reqs.push(...dateStyles(dateAt, dateAt + dateLine.length + 1, st));
      reqs.push(...newParagraphStyles(dateAt + dateLine.length + 1, at + text.length, st));
    }
    return reqs;
  }

  function dateStyles(start, end, st) {
    return [
      { deleteParagraphBullets: { range: range(start, end) } },
      { updateParagraphStyle: { range: range(start, end), paragraphStyle: { namedStyleType: st.dateStyle }, fields: "namedStyleType" } },
    ];
  }

  function newParagraphStyles(start, end, st) {
    const reqs = [
      { deleteParagraphBullets: { range: range(start, end) } },
      { updateParagraphStyle: { range: range(start, end), paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    ];
    if (st.item.kind === "list") {
      const bulletPreset = st.item.numbered ? "NUMBERED_DECIMAL_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE";
      reqs.push({ createParagraphBullets: { range: range(start, end), bulletPreset } });
    }
    return reqs;
  }

  // ---- Sync

  const FIELDS = "lists,body.content(startIndex,endIndex,paragraph(bullet(listId),paragraphStyle(namedStyleType),elements(textRun(content))))";
  const readDoc = async (docId, accessToken) =>
    parseDoc(await api(`https://docs.googleapis.com/v1/documents/${docId}?fields=${encodeURIComponent(FIELDS)}`, accessToken));

  const cleanLines = (lines) => (lines || []).filter((s) => s && s.trim()).map((s) => s.trim().replace(/\s*\n\s*/g, " "));

  // Send the days edited here, then bring in everything from the doc.
  async function sync() {
    const d = data();
    if (!d.linked || !d.docId) return;
    if (busy) { again = true; return; }
    const accessToken = token();
    if (!accessToken) { setState("paused"); return; }
    busy = true;
    touched = new Set();
    setState("syncing");
    try {
      let parsed = await readDoc(d.docId, accessToken);
      // Text but no recognisable days: better to change nothing than to guess.
      if (!parsed.blocks.length && parsed.texts > 1) { setState("unknown"); return; }
      let pending = d.pending || [];
      if (d.firstSync) {
        // First time: days already in the doc win; days only here get added.
        const inDoc = daysFrom(parsed);
        pending = Object.keys(cfg.getEntries()).filter((k) => !(k in inDoc) && cleanLines(cfg.getEntries()[k]).length);
      }
      for (const key of [...pending].sort()) {
        const reqs = dayRequests(parsed, key, cleanLines(cfg.getEntries()[key]));
        if (!reqs.length) continue;
        await api(`https://docs.googleapis.com/v1/documents/${d.docId}:batchUpdate`, accessToken, {
          method: "POST",
          body: JSON.stringify({ requests: reqs }),
        });
        parsed = await readDoc(d.docId, accessToken);
      }
      const stillPending = (data().pending || []).filter((k) => touched.has(k));
      setData({ pending: stillPending, firstSync: false, lastSync: Date.now() });

      const remote = daysFrom(parsed);
      for (const k of stillPending) delete remote[k];
      cfg.applyRemote(remote);
      setState("idle");
    } catch (e) {
      if (e.status === 401) {
        cfg.store.remove("drive-token");
        setState("paused");
      } else if (e.status === 403 || e.status === 404) {
        setState("missing"); // doc deleted, or access removed
      } else if (e.status === 400) {
        setState("notdoc"); // e.g. a Word file, not a Google Doc
      } else {
        setState("error");
        clearTimeout(timer);
        timer = setTimeout(sync, 60 * 1000);
      }
    } finally {
      busy = false;
      if (again) { again = false; clearTimeout(timer); timer = setTimeout(sync, DEBOUNCE_MS); }
    }
  }

  // keys: the days just edited (optional). Without keys it only refreshes from the doc.
  function schedule(keys = []) {
    if (!cfg?.clientId || !data().linked) return;
    if (keys.length) {
      setData({ pending: [...new Set([...(data().pending || []), ...keys])] });
      keys.forEach((k) => touched.add(k));
    }
    clearTimeout(timer);
    timer = setTimeout(sync, keys.length ? DEBOUNCE_MS : 0);
  }

  // link: a Google Doc link to use; empty to create a new doc.
  async function connect(link) {
    const wanted = link ? docIdFromLink(link) : null;
    if (link && !wanted) { setState("badlink"); return; }
    try {
      if (!client) await prepare(); // usually preloaded, so the popup stays tied to the click
      const accessToken = await requestToken();
      let docId = wanted;
      if (!docId) {
        docId = await createDoc(accessToken);
      } else {
        // Already reachable (e.g. created by this app)? Otherwise ask him to pick it.
        try {
          await api(`https://docs.googleapis.com/v1/documents/${docId}?fields=documentId`, accessToken);
        } catch (e) {
          if (e.status === 400) { setState("notdoc"); return; }
          if (e.status !== 403 && e.status !== 404) throw e;
          docId = await pick(docId, accessToken);
          if (!docId) { setState("idle"); return; }
        }
      }
      setData({ linked: true, docId, firstSync: true, pending: [] });
      await sync();
    } catch {
      setState(data().linked ? "paused" : "error");
    }
  }

  // Get a fresh token (from a click), then sync.
  async function resume() {
    try {
      if (!client) await prepare();
      await requestToken();
      await sync();
    } catch {
      setState("paused");
    }
  }

  function disconnect() {
    const t = token();
    try { if (t) google.accounts.oauth2.revoke(t, () => {}); } catch {}
    cfg.store.remove("drive-token");
    cfg.store.set("drive", {});
    clearTimeout(timer);
    setState("idle");
  }

  function init(options) {
    cfg = options;
    if (!cfg.clientId) return;
    if (data().linked) {
      prepare().catch(() => {});
      sync();
    }
    // Load Google's scripts only once he opens settings, never before he asks for it.
    document.getElementById("open-settings")?.addEventListener("click", () => prepare().catch(() => {}), { once: true });
  }

  function status() {
    const d = cfg ? data() : {};
    const paused = d.linked && (state === "paused" || (state === "idle" && !token()));
    return {
      available: !!cfg?.clientId,
      canLink: !!(cfg?.clientId && cfg.apiKey && cfg.appId),
      linked: !!d.linked,
      docId: d.docId || null,
      lastSync: d.lastSync || null,
      state: paused ? "paused" : state,
    };
  }

  return { init, schedule, connect, resume, disconnect, status, docIdFromLink, parseDoc, dayRequests, daysFrom };
})();
