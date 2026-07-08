import { useState, useEffect, useMemo, useRef } from "react";

/* ---------- storage adapter ----------
   Inside Claude, window.storage exists. On your own hosting (Netlify etc.)
   it doesn't, so we fall back to the browser's localStorage. Same app,
   works in both places. */
const store =
  typeof window !== "undefined" && window.storage
    ? window.storage
    : {
        async get(k) {
          const v = localStorage.getItem(k);
          return v == null ? null : { key: k, value: v };
        },
        async set(k, v) {
          localStorage.setItem(k, v);
          return { key: k, value: v };
        },
      };

/* ---------- backend ----------
   The Worker URL is baked in here, so a new device just opens the app
   and logs in — no sheet URL or script URL to paste, ever. Replace the
   placeholder below with your deployed Worker URL (no trailing slash). */
const WORKER_URL = "https://REPLACE-WITH-YOUR-WORKER.workers.dev";

/* ---------- storage ---------- */
const STORE_KEY = "taskmanager:tasks-v1"; // same key: existing tasks carry over
const PREFS_KEY = "taskmanager:prefs-v1";
const LISTS_KEY = "taskmanager:lists-v1";
const AUTH_KEY = "taskmanager:auth-v1"; // { token, name, role }

/* ---------- date helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
const toStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toStr(new Date());
const addDays = (s, n) => { const d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return toStr(d); };
const addMonths = (s, n) => {
  const d = new Date(s + "T00:00:00");
  const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toStr(d);
};
const advance = (s, r) => {
  if (r && r.startsWith("custom:")) {
    const parts = r.split(":");
    const n = Math.max(1, parseInt(parts[1], 10) || 1);
    const unit = parts[2] || "days";
    return unit === "weeks" ? addDays(s, 7 * n) : unit === "months" ? addMonths(s, n) : addDays(s, n);
  }
  return r === "daily" ? addDays(s, 1) : r === "weekly" ? addDays(s, 7)
    : r === "monthly" ? addMonths(s, 1) : r === "quarterly" ? addMonths(s, 3)
    : r === "yearly" ? addMonths(s, 12) : s;
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const nextWeekday = (from, wd) => {
  const d = new Date(from + "T00:00:00");
  let diff = (wd - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(from, diff);
};
const parseQuickAdd = (raw, today, ignored) => {
  let title = " " + raw + " ";
  const out = { dueDate: "", dueTime: "", recurrence: "", bucket: "", matches: [] };
  const skip = ignored || {};
  const eat = (re, key, label, apply) => {
    const m = title.match(re);
    if (!m) return;
    if (skip[key]) return; // leave text intact when user dismissed this chip
    apply(m);
    out.matches.push({ key, label: label(m) });
    title = title.replace(re, " ");
  };
  const wdIdx = (w) => WEEKDAYS.findIndex((x) => x.startsWith(w.toLowerCase()));
  eat(/\bevery\s+(\d+)\s+(day|week|month)s?\b/i, "rec", (m) => `↻ every ${m[1]} ${m[2]}s`, (m) => { out.recurrence = `custom:${m[1]}:${m[2]}s`; });
  eat(/\bevery\s+(sun|mon|tues|tue|wednes|wed|thurs|thu|fri|satur|sat)(?:day|sday|nesday|urday)?\b/i, "rec", (m) => `↻ weekly`, (m) => { out.recurrence = "weekly"; const i = wdIdx(m[1]); if (i >= 0) out.dueDate = nextWeekday(today, i); });
  eat(/\b(daily|every\s?day)\b/i, "rec", () => "↻ Daily", () => { out.recurrence = "daily"; });
  eat(/\b(weekly|every\s?week)\b/i, "rec", () => "↻ Weekly", () => { out.recurrence = "weekly"; });
  eat(/\b(monthly|every\s?month)\b/i, "rec", () => "↻ Monthly", () => { out.recurrence = "monthly"; });
  eat(/\b(quarterly)\b/i, "rec", () => "↻ Quarterly", () => { out.recurrence = "quarterly"; });
  eat(/\b(yearly|annually|every\s?year)\b/i, "rec", () => "↻ Yearly", () => { out.recurrence = "yearly"; });
  eat(/\btoday\b/i, "date", () => "Today", () => { out.dueDate = today; });
  eat(/\b(tomorrow|tmrw|tmr)\b/i, "date", () => "Tomorrow", () => { out.dueDate = addDays(today, 1); });
  eat(/\bnext\s?week\b/i, "date", () => "Next week", () => { out.bucket = "Next week"; });
  eat(/\bsomeday\b/i, "date", () => "Someday", () => { out.bucket = "Someday"; });
  eat(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i, "date", (m) => m[1][0].toUpperCase() + m[1].slice(1), (m) => { out.dueDate = nextWeekday(today, wdIdx(m[1])); });
  eat(/\b(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i, "time", (m) => `${m[1]}${m[2] ? ":" + m[2] : ""} ${m[3].toUpperCase()}`, (m) => { let h = (+m[1]) % 12; if (/pm/i.test(m[3])) h += 12; out.dueTime = `${pad(h)}:${m[2] || "00"}`; });
  eat(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, "time", (m) => m[0], (m) => { out.dueTime = `${pad(+m[1])}:${m[2]}`; });
  if (out.dueTime && !out.dueDate && !out.bucket) { out.dueDate = today; out.matches.push({ key: "date", label: "Today" }); }
  out.title = title.replace(/\s+/g, " ").trim();
  return out;
};

const fmtDate = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
const fmtShort = (s) => s ? new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
const dayLabel = (s) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
const fmtTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- CSV ---------- */
const HEADERS = ["Task","Category","Sub Category","Due Date","Due Time","Reminder Date","Reminder Time","Recurrence","Bucket","Status","Created","Completed","Notes"];
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (ts) => [HEADERS.join(","), ...ts.map((t) =>
  [t.title, t.category, t.subCategory, t.dueDate, t.dueTime, t.reminderDate, t.reminderTime, t.recurrence, t.bucket, t.done ? "Done" : "Open", t.createdAt, t.completedAt, t.notes].map(esc).join(",")
)].join("\n");
const parseCSV = (text) => {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i+1] === "\n") i++;
      row.push(f); f = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else f += c;
  }
  row.push(f);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
};

/* ---------- themes ---------- */
const THEMES = {
  light: {
    bg: "#F7F6F1", card: "#FFFFFF", ink: "#20241F", mute: "#7C8078", line: "#DDDCD2",
    accent: "#136A55", accentSoft: "#E3EEE9", danger: "#BC4325", dangerSoft: "#F7E6DF",
    amber: "#B07C1F", amberSoft: "#F5ECD8",
    tagBg: "#EFEEE7", overlay: "rgba(32,36,31,0.45)", shadow: "0 1px 3px rgba(32,36,31,0.07)",
    footBg: "rgba(247,246,241,0.95)", rowAlt: "#FBFAF6",
  },
  dark: {
    bg: "#131613", card: "#1D221D", ink: "#ECEBE3", mute: "#9DA399", line: "#333B33",
    accent: "#3FAE8C", accentSoft: "#1E332C", danger: "#E06A4A", dangerSoft: "#3A251F",
    amber: "#D9A644", amberSoft: "#332B18",
    tagBg: "#2A2F2A", overlay: "rgba(0,0,0,0.6)", shadow: "0 1px 3px rgba(0,0,0,0.4)",
    footBg: "rgba(21,24,21,0.95)", rowAlt: "#1A1E1A",
  },
};

const BUCKETS = ["Inbox", "Next week", "Someday"];

/* ---------- smart list types ----------
   Every list has sections; types add extra per-item fields. */
const LIST_TYPES = {
  checklist: { label: "Checklist", icon: "☑", extras: [] },
  grocery: { label: "Grocery", icon: "🛒", extras: ["qty", "unit"] },
  packing: { label: "Packing", icon: "🎒", extras: ["qty"] },
  wishlist: { label: "Wishlist", icon: "⭐", extras: ["url", "price"] },
  custom: { label: "Custom", icon: "⚙", extras: null },
};
const CUSTOM_CHOICES = ["qty", "unit", "url", "price"];
const listExtras = (l) => {
  if (!l) return [];
  if (l.type === "custom") return l.fields || [];
  return (LIST_TYPES[l.type] || LIST_TYPES.checklist).extras;
};
const inferType = (l) => (l.items || []).some((i) => i.qty || i.unit) ? "grocery" : "checklist";

/* ---------- automatic category colors ----------
   Each category/sub name is hashed to a hue, so the same name always
   gets the same color — no setup needed. Settings can override (cycle)
   a name's color; overrides are stored in prefs. */
const HUES = [14, 32, 48, 90, 145, 168, 190, 210, 235, 265, 300, 330];
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const hueFor = (name, overrides) =>
  overrides && overrides[name] !== undefined
    ? HUES[overrides[name] % HUES.length]
    : HUES[hashStr(String(name).toLowerCase()) % HUES.length];
const catStyle = (name, dark, overrides) => {
  const h = hueFor(name, overrides);
  return dark
    ? { background: `hsl(${h},32%,22%)`, color: `hsl(${h},60%,72%)` }
    : { background: `hsl(${h},52%,91%)`, color: `hsl(${h},65%,29%)` };
};
const dotColor = (name, dark, overrides) => `hsl(${hueFor(name, overrides)},${dark ? 50 : 60}%,${dark ? 62 : 42}%)`;
const RECURRENCES = [["", "No repeat"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["quarterly", "Quarterly"], ["yearly", "Yearly"], ["custom", "Custom…"]];
const REC_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const recLabel = (r) => {
  if (!r) return "";
  if (r.startsWith("custom:")) {
    const parts = r.split(":");
    const n = Math.max(1, parseInt(parts[1], 10) || 1);
    const unit = parts[2] || "days";
    return `Every ${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
  }
  return REC_LABEL[r] || r;
};
const NAV = ["Tasks", "Lists", "Dashboard", "Settings"];
const FOCUS_KEYS = ["Overdue", "Today", "Tomorrow", "Inbox"];
const GROUP_CAP = 6;
const NAV_ICON = { Tasks: "☑", Lists: "☰", Dashboard: "▤", Settings: "⚙" };

export default function TaskManager() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(false);
  const [view, setView] = useState("Tasks");
  const [taskMode, setTaskMode] = useState("List");
  const [focus, setFocus] = useState(true);
  const [collapsed, setCollapsed] = useState({});
  const [compact, setCompact] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [lists, setLists] = useState([]);
  const [activeListId, setActiveListId] = useState(null);
  const [newListName, setNewListName] = useState("");
  const [newListType, setNewListType] = useState("checklist");
  const [newListFields, setNewListFields] = useState([]);
  const [newListCat, setNewListCat] = useState("");
  const [listCats, setListCats] = useState(["Work", "Personal", "House"]);
  const [catCollapsed, setCatCollapsed] = useState({});
  const [newCatInput, setNewCatInput] = useState("");
  const [newItemUrl, setNewItemUrl] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("");
  const [newItemText, setNewItemText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [newItemSection, setNewItemSection] = useState("");
  const [newItemQty, setNewItemQty] = useState("");
  const [newItemUnit, setNewItemUnit] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const autoTimer = useRef(null);
  const pulledOnce = useRef(false); // guard: don't push before we've pulled this session
  const [selectedIds, setSelectedIds] = useState({});
  const [openNotes, setOpenNotes] = useState({});
  const blank = { category: "", subCategory: "", dueDate: "", dueTime: "", reminderDate: "", reminderTime: "", recurrence: "", bucket: "Inbox", notes: "" };
  const [newTitle, setNewTitle] = useState("");
  const [ignoredParses, setIgnoredParses] = useState({});
  const [draft, setDraft] = useState(blank);
  const [addFocus, setAddFocus] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [moreFields, setMoreFields] = useState(false);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("All");
  const [filterSub, setFilterSub] = useState("All");
  const [filterStatus, setFilterStatus] = useState("Open");
  const [showFilters, setShowFilters] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [sortKey, setSortKey] = useState("dueDate");
  const [sortDir, setSortDir] = useState(1);
  const [editing, setEditing] = useState(null);
  const [modal, setModal] = useState(null);
  const [importText, setImportText] = useState("");
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");
  const [scriptUrl, setScriptUrl] = useState(""); // legacy; unused once Worker is live
  const [lastSync, setLastSync] = useState("");
  const [syncing, setSyncing] = useState(false);
  /* auth */
  const [session, setSession] = useState(null);   // { token, name, role }
  const [workerUrl, setWorkerUrl] = useState(WORKER_URL); // persisted override survives redeploys
  const [urlDraft, setUrlDraft] = useState("");
  const [hideChecked, setHideChecked] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [roster, setRoster] = useState([]);        // [{ name, role }] for login screen
  const [members, setMembers] = useState([]);      // all usernames, for sharing lists
  const [loginName, setLoginName] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [shareFor, setShareFor] = useState(null);  // list id being shared
  const [catColors, setCatColors] = useState({});
  const [pickerFor, setPickerFor] = useState(null);
  const csvRef = useRef(null);
  const itemInputRef = useRef(null);
  const T = dark ? THEMES.dark : THEMES.light;
  const today = todayStr();

  /* load — with a timeout guard so a slow/unresponsive storage
     bridge can never leave the app stuck on the loading screen */
  useEffect(() => {
    let cancelled = false;
    const withTimeout = (p, ms) =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("storage timeout")), ms))]);
    (async () => {
      try {
        const r = await withTimeout(store.get(STORE_KEY), 2500);
        if (!cancelled && r?.value) setTasks(JSON.parse(r.value).map((t) => ({ recurrence: "", bucket: "Inbox", completedAt: "", nextId: "", notes: "", ...t })));
      } catch (e) { /* fresh start */ }
      try {
        const p = await withTimeout(store.get(PREFS_KEY), 2500);
        if (!cancelled && p?.value) {
          const prefs = JSON.parse(p.value);
          setDark(prefs.dark === true);
          if (NAV.includes(prefs.view)) setView(prefs.view);
          else if (prefs.view === "List" || prefs.view === "Table") { setView("Tasks"); setTaskMode(prefs.view); }
          if (prefs.taskMode === "List" || prefs.taskMode === "Table") setTaskMode(prefs.taskMode);
          if (prefs.focus === false) setFocus(false);
          if (prefs.collapsed && typeof prefs.collapsed === "object") setCollapsed(prefs.collapsed);
          if (prefs.compact === true) setCompact(true);
          if (prefs.scriptUrl) setScriptUrl(prefs.scriptUrl);
          if (prefs.catColors) setCatColors(prefs.catColors);
          if (Array.isArray(prefs.listCats)) setListCats(prefs.listCats);
          if (prefs.workerUrl) setWorkerUrl(prefs.workerUrl);
          if (prefs.hideChecked === true) setHideChecked(true);
          if (prefs.autoSync === true) setAutoSync(true);
          if (prefs.lastSync) setLastSync(prefs.lastSync);
        }
      } catch (e) { /* defaults */ }
      try {
        const l = await withTimeout(store.get(LISTS_KEY), 2500);
        if (!cancelled && l?.value) setLists(JSON.parse(l.value).map((x) => ({ ...x, type: x.type || inferType(x), fields: x.fields || [] })));
      } catch (e) { /* no lists yet */ }
      try {
        const a = await withTimeout(store.get(AUTH_KEY), 2500);
        if (!cancelled && a?.value) {
          const s = JSON.parse(a.value);
          if (s && s.token && s.name) setSession(s);
        }
      } catch (e) { /* not logged in */ }
      if (!cancelled) { setLoading(false); setAuthReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  /* fetch the login roster whenever we're logged out */
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(workerUrl + "/users");
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) setRoster(data);
      } catch (e) { /* offline — user can retry */ }
    })();
    return () => { cancelled = true; };
  }, [session, workerUrl]);

  /* on login, pull the latest from the Worker so this device is current */
  useEffect(() => {
    if (session && authReady) { workerPull(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, authReady]);

  const doLogin = async () => {
    if (!loginName) { setLoginErr("Pick your name"); return; }
    if (!loginPin.trim()) { setLoginErr("Enter your PIN"); return; }
    setLoggingIn(true); setLoginErr("");
    try {
      const res = await fetch(workerUrl + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: loginName, pin: loginPin.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) { setLoginErr(data.error || "Login failed"); return; }
      const s = { token: data.token, name: data.name, role: data.role };
      setSession(s);
      try { await store.set(AUTH_KEY, JSON.stringify(s)); } catch (e) {}
      setLoginPin("");
    } catch (e) {
      setLoginErr("Can't reach the server — check your connection");
    } finally { setLoggingIn(false); }
  };

  const logout = async () => {
    if (!window.confirm("Log out on this device?")) return;
    setSession(null); setLoginName(""); setLoginPin("");
    try { await store.set(AUTH_KEY, ""); } catch (e) {}
  };

  const persist = async (next) => {
    setTasks(next); setDirty(true);
    try { await store.set(STORE_KEY, JSON.stringify(next)); } catch (e) { console.error(e); }
  };
  const savePrefs = async (patch) => {
    const p = { dark, view, taskMode, focus, collapsed, compact, scriptUrl, lastSync, catColors, autoSync, ...patch };
    try { await store.set(PREFS_KEY, JSON.stringify(p)); } catch (e) { console.error(e); }
  };
  const setTheme = (v) => { setDark(v); savePrefs({ dark: v }); };
  const switchView = (v) => { setView(v); savePrefs({ view: v }); };
  const switchTaskMode = (m) => { setTaskMode(m); savePrefs({ taskMode: m }); };
  const switchFocus = (f) => { setFocus(f); savePrefs({ focus: f }); };
  const toggleCollapse = (key) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next); savePrefs({ collapsed: next });
  };
  // Jumps from a Dashboard stat/bar to the Tasks view, pre-filtered and
  // scrolled to the relevant group. groupKeys (if given) are expanded and
  // taken out of Focus mode if Focus would otherwise hide them.
  const goToTasksGroup = ({ cat = "All", sub = "All", status = "Open", groupKeys } = {}) => {
    setFilterCat(cat); setFilterSub(sub); setFilterStatus(status);
    switchTaskMode("List");
    if (groupKeys && groupKeys.some((k) => !FOCUS_KEYS.includes(k))) switchFocus(false);
    if (groupKeys && groupKeys.length) {
      const next = { ...collapsed };
      groupKeys.forEach((k) => { next[k] = false; });
      setCollapsed(next); savePrefs({ collapsed: next });
    }
    switchView("Tasks");
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = groupKeys && groupKeys.map((k) => document.getElementById("grp-" + k)).find(Boolean);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      }, 80);
    });
  };
  const persistLists = async (next) => {
    setLists(next); setDirty(true);
    try { await store.set(LISTS_KEY, JSON.stringify(next)); } catch (e) { console.error(e); }
  };
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2200); };
  const flashUndo = (m, fn) => { const t = { msg: m, fn }; setToast(t); setTimeout(() => setToast((cur) => (cur === t ? "" : cur)), 5000); };

  /* derived */
  const categories = useMemo(() => ["All", ...Array.from(new Set(tasks.map((t) => t.category).filter(Boolean))).sort()], [tasks]);
  const subCats = useMemo(() => {
    const pool = filterCat === "All" ? tasks : tasks.filter((t) => t.category === filterCat);
    return ["All", ...Array.from(new Set(pool.map((t) => t.subCategory).filter(Boolean))).sort()];
  }, [tasks, filterCat]);
  const subSuggestions = useMemo(() => Array.from(new Set(tasks.map((t) => t.subCategory).filter(Boolean))), [tasks]);

  /* Collision-free colors: manual picks win, then every remaining name gets
     its hashed hue — but if that hue is taken, it probes to the next free one,
     so distinct names get distinct colors (until there are more than 12). */
  const colorMap = useMemo(() => {
    const names = Array.from(new Set([
      ...tasks.map((t) => t.category),
      ...tasks.map((t) => t.subCategory),
      ...lists.map((l) => l.name),
    ].filter(Boolean))).sort();
    const map = {}, taken = new Set();
    names.forEach((n) => {
      if (catColors[n] !== undefined) { map[n] = catColors[n] % HUES.length; taken.add(map[n]); }
    });
    names.forEach((n) => {
      if (map[n] !== undefined) return;
      let idx = hashStr(n.toLowerCase()) % HUES.length, tries = 0;
      while (taken.has(idx) && tries < HUES.length) { idx = (idx + 1) % HUES.length; tries++; }
      map[n] = idx; taken.add(idx);
    });
    return map;
  }, [tasks, lists, catColors]);

  const q = search.trim().toLowerCase();
  const visible = tasks.filter((t) =>
    (filterCat === "All" || (filterCat === "Uncategorized" ? !t.category : t.category === filterCat)) &&
    (filterSub === "All" || t.subCategory === filterSub) &&
    (!q || [t.title, t.category, t.subCategory].some((x) => (x || "").toLowerCase().includes(q)))
  );
  const open = visible.filter((t) => !t.done);
  const doneList = visible.filter((t) => t.done);

  const tomorrow = addDays(today, 1), weekEnd = addDays(today, 7);
  const dated = open.filter((t) => t.dueDate);
  const undated = open.filter((t) => !t.dueDate);

  const groups = filterStatus === "Done" ? [] : [
    { key: "Overdue", danger: true, items: dated.filter((t) => t.dueDate < today) },
    { key: "Today", accent: true, items: dated.filter((t) => t.dueDate === today) },
    { key: "Tomorrow", items: dated.filter((t) => t.dueDate === tomorrow) },
    { key: "This week", items: dated.filter((t) => t.dueDate > tomorrow && t.dueDate <= weekEnd) },
    { key: "Later", items: dated.filter((t) => t.dueDate > weekEnd) },
    { key: "Next week", bucket: true, items: undated.filter((t) => t.bucket === "Next week") },
    { key: "Someday", bucket: true, items: undated.filter((t) => t.bucket === "Someday") },
    { key: "Inbox", bucket: true, items: undated.filter((t) => !t.bucket || t.bucket === "Inbox") },
  ].filter((g) => g.items.length > 0);
  groups.forEach((g) => g.items.sort((a, b) =>
    (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || (a.dueTime || "99").localeCompare(b.dueTime || "99")
  ));

  /* table sorting */
  const tableRows = useMemo(() => {
    const pool = filterStatus === "Open" ? open : filterStatus === "Done" ? doneList : visible;
    const val = (t) => {
      switch (sortKey) {
        case "title": return t.title.toLowerCase();
        case "category": return (t.category || "").toLowerCase();
        case "subCategory": return (t.subCategory || "").toLowerCase();
        case "recurrence": return t.recurrence || "";
        case "status": return t.done ? 1 : 0;
        default: return (t.dueDate || "9999") + (t.dueTime || "99");
      }
    };
    return [...pool].sort((a, b) => {
      const A = val(a), B = val(b);
      return (A < B ? -1 : A > B ? 1 : 0) * sortDir;
    });
  }, [visible, sortKey, sortDir, filterStatus]);

  const sortBy = (k) => {
    if (sortKey === k) setSortDir(-sortDir);
    else { setSortKey(k); setSortDir(1); }
  };

  /* dashboard stats (computed over ALL tasks, ignoring filters) */
  const stats = useMemo(() => {
    const allOpen = tasks.filter((t) => !t.done);
    const overdue = allOpen.filter((t) => t.dueDate && t.dueDate < today).length;
    const dueToday = allOpen.filter((t) => t.dueDate === today).length;
    const week = allOpen.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd).length;
    const doneWeek = tasks.filter((t) => t.done && t.completedAt && t.completedAt >= addDays(today, -6)).length;
    // by category (open)
    const byCat = {};
    allOpen.forEach((t) => { const c = t.category || "Uncategorized"; byCat[c] = (byCat[c] || 0) + 1; });
    const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 8);
    // next 7 days load
    const next7 = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(today, i);
      return { date: d, count: allOpen.filter((t) => t.dueDate === d).length };
    });
    // completed last 7 days
    const last7 = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(today, i - 6);
      return { date: d, count: tasks.filter((t) => t.done && t.completedAt === d).length };
    });
    const buckets = {
      "Next week": allOpen.filter((t) => !t.dueDate && t.bucket === "Next week").length,
      "Someday": allOpen.filter((t) => !t.dueDate && t.bucket === "Someday").length,
      "Inbox": allOpen.filter((t) => !t.dueDate && (!t.bucket || t.bucket === "Inbox")).length,
    };
    return { open: allOpen.length, overdue, dueToday, week, doneWeek, catRows, next7, last7, buckets };
  }, [tasks, today, weekEnd]);

  /* actions */
  const parsed = useMemo(() => parseQuickAdd(newTitle, today, ignoredParses), [newTitle, today, ignoredParses]);
  const addTask = () => {
    if (!newTitle.trim()) { flash("Type the task first"); return; }
    const title = parsed.title || newTitle.trim();
    const dueDate = draft.dueDate || parsed.dueDate;
    const t = {
      id: uid(), title, done: false, createdAt: today, completedAt: "", nextId: "", notes: draft.notes || "",
      category: draft.category, subCategory: draft.subCategory,
      dueDate, dueTime: draft.dueTime || parsed.dueTime,
      reminderDate: draft.reminderDate, reminderTime: draft.reminderTime,
      recurrence: draft.recurrence || parsed.recurrence,
      bucket: parsed.bucket || draft.bucket,
    };
    persist([t, ...tasks]);
    setNewTitle(""); setDraft(blank); setMoreFields(false); setIgnoredParses({}); setAddFocus(false); setAddOpen(false);
    const hiddenByFocus = focus && taskMode === "List" &&
      ((t.dueDate && t.dueDate > tomorrow) || (!t.dueDate && (t.bucket === "Next week" || t.bucket === "Someday")));
    flash(hiddenByFocus ? "Added — scheduled for later (switch to All to see it)" : "Task added");
  };
  const toggle = (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;

    if (!t.done) {
      /* completing */
      let next = tasks.map((x) => (x.id === id ? { ...x, done: true, completedAt: today } : x));
      if (t.recurrence) {
        const nextDue = advance(t.dueDate || today, t.recurrence);
        const nextRem = t.reminderDate ? advance(t.reminderDate, t.recurrence) : "";
        // guard against double-spawning (e.g. rapid double taps)
        const already = next.some((x) => !x.done && x.title === t.title && x.recurrence === t.recurrence && x.dueDate === nextDue);
        if (!already) {
          const newId = uid();
          next = [
            { ...t, id: newId, done: false, completedAt: "", dueDate: nextDue, reminderDate: nextRem, createdAt: today, nextId: "" },
            ...next.map((x) => (x.id === id ? { ...x, nextId: newId } : x)),
          ];
          flash("");
          var recMsg = `Done · repeats ${recLabel(t.recurrence).toLowerCase()} — next: ${fmtDate(nextDue)}`;
        }
      }
      const prevTasks = tasks;
      persist(next);
      flashUndo(typeof recMsg === "string" ? recMsg : "Completed", () => persist(prevTasks));
    } else {
      /* un-completing: also remove the occurrence this completion spawned,
         so undo is a true undo with no duplicates left behind */
      let next = tasks;
      let removed = false;
      if (t.recurrence && t.nextId) {
        const spawned = tasks.find((x) => x.id === t.nextId);
        if (spawned && !spawned.done) {
          next = next.filter((x) => x.id !== t.nextId);
          removed = true;
        }
      }
      next = next.map((x) => (x.id === id ? { ...x, done: false, completedAt: "", nextId: "" } : x));
      persist(next);
      if (removed) flash("Completion undone — next occurrence removed");
    }
  };

  const snooze = (id) => {
    persist(tasks.map((t) => (t.id === id ? { ...t, dueDate: tomorrow } : t)));
    flash("Moved to tomorrow");
  };
  const remove = (id) => {
    const prev = tasks;
    persist(tasks.filter((t) => t.id !== id));
    flashUndo("Task deleted", () => persist(prev));
  };
  const saveEdit = () => { persist(tasks.map((t) => (t.id === editing.id ? editing : t))); setEditing(null); };
  const clearDone = () => persist(tasks.filter((t) => !t.done));

  const doImport = () => {
    const rows = parseCSV(importText.trim());
    if (rows.length < 2) return;
    const h = rows[0].map((x) => x.trim().toLowerCase());
    const i = (n) => h.indexOf(n);
    const imported = rows.slice(1).map((r) => ({
      id: uid(),
      title: r[i("task")] || "(untitled)",
      category: r[i("category")] || "",
      subCategory: r[i("sub category")] || "",
      dueDate: r[i("due date")] || "",
      dueTime: r[i("due time")] || "",
      reminderDate: r[i("reminder date")] || "",
      reminderTime: r[i("reminder time")] || "",
      recurrence: (r[i("recurrence")] || "").toLowerCase(),
      bucket: r[i("bucket")] || "Inbox",
      done: (r[i("status")] || "").toLowerCase() === "done",
      createdAt: r[i("created")] || today,
      completedAt: r[i("completed")] || "",
      notes: r[i("notes")] || "",
    }));
    persist([...imported, ...tasks]);
    setImportText(""); setModal(null);
    flash(`Imported ${imported.length} task${imported.length === 1 ? "" : "s"}`);
  };

  /* ---------- Google Sheets sync (via Cloudflare Worker) ----------
     The app only knows WORKER_URL; the Worker holds the sheet
     credentials and enforces who sees what. Tasks are private to you;
     lists you own or that are shared with you come back on every sync. */
  const authed = (extra) => ({
    "Content-Type": "application/json",
    Authorization: "Bearer " + (session ? session.token : ""),
    ...(extra || {}),
  });
  const handleAuthFail = () => {
    // token expired or user removed — drop to the login screen
    setSession(null);
    try { store.set(AUTH_KEY, ""); } catch (e) {}
    flash("Session ended — please log in again");
  };

  // normalize a task coming from the Worker into the app's shape
  const normTask = (t) => ({
    id: t.id || uid(), title: t.title || "(untitled)",
    category: t.category || "", subCategory: t.subCategory || "",
    dueDate: t.dueDate || "", dueTime: t.dueTime || "",
    reminderDate: t.reminderDate || "", reminderTime: t.reminderTime || "",
    recurrence: (t.recurrence || "").toLowerCase(), bucket: t.bucket || "Inbox",
    done: t.done === true || String(t.status).toLowerCase() === "done",
    createdAt: t.createdAt || today, completedAt: t.completedAt || "",
    notes: t.notes || "", nextId: t.nextId || "",
  });
  const normList = (L) => {
    let type = L.type || "", fields = Array.isArray(L.fields) ? L.fields : [];
    if (typeof type === "string" && type.startsWith("custom:")) {
      const rest = type.split(":")[1] || "";
      if (rest) fields = rest.split("|").filter(Boolean);
      type = "custom";
    }
    if (!LIST_TYPES[type]) type = inferType(L);
    return {
      ...L, type, fields,
      owner: L.owner || (session ? session.name : ""),
      sharedWith: Array.isArray(L.sharedWith) ? L.sharedWith : [],
      items: (L.items || []).map((i) => ({ section: "", qty: "", unit: "", url: "", price: "", ...i })),
    };
  };

  const adopt = (data) => {
    if (Array.isArray(data.tasks)) { setTasks(data.tasks.map(normTask)); store.set(STORE_KEY, JSON.stringify(data.tasks.map(normTask))).catch(() => {}); }
    if (Array.isArray(data.lists)) { const nl = data.lists.map(normList); setLists(nl); store.set(LISTS_KEY, JSON.stringify(nl)).catch(() => {}); }
    if (Array.isArray(data.members)) setMembers(data.members);
    if (data.settings && Array.isArray(data.settings.listCats)) {
      setListCats(data.settings.listCats);
      savePrefs({ listCats: data.settings.listCats });
    }
    const now = new Date().toLocaleString();
    setLastSync(now); savePrefs({ lastSync: now });
    setDirty(false);
  };

  const workerPull = async (silent) => {
    if (!session) return;
    if (!silent) setSyncing(true);
    try {
      const res = await fetch(workerUrl + "/sync", { headers: authed() });
      if (res.status === 401) { handleAuthFail(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");
      adopt(data);
      pulledOnce.current = true; // safe to push now — we've seen the server
      if (!silent) flash(`Up to date — ${data.tasks.length} tasks`);
    } catch (e) {
      if (!silent) flash("Couldn't reach the server");
      console.error(e);
    } finally { if (!silent) setSyncing(false); }
  };

  const syncPush = async () => {
    if (!session) return;
    // Never overwrite the server with local state until we've read it once
    // this session — this is what prevents an empty device from wiping
    // everyone's lists.
    if (!pulledOnce.current) { await workerPull(true); if (!pulledOnce.current) { flash("Can't reach the server — check the Server URL in Settings"); return; } }
    setSyncing(true);
    try {
      const res = await fetch(workerUrl + "/sync", {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ tasks, lists, settings: { listCats } }),
      });
      if (res.status === 401) { handleAuthFail(); return; }
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Sync failed");
      adopt(data); // reconcile with the server's view (picks up shared-list edits)
      flash(`Synced ${data.tasks.length} tasks`);
    } catch (e) {
      flash("Sync failed — check your connection");
      console.error(e);
    } finally { setSyncing(false); }
  };

  // manual "pull" button — with a confirm, since it overwrites local
  const syncPull = async () => {
    if (!window.confirm("Replace what's on this device with the latest from the server?")) return;
    await workerPull(false);
    setModal(null);
  };

  /* ---------- category & sub category management ---------- */
  const setColor = (name, idx) => {
    const next = { ...catColors, [name]: idx };
    setCatColors(next); savePrefs({ catColors: next });
    setPickerFor(null);
  };
  const renameField = (field, oldName) => {
    const nn = window.prompt(`Rename "${oldName}" to:`, oldName);
    if (!nn || !nn.trim() || nn.trim() === oldName) return;
    const name = nn.trim();
    persist(tasks.map((t) => (t[field] === oldName ? { ...t, [field]: name } : t)));
    if (catColors[oldName] !== undefined) {
      const nc = { ...catColors, [name]: catColors[oldName] };
      delete nc[oldName];
      setCatColors(nc); savePrefs({ catColors: nc });
    }
    if (field === "category" && filterCat === oldName) setFilterCat(name);
    if (field === "subCategory" && filterSub === oldName) setFilterSub(name);
    flash(`Renamed to "${name}" everywhere`);
  };
  const deleteField = (field, name) => {
    const n = tasks.filter((t) => t[field] === name).length;
    if (!window.confirm(`Remove "${name}" from ${n} task${n === 1 ? "" : "s"}? The tasks themselves are kept.`)) return;
    persist(tasks.map((t) => (t[field] === name ? { ...t, [field]: "" } : t)));
    if (field === "category" && filterCat === name) setFilterCat("All");
    if (field === "subCategory" && filterSub === name) setFilterSub("All");
  };
  const deleteAll = () => {
    if (!window.confirm("Delete ALL tasks? This cannot be undone.")) return;
    if (!window.confirm("Really sure? Consider Sync or CSV export first.")) return;
    persist([]);
  };

  /* clear the item inputs when switching lists, so a section name
     from one list doesn't leak into another */
  useEffect(() => { setNewItemText(""); setNewItemSection(""); setNewItemQty(""); setNewItemUnit(""); setNewItemUrl(""); setNewItemPrice(""); setSelectMode(false); setSelectedIds({}); setReorderMode(false); }, [activeListId]);

  /* auto-sync: quietly push a few seconds after the last change */
  useEffect(() => {
    if (loading || !autoSync || !dirty || !session || syncing) return;
    clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => { syncPush(); }, 8000);
    return () => clearTimeout(autoTimer.current);
  }, [tasks, lists, autoSync, dirty, loading, session]);

  /* ---------- lists ---------- */
  const activeList = lists.find((l) => l.id === activeListId) || null;
  const addList = () => {
    const name = newListName.trim();
    if (!name) return;
    const l = { id: uid(), name, items: [], createdAt: today, type: newListType, fields: newListType === "custom" ? newListFields : [], category: newListCat, owner: session ? session.name : "", sharedWith: [] };
    persistLists([l, ...lists]);
    setNewListName(""); setNewListType("checklist"); setNewListFields([]); setNewListCat("");
    setActiveListId(l.id);
  };
  const setListCategory = (id, category) => persistLists(lists.map((l) => (l.id === id ? { ...l, category } : l)));
  const addListCat = () => {
    const c = newCatInput.trim();
    if (!c || listCats.includes(c)) { setNewCatInput(""); return; }
    const next = [...listCats, c];
    setListCats(next); savePrefs({ listCats: next }); setNewCatInput(""); setDirty(true);
  };
  const removeListCat = (c) => {
    const next = listCats.filter((x) => x !== c);
    setListCats(next); savePrefs({ listCats: next }); setDirty(true);
    // lists keep their label; it simply moves to "Other" until re-assigned
  };
  const setListType = (id, type) => {
    persistLists(lists.map((l) => (l.id === id ? { ...l, type, fields: type === "custom" && !(l.fields || []).length ? listExtras(l) : l.fields || [] } : l)));
  };
  const toggleListField = (id, f) => {
    persistLists(lists.map((l) => {
      if (l.id !== id) return l;
      const fields = (l.fields || []).includes(f) ? (l.fields || []).filter((x) => x !== f) : [...(l.fields || []), f];
      return { ...l, fields };
    }));
  };
  const moveItem = (listId, itemId, dir) => {
    persistLists(lists.map((l) => {
      if (l.id !== listId) return l;
      const items = [...l.items];
      const idx = items.findIndex((i) => i.id === itemId);
      if (idx < 0) return l;
      const sec = items[idx].section || "";
      let j = idx + dir;
      while (j >= 0 && j < items.length && (items[j].section || "") !== sec) j += dir;
      if (j < 0 || j >= items.length) return l;
      const tmp = items[idx]; items[idx] = items[j]; items[j] = tmp;
      return { ...l, items };
    }));
  };
  const editItemUrl = (listId, itemId, cur) => {
    const s = window.prompt("Link (blank to clear):", cur || "https://");
    if (s === null) return;
    const url = s.trim() === "https://" ? "" : s.trim();
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, url } : i)) } : l)));
  };
  const editItemPrice = (listId, itemId, cur) => {
    const s = window.prompt("Price (any format, blank to clear):", cur || "");
    if (s === null) return;
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, price: s.trim() } : i)) } : l)));
  };
  const renameList = (id) => {
    const l = lists.find((x) => x.id === id);
    const nn = window.prompt("Rename list", l ? l.name : "");
    if (!nn || !nn.trim()) return;
    persistLists(lists.map((x) => (x.id === id ? { ...x, name: nn.trim() } : x)));
  };
  const deleteList = (id) => {
    const l = lists.find((x) => x.id === id);
    if (l && session && l.owner && l.owner !== session.name) { flash("Only the owner can delete this list"); return; }
    if (!window.confirm(`Delete list "${l ? l.name : ""}" and its items?`)) return;
    persistLists(lists.filter((x) => x.id !== id));
    if (activeListId === id) setActiveListId(null);
  };
  const iOwn = (l) => !session || !l.owner || l.owner === session.name;
  const toggleShare = (listId, name) => {
    persistLists(lists.map((l) => {
      if (l.id !== listId) return l;
      const cur = Array.isArray(l.sharedWith) ? l.sharedWith : [];
      const sharedWith = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      return { ...l, sharedWith };
    }));
  };
  const addItem = () => {
    const text = newItemText.trim();
    if (!activeList) return;
    if (!text) { flash("Type the item in the top field first"); return; }
    const section = newItemSection.trim();
    const qty = newItemQty.trim(), unit = newItemUnit.trim();
    const url = newItemUrl.trim(), price = newItemPrice.trim();
    persistLists(lists.map((l) => (l.id === activeList.id ? { ...l, items: [...l.items, { id: uid(), text, section, qty, unit, url, price, checked: false }] } : l)));
    setNewItemText(""); setNewItemQty(""); setNewItemUrl(""); setNewItemPrice(""); // section & unit stay filled for batch adding
    if (itemInputRef.current) itemInputRef.current.focus();
  };
  const addBulk = () => {
    if (!activeList) return;
    const section = newItemSection.trim();
    const unit = newItemUnit.trim();
    // one item per line; blank lines ignored; duplicate whitespace trimmed
    const lines = bulkText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { flash("Paste one item per line first"); return; }
    const newItems = lines.map((text) => ({ id: uid(), text, section, qty: "", unit, url: "", price: "", checked: false }));
    persistLists(lists.map((l) => (l.id === activeList.id ? { ...l, items: [...l.items, ...newItems] } : l)));
    setBulkText(""); setBulkOpen(false);
    flash(`Added ${newItems.length} item${newItems.length === 1 ? "" : "s"}${section ? ` to ${section}` : ""}`);
  };
  const editItemQty = (listId, itemId, cur) => {
    const s = window.prompt("Quantity (e.g. '2 kg', '3 packs' — blank to clear):", cur || "");
    if (s === null) return;
    const parts = s.trim().split(/\s+/);
    const qty = parts.shift() || "", unit = parts.join(" ");
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, qty, unit } : i)) } : l)));
  };
  const editItemSection = (listId, itemId, item) => {
    const nt = window.prompt("Edit item:", item.text);
    if (nt === null) return;
    const s = window.prompt("Section (blank for none):", item.section || "");
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, text: nt.trim() || i.text, section: s === null ? i.section : s.trim() } : i)) } : l)));
  };
  const sectionsOf = (list, keepOrder) => {
    const map = {}, order = [];
    list.items.forEach((it) => {
      const s = it.section || "";
      if (!(s in map)) { map[s] = []; order.push(s); }
      map[s].push(it);
    });
    order.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    if (!keepOrder) order.forEach((s) => map[s].sort((a, b) => (a.checked ? 1 : 0) - (b.checked ? 1 : 0)));
    return order.map((s) => [s, map[s]]);
  };
  const printList = (list) => {
    const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = `<html><head><title>${esc(list.name)}</title><style>
      body{font-family:Georgia,serif;padding:28px;color:#222;max-width:640px}
      h1{font-size:22px;margin:0 0 2px}.d{color:#777;font-size:12px;margin-bottom:16px}
      h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.08em;color:#555;margin:18px 0 6px;border-bottom:1px solid #ccc;padding-bottom:3px}
      ul{list-style:none;padding:0;margin:0}li{padding:4px 0;font-size:15px}
      .c{color:#999;text-decoration:line-through}
      .u{font-size:11px;color:#888;margin-left:22px;word-break:break-all}
    </style></head><body>
    <h1>${esc(list.name)}</h1><div class="d">${new Date().toLocaleDateString()}</div>
    ${sectionsOf(list, true).map(([s, items]) =>
      `${s ? `<h2>${esc(s)}</h2>` : ""}<ul>${items.map((i) => `<li class="${i.checked ? "c" : ""}">${i.checked ? "☑" : "☐"} ${esc(i.text)}${i.qty || i.unit ? " — " + esc([i.qty, i.unit].filter(Boolean).join(" ")) : ""}${i.price ? " — " + esc(i.price) : ""}${i.url ? `<div class="u">${esc(i.url)}</div>` : ""}</li>`).join("")}</ul>`
    ).join("")}
    </body></html>`;
    const f = document.createElement("iframe");
    Object.assign(f.style, { position: "fixed", right: 0, bottom: 0, width: 0, height: 0, border: 0 });
    document.body.appendChild(f);
    f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
    f.contentWindow.focus(); f.contentWindow.print();
    setTimeout(() => document.body.removeChild(f), 2000);
  };
  const toggleItem = (listId, itemId) =>
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, checked: !i.checked } : i)) } : l)));
  const deleteItem = (listId, itemId) => {
    const prev = lists;
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l)));
    flashUndo("Item removed", () => persistLists(prev));
  };
  const resetList = (listId) => {
    if (!window.confirm("Uncheck all items? (Great for reusing this list.)")) return;
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => ({ ...i, checked: false })) } : l)));
    flash("List reset — ready to reuse");
  };
  const toggleSelect = (itemId) => setSelectedIds((prev) => ({ ...prev, [itemId]: !prev[itemId] }));
  const selectedList = () => (activeList ? activeList.items.filter((i) => selectedIds[i.id]) : []);
  const selectAllItems = () => activeList && setSelectedIds(Object.fromEntries(activeList.items.map((i) => [i.id, true])));
  const selectNoItems = () => setSelectedIds({});
  const selectedAsText = () => {
    const sel = selectedList();
    const body = sel.map((i) => {
      const q = [i.qty, i.unit].filter(Boolean).join(" ");
      return "• " + i.text + (q ? ` (${q})` : "");
    }).join("\n");
    return activeList ? `${activeList.name}\n${body}` : body;
  };
  const copySelected = async () => {
    if (!selectedList().length) return;
    const text = selectedAsText();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); }
      flash(`Copied ${selectedList().length} item${selectedList().length === 1 ? "" : "s"}`);
    } catch (e) { flash("Couldn't copy"); }
  };
  const shareSelected = async () => {
    if (!selectedList().length) return;
    const text = selectedAsText();
    if (navigator.share) {
      try { await navigator.share({ title: activeList.name, text }); } catch (e) { /* user cancelled */ }
    } else { await copySelected(); flash("Sharing not available here — copied instead"); }
  };
  const createTaskFromSelected = () => {
    if (!activeList) return;
    const sel = activeList.items.filter((i) => selectedIds[i.id]);
    if (!sel.length) return;
    const defName = `${activeList.name} – ${sel.length} item${sel.length === 1 ? "" : "s"}`;
    const name = window.prompt("Name for this task:", defName);
    if (name === null) return;
    const bySec = {}, order = [];
    sel.forEach((i) => { const s = i.section || ""; if (!(s in bySec)) { bySec[s] = []; order.push(s); } bySec[s].push(i); });
    order.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
    const lines = [];
    order.forEach((s) => {
      if (s) lines.push(s + ":");
      bySec[s].forEach((i) => {
        lines.push(`• ${i.text}${i.qty || i.unit ? ` — ${[i.qty, i.unit].filter(Boolean).join(" ")}` : ""}${i.price ? ` — ${i.price}` : ""}`);
        if (i.url) lines.push(`   ${i.url}`);
      });
    });
    persist([{
      id: uid(), title: name.trim() || defName, notes: lines.join("\n"),
      category: activeList.name, subCategory: "", dueDate: "", dueTime: "",
      reminderDate: "", reminderTime: "", recurrence: "", bucket: "Inbox",
      done: false, createdAt: today, completedAt: "", nextId: "",
    }, ...tasks]);
    setSelectMode(false); setSelectedIds({});
    flash(`Task created with ${sel.length} items`);
  };
  const promoteItem = (list, item) => {
    const noteBits = [];
    if (item.price) noteBits.push(`Price: ${item.price}`);
    if (item.url) noteBits.push(item.url);
    persist([{
      id: uid(), title: item.qty || item.unit ? `${item.text} (${[item.qty, item.unit].filter(Boolean).join(" ")})` : item.text, done: false, createdAt: today, completedAt: "", nextId: "",
      notes: noteBits.join("\n"),
      category: list.name, subCategory: item.section || "", dueDate: "", dueTime: "",
      reminderDate: "", reminderTime: "", recurrence: "", bucket: "Inbox",
    }, ...tasks]);
    flash(`Added to Tasks · category "${list.name}"`);
  };

  const copyCSV = () => {
    if (csvRef.current) {
      csvRef.current.select();
      document.execCommand("copy");
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }
  };
  const downloadCSV = () => {
    const blob = new Blob([toCSV(tasks)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tasks-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /* ---------- styles ---------- */
  const S = {
    app: { minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: "'IBM Plex Sans', system-ui, sans-serif", paddingBottom: 96, transition: "background 0.25s, color 0.25s" },
    wrap: { maxWidth: 720, margin: "0 auto", padding: "0 16px" },
    header: { padding: "22px 0 2px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" },
    h1: { fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 28, letterSpacing: "-0.02em", margin: 0 },
    sub: { color: T.mute, fontSize: 13.5, margin: "3px 0 0" },
    round: { background: T.card, border: `1px solid ${T.line}`, color: T.ink, borderRadius: 999, width: 38, height: 38, fontSize: 17, cursor: "pointer" },
    tabs: { display: "flex", gap: 4, background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: 4, marginTop: 14 },
    tab: (a) => ({ flex: 1, border: "none", borderRadius: 9, padding: "8px 0", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", background: a ? T.accent : "transparent", color: a ? "#fff" : T.mute }),
    addCard: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 14, padding: 10, marginTop: 14, boxShadow: T.shadow },
    addRow: { display: "flex", gap: 8 },
    addInput: { flex: 1, border: "none", outline: "none", fontSize: 16, padding: "6px 6px", background: "transparent", fontFamily: "inherit", color: T.ink },
    addBtn: { background: T.accent, color: "#fff", border: "none", borderRadius: 10, padding: "8px 16px", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
    quickRow: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" },
    qChip: (a) => ({ border: `1px solid ${a ? T.accent : T.line}`, background: a ? T.accentSoft : "transparent", color: a ? T.accent : T.mute, borderRadius: 999, padding: "4px 11px", fontSize: 12.5, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }),
    inlineGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${T.line}` },
    label: { fontSize: 10.5, fontWeight: 600, color: T.mute, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 3 },
    input: { width: "100%", boxSizing: "border-box", border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 14, fontFamily: "inherit", background: T.bg, color: T.ink, outline: "none", colorScheme: dark ? "dark" : "light" },
    toolRow: { display: "flex", gap: 8, marginTop: 12, alignItems: "center" },
    search: { flex: 1, border: `1px solid ${T.line}`, borderRadius: 10, padding: "9px 12px", fontSize: 14, background: T.card, color: T.ink, outline: "none", fontFamily: "inherit" },
    chipRow: { display: "flex", gap: 8, overflowX: "auto", padding: 0, scrollbarWidth: "none" },
    chip: (a) => ({ flexShrink: 0, border: `1px solid ${a ? T.accent : T.line}`, background: a ? T.accent : T.card, color: a ? "#fff" : T.ink, borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }),
    panel: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 14, marginTop: 10, padding: 12, display: "grid", gap: 10 },
    gTitle: (danger, bucket) => ({ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 12.5, letterSpacing: "0.08em", textTransform: "uppercase", color: danger ? T.danger : bucket ? T.accent : T.mute, margin: "20px 0 8px", display: "flex", alignItems: "center", gap: 8 }),
    count: { fontSize: 11, background: T.tagBg, color: T.ink, borderRadius: 999, padding: "1px 8px", fontWeight: 600 },
    card: (done, edge, tint) => ({ background: tint || T.card, borderTop: `1px solid ${T.line}`, borderRight: `1px solid ${T.line}`, borderBottom: `1px solid ${T.line}`, borderLeft: `3px solid ${edge || T.line}`, borderRadius: 12, padding: "10px 12px", marginBottom: 8, display: "flex", gap: 10, alignItems: "flex-start", opacity: done ? 0.55 : 1, boxShadow: T.shadow, transition: "opacity 0.2s", minHeight: 54, boxSizing: "border-box" }),
    check: (done) => ({ width: 22, height: 22, minWidth: 22, borderRadius: 11, border: `2px solid ${done ? T.accent : T.line}`, background: done ? T.accent : "transparent", color: "#fff", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginTop: 1, padding: 0, transition: "background 0.15s, border-color 0.15s, transform 0.15s", transform: done ? "scale(1.05)" : "scale(1)" }),
    title: (done) => ({ fontSize: 15.5, fontWeight: 500, textDecoration: done ? "line-through" : "none", overflowWrap: "anywhere" }),
    meta: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 },
    tag: (bg, fg) => ({ fontSize: 12, background: bg, color: fg, borderRadius: 6, padding: "2px 8px", fontWeight: 500 }),
    iconBtn: { background: "none", border: "none", color: T.mute, cursor: "pointer", fontSize: 15, padding: 4, fontFamily: "inherit" },
    /* table */
    tableWrap: { overflowX: "auto", marginTop: 16, border: `1px solid ${T.line}`, borderRadius: 12, background: T.card },
    table: { borderCollapse: "collapse", width: "100%", minWidth: 620, fontSize: 13.5 },
    th: { textAlign: "left", padding: "10px 12px", fontFamily: "'Archivo', sans-serif", fontSize: 11.5, letterSpacing: "0.06em", textTransform: "uppercase", color: T.mute, borderBottom: `1px solid ${T.line}`, cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" },
    td: { padding: "9px 12px", borderBottom: `1px solid ${T.line}`, verticalAlign: "top" },
    /* dashboard */
    statGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 },
    statCard: (accentColor) => ({ background: T.card, border: `1px solid ${T.line}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow, borderTop: `3px solid ${accentColor}` }),
    statNum: { fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 30, lineHeight: 1.1 },
    statLbl: { fontSize: 12.5, color: T.mute, fontWeight: 500, marginTop: 2 },
    dashCard: { background: T.card, border: `1px solid ${T.line}`, borderRadius: 14, padding: 16, marginTop: 12, boxShadow: T.shadow },
    dashTitle: { fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: T.mute, margin: "0 0 12px" },
    barRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
    barLbl: { fontSize: 13, width: 110, minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    barTrack: { flex: 1, height: 10, background: T.tagBg, borderRadius: 6, overflow: "hidden" },
    barFill: (pct, color) => ({ width: `${pct}%`, height: "100%", background: color, borderRadius: 6, transition: "width 0.4s" }),
    barVal: { fontSize: 12.5, color: T.mute, width: 24, textAlign: "right" },
    colWrap: { display: "flex", alignItems: "flex-end", gap: 6, height: 90, marginTop: 4 },
    col: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" },
    colBar: (pct, color) => ({ width: "100%", maxWidth: 34, height: `${Math.max(pct, 3)}%`, background: color, borderRadius: "5px 5px 0 0", transition: "height 0.4s" }),
    colLbl: { fontSize: 10.5, color: T.mute },
    footer: { position: "fixed", bottom: 0, left: 0, right: 0, background: T.footBg, borderTop: `1px solid ${T.line}`, padding: "10px 16px", display: "flex", gap: 10, justifyContent: "center", backdropFilter: "blur(6px)" },
    fab: { position: "fixed", bottom: 74, right: "max(18px, calc(50% - 360px + 18px))", width: 56, height: 56, borderRadius: 28, background: T.accent, color: "#fff", border: "none", fontSize: 30, lineHeight: "56px", textAlign: "center", cursor: "pointer", boxShadow: "0 4px 16px rgba(0,0,0,0.28)", zIndex: 15, padding: 0, fontFamily: "inherit", transition: "transform 0.15s" },
    footBtn: { border: `1px solid ${T.line}`, background: T.card, borderRadius: 10, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: T.ink },
    modalBg: { position: "fixed", inset: 0, background: T.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 20 },
    modal: { background: T.card, borderRadius: 16, padding: 18, width: "100%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto", color: T.ink },
    textarea: { width: "100%", boxSizing: "border-box", height: 180, border: `1px solid ${T.line}`, borderRadius: 10, padding: 10, fontSize: 12.5, fontFamily: "ui-monospace, monospace", background: T.bg, color: T.ink },
    empty: { textAlign: "center", color: T.mute, padding: "50px 20px", fontSize: 15 },
    toast: { position: "fixed", bottom: 70, left: "50%", transform: "translateX(-50%)", background: T.ink, color: T.bg, borderRadius: 999, padding: "8px 18px", fontSize: 13.5, fontWeight: 500, zIndex: 30, whiteSpace: "nowrap" },
  };

  if (loading) return <div style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center" }}>Loading your tasks…</div>;

  if (!session) return (
    <div style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40 }}>☑</div>
          <h1 style={{ ...S.h1, fontSize: 30, marginTop: 6 }}>Tasks</h1>
          <p style={{ ...S.sub, marginTop: 4 }}>Sign in to sync across your devices</p>
        </div>
        <div style={{ ...S.dashCard, marginTop: 0 }}>
          <label style={S.label}>Who's this?</label>
          {roster.length === 0 ? (
            <div>
              <p style={{ fontSize: 13.5, color: T.mute, margin: "4px 0 8px", lineHeight: 1.5 }}>
                Can't reach the server. Check the Server URL below, then reopen the app.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={S.addInput} placeholder="https://your-worker.workers.dev"
                  value={urlDraft || (workerUrl.includes("REPLACE-WITH") ? "" : workerUrl)}
                  onChange={(e) => setUrlDraft(e.target.value)} />
                <button style={S.addBtn} onClick={() => {
                  const u = urlDraft.trim().replace(/\/+$/, "");
                  if (!/^https?:\/\//.test(u)) { setLoginErr("URL should start with https://"); return; }
                  setWorkerUrl(u); savePrefs({ workerUrl: u }); setUrlDraft(""); setLoginErr("");
                }}>Save</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              {roster.map((u) => (
                <button key={u.name} onClick={() => { setLoginName(u.name); setLoginErr(""); }}
                  style={{ border: `1px solid ${loginName === u.name ? T.accent : T.line}`,
                    background: loginName === u.name ? T.accent : T.card,
                    color: loginName === u.name ? "#fff" : T.ink,
                    borderRadius: 999, padding: "8px 16px", fontSize: 15, fontWeight: 600,
                    cursor: "pointer", fontFamily: "inherit" }}>
                  {u.name}
                </button>
              ))}
            </div>
          )}
          {loginName && (
            <>
              <label style={S.label}>PIN</label>
              <input style={{ ...S.input, fontSize: 20, letterSpacing: "0.3em", textAlign: "center" }}
                type="password" inputMode="numeric" autoComplete="off" value={loginPin}
                placeholder="••••"
                onChange={(e) => { setLoginPin(e.target.value.replace(/[^0-9]/g, "")); setLoginErr(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") doLogin(); }} autoFocus />
            </>
          )}
          {loginErr && <p style={{ color: T.danger, fontSize: 13.5, margin: "10px 0 0" }}>{loginErr}</p>}
          <button style={{ ...S.addBtn, width: "100%", marginTop: 16, padding: "11px 0", fontSize: 16, opacity: loginName ? 1 : 0.5 }}
            onClick={doLogin} disabled={loggingIn || !loginName}>
            {loggingIn ? "Signing in…" : "Sign in"}
          </button>
        </div>
        <p style={{ textAlign: "center", fontSize: 12, color: T.mute, marginTop: 16 }}>
          Forgot your PIN? Ask the person who set this up.
        </p>
      </div>
    </div>
  );

  const showAddExtras = addOpen || addFocus || newTitle.length > 0 || draft.dueDate || draft.category;

  const editFields = (obj, set) => (
    <>
      <div>
        <label style={S.label}>Category</label>
        <input style={S.input} list="cats" value={obj.category} onChange={(e) => set({ ...obj, category: e.target.value })} placeholder="e.g. Work" />
      </div>
      <div>
        <label style={S.label}>Sub category</label>
        <input style={S.input} list="subcats" value={obj.subCategory} onChange={(e) => set({ ...obj, subCategory: e.target.value })} placeholder="e.g. Reports" />
      </div>
      <div>
        <label style={S.label}>Due date</label>
        <input style={S.input} type="date" value={obj.dueDate} onChange={(e) => set({ ...obj, dueDate: e.target.value })} />
      </div>
      <div>
        <label style={S.label}>Due time</label>
        <input style={S.input} type="time" value={obj.dueTime} onChange={(e) => set({ ...obj, dueTime: e.target.value })} />
      </div>
      <div>
        <label style={S.label}>Reminder date</label>
        <input style={S.input} type="date" value={obj.reminderDate} onChange={(e) => set({ ...obj, reminderDate: e.target.value })} />
      </div>
      <div>
        <label style={S.label}>Reminder time</label>
        <input style={S.input} type="time" value={obj.reminderTime} onChange={(e) => set({ ...obj, reminderTime: e.target.value })} />
      </div>
      <div>
        <label style={S.label}>Repeat</label>
        <select style={S.input}
          value={obj.recurrence.startsWith("custom:") ? "custom" : obj.recurrence}
          onChange={(e) => set({ ...obj, recurrence: e.target.value === "custom" ? "custom:2:weeks" : e.target.value })}>
          {RECURRENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {obj.recurrence.startsWith("custom:") && (
          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
            <span style={{ fontSize: 12.5, color: T.mute }}>Every</span>
            <input style={{ ...S.input, width: 56 }} type="number" min="1"
              value={parseInt(obj.recurrence.split(":")[1], 10) || 1}
              onChange={(e) => set({ ...obj, recurrence: `custom:${Math.max(1, parseInt(e.target.value, 10) || 1)}:${obj.recurrence.split(":")[2] || "days"}` })} />
            <select style={{ ...S.input, width: "auto" }}
              value={obj.recurrence.split(":")[2] || "days"}
              onChange={(e) => set({ ...obj, recurrence: `custom:${parseInt(obj.recurrence.split(":")[1], 10) || 1}:${e.target.value}` })}>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
            </select>
          </div>
        )}
      </div>
      <div>
        <label style={S.label}>If no date, list under</label>
        <select style={S.input} value={obj.bucket} onChange={(e) => set({ ...obj, bucket: e.target.value })} disabled={!!obj.dueDate}>
          {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
    </>
  );

  const TaskCard = ({ t }) => {
    const overdue = !t.done && t.dueDate && t.dueDate < today;
    if (compact) {
      return (
        <div style={{ ...S.card(t.done, t.category ? dotColor(t.category, dark, colorMap) : T.line, overdue ? T.dangerSoft : null), minHeight: 0, padding: "5px 10px", marginBottom: 5, gap: 8, alignItems: "center" }}>
          <button style={{ ...S.check(t.done), width: 19, height: 19, minWidth: 19, fontSize: 12, marginTop: 0 }} onClick={() => toggle(t.id)} aria-label={t.done ? "Mark open" : "Mark done"}>{t.done ? "✓" : ""}</button>
          <div style={{ flex: 1, minWidth: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }} onClick={() => setEditing({ ...t })}>
            <span style={{ fontSize: 14, fontWeight: 500, textDecoration: t.done ? "line-through" : "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{t.title}</span>
            {t.subCategory && <span style={{ fontSize: 11, color: T.mute, whiteSpace: "nowrap", flex: "0 0 auto" }}>{t.subCategory}</span>}
            {t.dueDate && <span style={{ fontSize: 11.5, color: overdue ? T.danger : T.mute, whiteSpace: "nowrap", flex: "0 0 auto" }}>{fmtDate(t.dueDate)}{t.dueTime ? ` ${fmtTime(t.dueTime)}` : ""}</span>}
            {t.recurrence && <span style={{ fontSize: 11, color: T.mute, flex: "0 0 auto" }} title={recLabel(t.recurrence)}>↻</span>}
            {t.reminderDate && <span style={{ fontSize: 11, color: T.mute, flex: "0 0 auto" }} title="Reminder">🔔</span>}
            {t.notes && <span style={{ fontSize: 11, color: T.accent, flex: "0 0 auto" }} title="Has notes">☰</span>}
          </div>
        </div>
      );
    }
    return (
    <div style={S.card(t.done, t.category ? dotColor(t.category, dark, colorMap) : T.line, !t.done && t.dueDate && t.dueDate < today ? T.dangerSoft : null)}>
      <button style={S.check(t.done)} onClick={() => toggle(t.id)} aria-label={t.done ? "Mark open" : "Mark done"}>{t.done ? "✓" : ""}</button>
      <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setEditing({ ...t })}>
        <div style={S.title(t.done)}>{t.title}</div>
        <div style={S.meta}>
          {t.category && <span style={S.tag(catStyle(t.category, dark, colorMap).background, catStyle(t.category, dark, colorMap).color)}>{t.category}</span>}
          {t.subCategory && <span style={{ ...S.tag(catStyle(t.subCategory, dark, colorMap).background, catStyle(t.subCategory, dark, colorMap).color), boxShadow: `inset 0 0 0 1px ${dotColor(t.subCategory, dark, colorMap)}` }}>{t.subCategory}</span>}
          {t.dueDate && (
            <span style={S.tag(t.dueDate < today && !t.done ? T.dangerSoft : T.tagBg, t.dueDate < today && !t.done ? T.danger : T.mute)}>
              {fmtDate(t.dueDate)}{t.dueTime ? ` · ${fmtTime(t.dueTime)}` : ""}
            </span>
          )}
          {t.recurrence && <span style={S.tag(T.tagBg, T.mute)}>↻ {recLabel(t.recurrence)}</span>}
          {t.reminderDate && <span style={S.tag(T.tagBg, T.mute)}>🔔 {fmtDate(t.reminderDate)}{t.reminderTime ? ` ${fmtTime(t.reminderTime)}` : ""}</span>}
          {t.notes && (() => {
            const n = t.notes.split("\n").filter((l) => l.trim().startsWith("•")).length;
            return (
              <button onClick={(e) => { e.stopPropagation(); setOpenNotes((prev) => ({ ...prev, [t.id]: !prev[t.id] })); }}
                style={{ ...S.tag(T.accentSoft, T.accent), border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                ☰ {n ? `${n} items` : "notes"} {openNotes[t.id] ? "▴" : "▾"}
              </button>
            );
          })()}
        </div>
        {t.notes && openNotes[t.id] && (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, color: T.mute, marginTop: 8, lineHeight: 1.55, borderTop: `1px dashed ${T.line}`, paddingTop: 8 }}>{t.notes}</div>
        )}
      </div>
      {!t.done && t.dueDate !== tomorrow && <button style={S.iconBtn} onClick={() => snooze(t.id)} aria-label="Move to tomorrow" title="Move to tomorrow">⇥</button>}
      <button style={S.iconBtn} onClick={() => setEditing({ ...t })} aria-label="Edit">✎</button>
      <button style={S.iconBtn} onClick={() => remove(t.id)} aria-label="Delete">✕</button>
    </div>
    );
  };

  const filtersActive = filterCat !== "All" || filterSub !== "All" || filterStatus !== "Open";
  const arrow = (k) => (sortKey === k ? (sortDir === 1 ? " ↑" : " ↓") : "");
  const maxCat = Math.max(1, ...stats.catRows.map(([, n]) => n));
  const maxNext7 = Math.max(1, ...stats.next7.map((d) => d.count));
  const maxLast7 = Math.max(1, ...stats.last7.map((d) => d.count));

  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;800&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
      <datalist id="cats">{categories.filter((c) => c !== "All").map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="subcats">{subSuggestions.map((c) => <option key={c} value={c} />)}</datalist>

      <div style={S.wrap}>
        <header style={S.header}>
          <div>
            <h1 style={S.h1}>{view === "Tasks" ? "Tasks" : view}</h1>
            {view === "Tasks" && <p style={S.sub}>{open.length} open{doneList.length ? ` · ${doneList.length} done` : ""}</p>}
            {view === "Lists" && <p style={S.sub}>{lists.length} list{lists.length === 1 ? "" : "s"}</p>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...S.round, position: "relative", borderColor: dirty ? T.accent : T.line }} onClick={syncPush} disabled={syncing} aria-label="Sync to Sheets" title={dirty ? "Unsynced changes — tap to sync" : "Sync to Sheets"}>
              {syncing ? "⧗" : "⇅"}
              {dirty && !syncing && <span style={{ position: "absolute", top: 4, right: 4, width: 8, height: 8, borderRadius: 4, background: T.accent }} />}
            </button>
            <button style={S.round} onClick={() => setTheme(!dark)} aria-label="Toggle dark mode">{dark ? "☀" : "☾"}</button>
          </div>
        </header>
        {view === "Tasks" && focus && (
          <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 14, color: T.accent, marginTop: 10 }}>
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </div>
        )}
        {view === "Tasks" && (() => {
          const dueT = tasks.filter((t) => !t.done && t.dueDate === today).length;
          const doneT = tasks.filter((t) => t.done && t.completedAt === today).length;
          const total = dueT + doneT;
          if (!total) return null;
          return (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 12, color: T.mute, marginBottom: 4 }}>Today: {doneT} of {total} done</div>
              <div style={{ height: 6, background: T.tagBg, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${(doneT / total) * 100}%`, height: "100%", background: T.accent, borderRadius: 4, transition: "width 0.4s" }} />
              </div>
            </div>
          );
        })()}

        {/* add-task modal (opened by the + button) */}
        {view === "Tasks" && addOpen && (
          <div style={S.modalBg} onClick={() => { setAddOpen(false); setAddFocus(false); }}>
            <div style={{ ...S.modal, maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontFamily: "'Archivo', sans-serif", fontSize: 18 }}>New task</h3>
                <button style={{ ...S.iconBtn, marginLeft: "auto", fontSize: 18 }} onClick={() => setAddOpen(false)} aria-label="Close">✕</button>
              </div>
              <div style={{ ...S.addCard, marginTop: 0, border: "none", boxShadow: "none", padding: 0 }}>
                <div style={S.addRow}>
                  <input style={{ ...S.addInput, border: `1px solid ${T.line}`, borderRadius: 10, padding: "10px 12px" }} placeholder="Add a task…" value={newTitle} autoFocus
                    onFocus={() => setAddFocus(true)}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTask()} />
                  <button style={S.addBtn} onClick={addTask}>Add</button>
                </div>

            {parsed.matches.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {parsed.matches.map((m) => (
                  <span key={m.key} style={{ ...S.tag(T.accentSoft, T.accent), display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {m.label}
                    <button style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", padding: 0, fontSize: 12 }}
                      onClick={() => setIgnoredParses((p) => ({ ...p, [m.key]: true }))} aria-label="Keep as text">✕</button>
                  </span>
                ))}
              </div>
            )}
            {showAddExtras && (
              <>
                <div style={S.quickRow}>
                  <button style={S.qChip(draft.dueDate === today)} onClick={() => setDraft({ ...draft, dueDate: draft.dueDate === today ? "" : today })}>Today</button>
                  <button style={S.qChip(draft.dueDate === tomorrow)} onClick={() => setDraft({ ...draft, dueDate: draft.dueDate === tomorrow ? "" : tomorrow })}>Tomorrow</button>
                  <button style={S.qChip(!draft.dueDate && draft.bucket === "Next week")} onClick={() => setDraft({ ...draft, dueDate: "", bucket: draft.bucket === "Next week" ? "Inbox" : "Next week" })}>Next week</button>
                  <button style={S.qChip(!draft.dueDate && draft.bucket === "Someday")} onClick={() => setDraft({ ...draft, dueDate: "", bucket: draft.bucket === "Someday" ? "Inbox" : "Someday" })}>Someday</button>
                  <button style={S.qChip(false)} onClick={() => setMoreFields(!moreFields)}>{moreFields ? "Less ▴" : "More ▾"}</button>
                </div>
                <div style={S.inlineGrid}>
                  <div>
                    <label style={S.label}>Category</label>
                    <input style={S.input} list="cats" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="e.g. Work" />
                  </div>
                  <div>
                    <label style={S.label}>Due date</label>
                    <input style={S.input} type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
                  </div>
                  {moreFields && (
                    <>
                      <div>
                        <label style={S.label}>Sub category</label>
                        <input style={S.input} list="subcats" value={draft.subCategory} onChange={(e) => setDraft({ ...draft, subCategory: e.target.value })} placeholder="e.g. Reports" />
                      </div>
                      <div>
                        <label style={S.label}>Due time</label>
                        <input style={S.input} type="time" value={draft.dueTime} onChange={(e) => setDraft({ ...draft, dueTime: e.target.value })} />
                      </div>
                      <div>
                        <label style={S.label}>Reminder date</label>
                        <input style={S.input} type="date" value={draft.reminderDate} onChange={(e) => setDraft({ ...draft, reminderDate: e.target.value })} />
                      </div>
                      <div>
                        <label style={S.label}>Reminder time</label>
                        <input style={S.input} type="time" value={draft.reminderTime} onChange={(e) => setDraft({ ...draft, reminderTime: e.target.value })} />
                      </div>
                      <div>
                        <label style={S.label}>Repeat</label>
                        <select style={S.input}
                          value={draft.recurrence.startsWith("custom:") ? "custom" : draft.recurrence}
                          onChange={(e) => setDraft({ ...draft, recurrence: e.target.value === "custom" ? "custom:2:weeks" : e.target.value })}>
                          {RECURRENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                        {draft.recurrence.startsWith("custom:") && (
                          <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 12.5, color: T.mute }}>Every</span>
                            <input style={{ ...S.input, width: 56 }} type="number" min="1"
                              value={parseInt(draft.recurrence.split(":")[1], 10) || 1}
                              onChange={(e) => setDraft({ ...draft, recurrence: `custom:${Math.max(1, parseInt(e.target.value, 10) || 1)}:${draft.recurrence.split(":")[2] || "days"}` })} />
                            <select style={{ ...S.input, width: "auto" }}
                              value={draft.recurrence.split(":")[2] || "days"}
                              onChange={(e) => setDraft({ ...draft, recurrence: `custom:${parseInt(draft.recurrence.split(":")[1], 10) || 1}:${e.target.value}` })}>
                              <option value="days">days</option>
                              <option value="weeks">weeks</option>
                              <option value="months">months</option>
                            </select>
                          </div>
                        )}
                      </div>
                      <div>
                        <label style={S.label}>If no date, list under</label>
                        <select style={S.input} value={draft.bucket} onChange={(e) => setDraft({ ...draft, bucket: e.target.value })} disabled={!!draft.dueDate}>
                          {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
              </div>
            </div>
          </div>
        )}

        {/* search + filter (list & table) */}
        {view === "Tasks" && (
          <>
            <div style={S.toolRow}>
              <input style={S.search} placeholder="Search tasks…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden" }}>
                {["List", "Table"].map((m) => (
                  <button key={m} onClick={() => switchTaskMode(m)}
                    style={{ border: "none", padding: "9px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                      background: taskMode === m ? T.accent : T.card, color: taskMode === m ? "#fff" : T.mute }}>{m}</button>
                ))}
              </div>
              <button style={{ ...S.footBtn, borderColor: filtersActive ? T.accent : T.line, color: filtersActive ? T.accent : T.ink }} onClick={() => setShowFilters(!showFilters)}>
                Filter{filtersActive ? " •" : ""}
              </button>
            </div>
            {showFilters && (
              <div style={S.panel}>
                <div>
                  <label style={S.label}>Category</label>
                  <div style={S.chipRow}>{categories.map((c) => <button key={c} style={S.chip(filterCat === c)} onClick={() => { setFilterCat(c); setFilterSub("All"); }}>{c !== "All" && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: dotColor(c, dark, colorMap), marginRight: 6 }} />}{c}</button>)}</div>
                </div>
                {subCats.length > 1 && (
                  <div>
                    <label style={S.label}>Sub category</label>
                    <div style={S.chipRow}>{subCats.map((c) => <button key={c} style={S.chip(filterSub === c)} onClick={() => setFilterSub(c)}>{c !== "All" && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: dotColor(c, dark, colorMap), marginRight: 6 }} />}{c}</button>)}</div>
                  </div>
                )}
                <div>
                  <label style={S.label}>Status</label>
                  <div style={S.chipRow}>{["Open", "Done", "All"].map((s) => <button key={s} style={S.chip(filterStatus === s)} onClick={() => setFilterStatus(s)}>{s}</button>)}</div>
                </div>
                {filtersActive && (
                  <button style={{ ...S.footBtn, justifySelf: "start" }} onClick={() => { setFilterCat("All"); setFilterSub("All"); setFilterStatus("Open"); }}>Clear filters</button>
                )}
              </div>
            )}
          </>
        )}

        {/* ---------- LIST VIEW ---------- */}
        {view === "Tasks" && taskMode === "List" && (
          <>
            {(() => {
              const focusGroups = groups.filter((g) => FOCUS_KEYS.includes(g.key));
              const laterGroups = groups.filter((g) => !FOCUS_KEYS.includes(g.key));
              const hiddenCount = laterGroups.reduce((n, g) => n + g.items.length, 0);
              const shownGroups = focus ? focusGroups : groups;
              return (
                <>
                  {/* focus / all toggle */}
                  {(groups.length > 0 || doneList.length > 0) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
                      <div style={{ display: "flex", border: `1px solid ${T.line}`, borderRadius: 999, overflow: "hidden" }}>
                        {[["Focus", true], ["All", false]].map(([lbl, val]) => (
                          <button key={lbl} onClick={() => switchFocus(val)}
                            style={{ border: "none", padding: "6px 16px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                              background: focus === val ? T.accent : T.card, color: focus === val ? "#fff" : T.mute }}>{lbl}</button>
                        ))}
                      </div>
                      {focus && hiddenCount > 0 && (
                        <button onClick={() => switchFocus(false)}
                          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, color: T.mute }}>
                          {hiddenCount} more scheduled ›
                        </button>
                      )}
                      <button onClick={() => { const v = !compact; setCompact(v); savePrefs({ compact: v }); }}
                        title={compact ? "Switch to comfortable rows" : "Switch to compact rows"}
                        style={{ marginLeft: "auto", background: "none", border: `1px solid ${compact ? T.accent : T.line}`, borderRadius: 999, padding: "5px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: compact ? T.accent : T.mute }}>
                        {compact ? "≡ Compact" : "≣ Comfortable"}
                      </button>
                    </div>
                  )}

                  {open.length === 0 && doneList.length === 0 && (
                    <div style={S.empty}>{q || filtersActive ? "No tasks match. Try clearing search or filters." : "Nothing here yet. Add your first task above — it saves automatically."}</div>
                  )}
                  {focus && open.length > 0 && focusGroups.length === 0 && (
                    <div style={S.empty}>All clear for now — nothing overdue, due today or tomorrow.{hiddenCount > 0 ? ` ${hiddenCount} task${hiddenCount === 1 ? "" : "s"} scheduled for later.` : ""}</div>
                  )}

                  {shownGroups.map((g) => {
                    const isCollapsed = !!collapsed[g.key];
                    const isExpanded = !!expandedGroups[g.key];
                    const cap = compact ? GROUP_CAP * 2 : GROUP_CAP;
                    const items = isCollapsed ? [] : isExpanded ? g.items : g.items.slice(0, cap);
                    const moreCount = g.items.length - cap;
                    return (
                      <section key={g.key} id={"grp-" + g.key}>
                        <h2 style={{ ...S.gTitle(g.danger, g.bucket || g.accent), cursor: "pointer", userSelect: "none" }} onClick={() => toggleCollapse(g.key)}>
                          <span style={{ fontWeight: 400, fontSize: 11 }}>{isCollapsed ? "▸" : "▾"}</span>
                          {g.key} <span style={S.count}>{g.items.length}</span>
                        </h2>
                        {items.map((t) => <TaskCard key={t.id} t={t} />)}
                        {!isCollapsed && !isExpanded && moreCount > 0 && (
                          <button onClick={() => setExpandedGroups((prev) => ({ ...prev, [g.key]: true }))}
                            style={{ width: "100%", background: "none", border: `1px dashed ${T.line}`, borderRadius: 10, padding: "8px 0", marginBottom: 8, cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: T.mute }}>
                            Show {moreCount} more
                          </button>
                        )}
                      </section>
                    );
                  })}
                </>
              );
            })()}
            {doneList.length > 0 && (
              <section>
                <h2 style={{ ...S.gTitle(false, false), cursor: "pointer" }} onClick={() => setShowDone(!showDone)}>
                  Completed <span style={S.count}>{doneList.length}</span>
                  <span style={{ fontWeight: 400 }}>{showDone || filterStatus === "Done" ? "▴" : "▾"}</span>
                  {(showDone || filterStatus === "Done") && (
                    <button style={{ ...S.iconBtn, marginLeft: "auto", fontSize: 12.5 }} onClick={(e) => { e.stopPropagation(); clearDone(); }}>Clear all</button>
                  )}
                </h2>
                {(showDone || filterStatus === "Done") && doneList.map((t) => <TaskCard key={t.id} t={t} />)}
              </section>
            )}
          </>
        )}

        {/* ---------- TABLE VIEW ---------- */}
        {view === "Tasks" && taskMode === "Table" && (
          <div style={S.tableWrap}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={{ ...S.th, width: 34, cursor: "default" }}></th>
                  <th style={S.th} onClick={() => sortBy("title")}>Task{arrow("title")}</th>
                  <th style={S.th} onClick={() => sortBy("category")}>Category{arrow("category")}</th>
                  <th style={S.th} onClick={() => sortBy("subCategory")}>Sub{arrow("subCategory")}</th>
                  <th style={S.th} onClick={() => sortBy("dueDate")}>Due{arrow("dueDate")}</th>
                  <th style={S.th} onClick={() => sortBy("recurrence")}>Repeat{arrow("recurrence")}</th>
                  <th style={{ ...S.th, cursor: "default" }}></th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 && (
                  <tr><td style={{ ...S.td, textAlign: "center", color: T.mute }} colSpan={7}>No tasks match.</td></tr>
                )}
                {tableRows.map((t, i) => (
                  <tr key={t.id} style={{ background: i % 2 ? T.rowAlt : "transparent", opacity: t.done ? 0.55 : 1 }}>
                    <td style={S.td}><button style={S.check(t.done)} onClick={() => toggle(t.id)}>{t.done ? "✓" : ""}</button></td>
                    <td style={{ ...S.td, fontWeight: 500, textDecoration: t.done ? "line-through" : "none", minWidth: 160 }}>{t.title}</td>
                    <td style={S.td}>{t.category ? <span style={S.tag(catStyle(t.category, dark, colorMap).background, catStyle(t.category, dark, colorMap).color)}>{t.category}</span> : <span style={{ color: T.mute }}>—</span>}</td>
                    <td style={S.td}>{t.subCategory ? <span style={S.tag(catStyle(t.subCategory, dark, colorMap).background, catStyle(t.subCategory, dark, colorMap).color)}>{t.subCategory}</span> : <span style={{ color: T.mute }}>—</span>}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap", color: t.dueDate && t.dueDate < today && !t.done ? T.danger : "inherit" }}>
                      {t.dueDate ? `${fmtShort(t.dueDate)}${t.dueTime ? " " + fmtTime(t.dueTime) : ""}` : (t.bucket && t.bucket !== "Inbox" ? t.bucket : "—")}
                    </td>
                    <td style={S.td}>{t.recurrence ? "↻ " + recLabel(t.recurrence) : "—"}</td>
                    <td style={{ ...S.td, whiteSpace: "nowrap" }}>
                      <button style={S.iconBtn} onClick={() => setEditing({ ...t })}>✎</button>
                      <button style={S.iconBtn} onClick={() => remove(t.id)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ---------- LISTS VIEW ---------- */}
        {view === "Lists" && !activeList && (
          <>
            <div style={{ ...S.addCard }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={S.addInput} placeholder="New list (e.g. Grocery, Travel packing)…" value={newListName}
                  onChange={(e) => setNewListName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addList()} />
                <button style={S.addBtn} onClick={addList}>Create</button>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {Object.entries(LIST_TYPES).map(([k, v]) => (
                  <button key={k} style={S.qChip(newListType === k)} onClick={() => setNewListType(k)}>{v.icon} {v.label}</button>
                ))}
              </div>
              {listCats.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: T.mute }}>Category:</span>
                  <button style={S.qChip(newListCat === "")} onClick={() => setNewListCat("")}>None</button>
                  {listCats.map((c) => (
                    <button key={c} style={S.qChip(newListCat === c)} onClick={() => setNewListCat(c)}>{c}</button>
                  ))}
                </div>
              )}
              {newListType === "custom" && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: T.mute }}>Item fields:</span>
                  {CUSTOM_CHOICES.map((f) => (
                    <button key={f} style={S.qChip(newListFields.includes(f))}
                      onClick={() => setNewListFields(newListFields.includes(f) ? newListFields.filter((x) => x !== f) : [...newListFields, f])}>{f}</button>
                  ))}
                  <span style={{ fontSize: 12, color: T.mute }}>(sections always available)</span>
                </div>
              )}
            </div>
            {lists.length === 0 && <div style={S.empty}>No lists yet. Create reusable checklists — groceries, packing, routines — and promote items to Tasks when they need a date.</div>}
            {(() => {
              const renderCard = (l) => {
                const done = l.items.filter((i) => i.checked).length;
                return (
                  <div key={l.id} style={{ ...S.card(false, dotColor(l.name, dark, colorMap)), cursor: "pointer", alignItems: "center" }} onClick={() => setActiveListId(l.id)}>
                    <span style={{ width: 18, height: 18, minWidth: 18, borderRadius: 9, background: dotColor(l.name, dark, colorMap) }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15.5, fontWeight: 600 }}>{l.name}</div>
                      <div style={{ fontSize: 12.5, color: T.mute, marginTop: 2 }}>{(LIST_TYPES[l.type] || LIST_TYPES.checklist).icon} {(LIST_TYPES[l.type] || LIST_TYPES.checklist).label} · {done}/{l.items.length} checked</div>
                    </div>
                    <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); renameList(l.id); }} title="Rename">✎</button>
                    <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); deleteList(l.id); }} title="Delete">✕</button>
                    <span style={{ color: T.mute, fontSize: 16 }}>›</span>
                  </div>
                );
              };
              // build groups: each defined category in order, then "Other" for the rest
              const groups = [];
              listCats.forEach((c) => groups.push([c, lists.filter((l) => (l.category || "") === c)]));
              const otherLists = lists.filter((l) => !listCats.includes(l.category || ""));
              if (otherLists.length) groups.push([listCats.length ? "Other" : "", otherLists]);
              // if no categories are defined at all, just show a flat list
              if (!listCats.length) return lists.map(renderCard);
              return groups.map(([cat, group]) => {
                if (!group.length) return null;
                const collapsed = catCollapsed[cat];
                return (
                  <section key={cat || "__other"} style={{ marginTop: 8 }}>
                    <button
                      onClick={() => setCatCollapsed((m) => ({ ...m, [cat]: !m[cat] }))}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", padding: "6px 2px", color: T.ink }}>
                      <span style={{ fontSize: 12, color: T.mute, width: 12 }}>{collapsed ? "▸" : "▾"}</span>
                      <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 14, textTransform: "uppercase", letterSpacing: "0.04em" }}>{cat || "Uncategorized"}</span>
                      <span style={S.count}>{group.length}</span>
                    </button>
                    {!collapsed && group.map(renderCard)}
                  </section>
                );
              });
            })()}
          </>
        )}

        {view === "Lists" && activeList && (
          <>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: dotColor(activeList.name, dark, colorMap), display: "inline-block" }} />{activeList.name}
              </div>
              <div style={{ fontSize: 12.5, color: T.mute, marginTop: 2 }}>{activeList.items.filter((i) => i.checked).length}/{activeList.items.length} checked</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button style={S.footBtn} onClick={() => setActiveListId(null)}>‹ Lists</button>
              {!selectMode && !reorderMode && <button style={{ ...S.footBtn, borderColor: T.accent, color: T.accent }} onClick={() => { setSelectMode(true); setSelectedIds({}); }} title="Pick items to turn into one task">Select</button>}
              {!selectMode && <button style={S.footBtn} onClick={() => setReorderMode(!reorderMode)}>{reorderMode ? "Done" : "Order"}</button>}
              {!selectMode && !reorderMode && iOwn(activeList) && (
                <button style={{ ...S.footBtn, borderColor: (activeList.sharedWith || []).length ? T.accent : T.line, color: (activeList.sharedWith || []).length ? T.accent : T.ink }}
                  onClick={() => setShareFor(activeList.id)} title="Share this list with other users">
                  {(activeList.sharedWith || []).length ? `Shared · ${(activeList.sharedWith || []).length}` : "Share"}
                </button>
              )}
              {!selectMode && !reorderMode && !iOwn(activeList) && (
                <span style={{ ...S.tag(T.accentSoft, T.accent), alignSelf: "center" }}>Shared by {activeList.owner}</span>
              )}
              {!selectMode && !reorderMode && <button style={S.footBtn} onClick={() => printList(activeList)} title="Print this list">Print</button>}
              {!selectMode && !reorderMode && activeList.items.some((i) => i.checked) && (
                <button style={S.footBtn} onClick={() => { const v = !hideChecked; setHideChecked(v); savePrefs({ hideChecked: v }); }} title="Show or hide checked items">
                  {hideChecked ? "Show done" : "Hide done"}
                </button>
              )}
              {!selectMode && !reorderMode && <button style={S.footBtn} onClick={() => resetList(activeList.id)} title="Uncheck everything">Reset</button>}
              {selectMode && <button style={S.footBtn} onClick={() => { setSelectMode(false); setSelectedIds({}); }}>Cancel</button>}
            </div>
            {!selectMode && !reorderMode && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                <span style={{ fontSize: 12, color: T.mute }}>Type:</span>
                <select value={activeList.type || "checklist"} onChange={(e) => setListType(activeList.id, e.target.value)}
                  style={{ ...S.input, width: "auto", padding: "5px 8px", fontSize: 13 }}>
                  {Object.entries(LIST_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                {activeList.type === "custom" && CUSTOM_CHOICES.map((f) => (
                  <button key={f} style={S.qChip((activeList.fields || []).includes(f))} onClick={() => toggleListField(activeList.id, f)}>{f}</button>
                ))}
                {listCats.length > 0 && <>
                  <span style={{ fontSize: 12, color: T.mute, marginLeft: 6 }}>Category:</span>
                  <select value={listCats.includes(activeList.category) ? activeList.category : ""} onChange={(e) => setListCategory(activeList.id, e.target.value)}
                    style={{ ...S.input, width: "auto", padding: "5px 8px", fontSize: 13 }}>
                    <option value="">None</option>
                    {listCats.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </>}
              </div>
            )}
            {selectMode && (() => {
              const n = Object.values(selectedIds).filter(Boolean).length;
              const total = activeList.items.length;
              return (
                <div style={{ ...S.addCard, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ flex: 1, fontSize: 14, color: n ? T.ink : T.mute }}>
                      {n ? `${n} of ${total} selected` : "Tap items below to select them"}
                    </span>
                    <button style={{ ...S.footBtn, padding: "6px 12px" }} onClick={n === total ? selectNoItems : selectAllItems}>
                      {n === total ? "Clear" : "All"}
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button style={{ ...S.footBtn, opacity: n ? 1 : 0.5 }} disabled={!n} onClick={copySelected}>Copy</button>
                    <button style={{ ...S.footBtn, opacity: n ? 1 : 0.5 }} disabled={!n} onClick={shareSelected}>Share</button>
                    <button style={{ ...S.addBtn, marginLeft: "auto", opacity: n ? 1 : 0.5 }} disabled={!n} onClick={createTaskFromSelected}>→ Task</button>
                  </div>
                </div>
              );
            })()}

            {activeList.items.length === 0 && <div style={S.empty}>Empty list — add items below.</div>}
            <div style={{ marginTop: 12 }}>
              {sectionsOf(activeList, reorderMode).map(([sec, allItems]) => {
                const items = (!selectMode && !reorderMode && hideChecked) ? allItems.filter((i) => !i.checked) : allItems;
                if (!items.length) return null;
                return (
                <section key={sec || "__none"}>
                  {sec && (
                    <h2 style={S.gTitle(false, false)}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: dotColor(sec, dark, colorMap) }} />
                      {sec} <span style={S.count}>{allItems.filter((i) => !i.checked).length}/{allItems.length}</span>
                    </h2>
                  )}
                  {items.map((it) => reorderMode ? (
                    <div key={it.id} style={{ ...S.card(it.checked), alignItems: "center" }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 15, overflowWrap: "anywhere", opacity: it.checked ? 0.55 : 1 }}>{it.text}</div>
                      {(it.qty || it.unit) && <span style={S.tag(T.tagBg, T.mute)}>{[it.qty, it.unit].filter(Boolean).join(" ")}</span>}
                      <button style={{ ...S.footBtn, padding: "6px 12px" }} onClick={() => moveItem(activeList.id, it.id, -1)} aria-label="Move up">↑</button>
                      <button style={{ ...S.footBtn, padding: "6px 12px" }} onClick={() => moveItem(activeList.id, it.id, 1)} aria-label="Move down">↓</button>
                    </div>
                  ) : selectMode ? (
                    <div key={it.id} onClick={() => toggleSelect(it.id)}
                      style={{ ...S.card(false), alignItems: "center", cursor: "pointer",
                        border: `1.5px solid ${selectedIds[it.id] ? T.accent : T.line}`,
                        background: selectedIds[it.id] ? T.accentSoft : T.card }}>
                      <span style={{ width: 22, height: 22, minWidth: 22, borderRadius: 11, border: `2px solid ${selectedIds[it.id] ? T.accent : T.line}`, background: selectedIds[it.id] ? T.accent : "transparent", color: "#fff", fontSize: 13, lineHeight: "20px", textAlign: "center", pointerEvents: "none", marginTop: 2 }}>{selectedIds[it.id] ? "✓" : ""}</span>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 15, overflowWrap: "anywhere", opacity: it.checked ? 0.6 : 1, textDecoration: it.checked ? "line-through" : "none" }}>{it.text}</div>
                      {(it.qty || it.unit) && <span style={S.tag(T.tagBg, T.mute)}>{[it.qty, it.unit].filter(Boolean).join(" ")}</span>}
                      {it.price && <span style={S.tag(T.tagBg, T.mute)}>{it.price}</span>}
                    </div>
                  ) : (
                    <div key={it.id} style={{ ...S.card(it.checked), alignItems: "center" }}>
                      <button style={S.check(it.checked)} onClick={() => toggleItem(activeList.id, it.id)}>{it.checked ? "✓" : ""}</button>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 15, textDecoration: it.checked ? "line-through" : "none", overflowWrap: "anywhere" }}
                        onClick={() => editItemSection(activeList.id, it.id, it)} title="Tap to edit">{it.text}</div>
                      {(listExtras(activeList).includes("qty") || it.qty || it.unit) && (
                        <button style={{ ...S.tag(T.tagBg, T.mute), border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                          onClick={() => editItemQty(activeList.id, it.id, [it.qty, it.unit].filter(Boolean).join(" "))}
                          title="Tap to edit quantity">{[it.qty, it.unit].filter(Boolean).join(" ") || "+ qty"}</button>
                      )}
                      {(listExtras(activeList).includes("price") || it.price) && (
                        <button style={{ ...S.tag(T.tagBg, T.mute), border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
                          onClick={() => editItemPrice(activeList.id, it.id, it.price)}
                          title="Tap to edit price">{it.price || "+ price"}</button>
                      )}
                      {it.url && (
                        <a href={it.url} target="_blank" rel="noopener noreferrer"
                          style={{ ...S.tag(T.accentSoft, T.accent), textDecoration: "none", whiteSpace: "nowrap" }} title={it.url}>↗</a>
                      )}
                      {listExtras(activeList).includes("url") && (
                        <button style={S.iconBtn} onClick={() => editItemUrl(activeList.id, it.id, it.url)} title={it.url ? "Edit link" : "Add link"}>🔗</button>
                      )}
                      <button style={{ ...S.iconBtn, color: T.accent, fontWeight: 700 }} onClick={() => promoteItem(activeList, it)} title="Add to Tasks">➔ Task</button>
                      <button style={S.iconBtn} onClick={() => deleteItem(activeList.id, it.id)} title="Remove">✕</button>
                    </div>
                  ))}
                </section>
                );
              })}
            </div>
            <p style={{ fontSize: 12.5, color: T.mute, marginTop: 12, lineHeight: 1.5 }}>➔ Task copies an item into your Tasks inbox — category "{activeList.name}", sub category from its section. The item stays here, so the list remains reusable. Tap an item’s text to change its section.</p>
            {!selectMode && !reorderMode && <div style={{ ...S.addCard, borderColor: T.accent, borderWidth: 1.5, boxShadow: `0 1px 6px ${dark ? "rgba(63,174,140,0.15)" : "rgba(19,106,85,0.12)"}` }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input ref={itemInputRef} style={{ ...S.addInput, fontWeight: 500 }} placeholder="＋ Add an item…" value={newItemText}
                  onChange={(e) => setNewItemText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />
                <button style={S.addBtn} onClick={addItem}>Add</button>
              </div>
              <button
                style={{ background: "none", border: "none", color: T.accent, fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "6px 2px 0", alignSelf: "flex-start" }}
                onClick={() => setBulkOpen((v) => !v)}>
                {bulkOpen ? "× Close bulk add" : "≣ Paste many at once"}
              </button>
              {bulkOpen && (
                <div style={{ marginTop: 6 }}>
                  <textarea
                    style={{ ...S.input, width: "100%", minHeight: 120, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" }}
                    placeholder={"One item per line, e.g.\nMilk\nEggs\nBread\n\nPaste a whole list here and each line becomes an item."}
                    value={bulkText} onChange={(e) => setBulkText(e.target.value)} autoFocus />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                    <button style={{ ...S.addBtn, opacity: bulkText.trim() ? 1 : 0.5 }} disabled={!bulkText.trim()} onClick={addBulk}>
                      Add {bulkText.split("\n").map((s) => s.trim()).filter(Boolean).length || ""} item{bulkText.split("\n").map((s) => s.trim()).filter(Boolean).length === 1 ? "" : "s"}
                    </button>
                    <span style={{ fontSize: 12, color: T.mute }}>
                      {newItemSection.trim() ? `→ into "${newItemSection.trim()}"` : "→ no section (set one below to group them)"}
                    </span>
                  </div>
                </div>
              )}
              {(() => {
                const ex = listExtras(activeList);
                return (
                  <>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: T.mute, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 10 }}>Details (optional)</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 4, opacity: 0.85 }}>
                      <input style={{ ...S.input, flex: 2 }} list="listsections" placeholder="Section (optional)"
                        value={newItemSection} onChange={(e) => setNewItemSection(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />
                      {ex.includes("qty") && <input style={{ ...S.input, flex: 1 }} placeholder="Qty" inputMode="decimal"
                        value={newItemQty} onChange={(e) => setNewItemQty(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />}
                      {ex.includes("unit") && <input style={{ ...S.input, flex: 1.2 }} list="listunits" placeholder="Unit"
                        value={newItemUnit} onChange={(e) => setNewItemUnit(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />}
                      {ex.includes("price") && <input style={{ ...S.input, flex: 1.2 }} placeholder="Price"
                        value={newItemPrice} onChange={(e) => setNewItemPrice(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />}
                    </div>
                    {ex.includes("url") && (
                      <input style={{ ...S.input, marginTop: 8 }} type="url" placeholder="Link (https://…)"
                        value={newItemUrl} onChange={(e) => setNewItemUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />
                    )}
                  </>
                );
              })()}
              <datalist id="listsections">
                {Array.from(new Set(activeList.items.map((i) => i.section).filter(Boolean))).map((s) => <option key={s} value={s} />)}
              </datalist>
              <datalist id="listunits">
                {Array.from(new Set(["kg", "g", "L", "ml", "pcs", "pack", "box", "dozen", ...activeList.items.map((i) => i.unit).filter(Boolean)])).map((u) => <option key={u} value={u} />)}
              </datalist>
            </div>}
          </>
        )}

        {/* ---------- DASHBOARD VIEW ---------- */}
        {view === "Dashboard" && (
          <>
            <div style={S.statGrid}>
              <div style={{ ...S.statCard(T.danger), cursor: "pointer" }} title="View overdue tasks"
                onClick={() => goToTasksGroup({ groupKeys: ["Overdue"] })}>
                <div style={{ ...S.statNum, color: stats.overdue ? T.danger : "inherit" }}>{stats.overdue}</div>
                <div style={S.statLbl}>Overdue</div>
              </div>
              <div style={{ ...S.statCard(T.accent), cursor: "pointer" }} title="View tasks due today"
                onClick={() => goToTasksGroup({ groupKeys: ["Today"] })}>
                <div style={S.statNum}>{stats.dueToday}</div>
                <div style={S.statLbl}>Due today</div>
              </div>
              <div style={{ ...S.statCard(T.amber), cursor: "pointer" }} title="View tasks due in the next 7 days"
                onClick={() => goToTasksGroup({ groupKeys: ["Today", "Tomorrow", "This week"] })}>
                <div style={S.statNum}>{stats.week}</div>
                <div style={S.statLbl}>Due in next 7 days</div>
              </div>
              <div style={{ ...S.statCard(T.line), cursor: "pointer" }} title="View tasks completed this week"
                onClick={() => goToTasksGroup({ status: "Done" })}>
                <div style={S.statNum}>{stats.doneWeek}</div>
                <div style={S.statLbl}>Completed this week</div>
              </div>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Load — next 7 days</h3>
              <div style={S.colWrap}>
                {stats.next7.map((d) => (
                  <div key={d.date} style={S.col}>
                    <span style={{ fontSize: 11, color: T.mute }}>{d.count || ""}</span>
                    <div style={S.colBar((d.count / maxNext7) * 100, d.date === today ? T.accent : T.tagBg === "#EFEEE7" ? "#CFCEC2" : "#3E453E")} />
                    <span style={S.colLbl}>{d.date === today ? "Today" : dayLabel(d.date)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Completed — last 7 days</h3>
              <div style={S.colWrap}>
                {stats.last7.map((d) => (
                  <div key={d.date} style={S.col}>
                    <span style={{ fontSize: 11, color: T.mute }}>{d.count || ""}</span>
                    <div style={S.colBar((d.count / maxLast7) * 100, T.accent)} />
                    <span style={S.colLbl}>{d.date === today ? "Today" : dayLabel(d.date)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Open tasks by category</h3>
              {stats.catRows.length === 0 && <div style={{ color: T.mute, fontSize: 14 }}>No open tasks.</div>}
              {stats.catRows.map(([cat, n]) => (
                <div key={cat} style={{ ...S.barRow, cursor: "pointer" }} title={`View open "${cat}" tasks`}
                  onClick={() => goToTasksGroup({ cat })}>
                  <span style={S.barLbl}>{cat}</span>
                  <div style={S.barTrack}><div style={S.barFill((n / maxCat) * 100, cat === "Uncategorized" ? T.mute : dotColor(cat, dark, colorMap))} /></div>
                  <span style={S.barVal}>{n}</span>
                </div>
              ))}
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Unscheduled</h3>
              {Object.entries(stats.buckets).map(([b, n]) => (
                <div key={b} style={{ ...S.barRow, cursor: "pointer" }} title={`View "${b}" tasks`}
                  onClick={() => goToTasksGroup({ groupKeys: [b] })}>
                  <span style={S.barLbl}>{b}</span>
                  <div style={S.barTrack}><div style={S.barFill((n / Math.max(1, ...Object.values(stats.buckets))) * 100, T.amber)} /></div>
                  <span style={S.barVal}>{n}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ---------- SETTINGS VIEW ---------- */}
        {view === "Settings" && (
          <>
            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Appearance</h3>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 14.5 }}>Dark mode</span>
                <button style={S.footBtn} onClick={() => setTheme(!dark)}>{dark ? "On · switch to light" : "Off · switch to dark"}</button>
              </div>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>List categories</h3>
              <p style={{ fontSize: 12.5, color: T.mute, margin: "0 0 10px", lineHeight: 1.5 }}>Group your lists on the Lists screen. Removing a category here just moves its lists to “Other” — nothing is deleted.</p>
              {listCats.length === 0 && <div style={{ color: T.mute, fontSize: 14, marginBottom: 8 }}>No categories yet — add a few below.</div>}
              {listCats.map((c) => (
                <div key={c} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.line}` }}>
                  <span style={{ flex: 1, fontSize: 14.5 }}>{c}</span>
                  <span style={S.count}>{lists.filter((l) => (l.category || "") === c).length}</span>
                  <button style={S.iconBtn} onClick={() => removeListCat(c)} title="Remove from the set">✕</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input style={S.addInput} placeholder="Add a category (e.g. Work)…" value={newCatInput}
                  onChange={(e) => setNewCatInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addListCat()} />
                <button style={S.addBtn} onClick={addListCat}>Add</button>
              </div>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Categories</h3>
              {categories.filter((c) => c !== "All").length === 0 && <div style={{ color: T.mute, fontSize: 14 }}>No categories yet — they appear here once you use them on tasks.</div>}
              {categories.filter((c) => c !== "All").map((c) => (
                <div key={c} style={{ borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                    <button title="Pick color" onClick={() => setPickerFor(pickerFor === c ? null : c)}
                      style={{ width: 18, height: 18, borderRadius: 9, border: "none", cursor: "pointer", background: dotColor(c, dark, colorMap), outline: pickerFor === c ? `2px solid ${T.accent}` : "none", outlineOffset: 2 }} />
                    <span style={{ flex: 1, fontSize: 14.5 }}>{c}</span>
                    <span style={{ ...S.count }}>{tasks.filter((t) => t.category === c).length}</span>
                    <button style={S.iconBtn} onClick={() => renameField("category", c)} title="Rename">✎</button>
                    <button style={S.iconBtn} onClick={() => deleteField("category", c)} title="Remove">✕</button>
                  </div>
                  {pickerFor === c && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 0 12px 2px" }}>
                      {HUES.map((h, i) => (
                        <button key={h} onClick={() => setColor(c, i)} title={`Color ${i + 1}`}
                          style={{ width: 26, height: 26, borderRadius: 13, cursor: "pointer",
                            background: `hsl(${h},${dark ? 50 : 60}%,${dark ? 62 : 45}%)`,
                            border: colorMap[c] === i ? `2px solid ${T.ink}` : `2px solid transparent` }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <p style={{ fontSize: 12.5, color: T.mute, margin: "10px 0 0" }}>Colors are assigned automatically and kept distinct. Tap a dot to pick a different color. Rename applies to every task using it.</p>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Sub categories</h3>
              {subSuggestions.length === 0 && <div style={{ color: T.mute, fontSize: 14 }}>No sub categories yet.</div>}
              {subSuggestions.map((c) => (
                <div key={c} style={{ borderBottom: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                    <button title="Pick color" onClick={() => setPickerFor(pickerFor === "sub:" + c ? null : "sub:" + c)}
                      style={{ width: 18, height: 18, borderRadius: 9, border: "none", cursor: "pointer", background: dotColor(c, dark, colorMap), outline: pickerFor === "sub:" + c ? `2px solid ${T.accent}` : "none", outlineOffset: 2 }} />
                    <span style={{ flex: 1, fontSize: 14.5 }}>{c}</span>
                    <span style={{ ...S.count }}>{tasks.filter((t) => t.subCategory === c).length}</span>
                    <button style={S.iconBtn} onClick={() => renameField("subCategory", c)} title="Rename">✎</button>
                    <button style={S.iconBtn} onClick={() => deleteField("subCategory", c)} title="Remove">✕</button>
                  </div>
                  {pickerFor === "sub:" + c && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 0 12px 2px" }}>
                      {HUES.map((h, i) => (
                        <button key={h} onClick={() => setColor(c, i)} title={`Color ${i + 1}`}
                          style={{ width: 26, height: 26, borderRadius: 13, cursor: "pointer",
                            background: `hsl(${h},${dark ? 50 : 60}%,${dark ? 62 : 45}%)`,
                            border: colorMap[c] === i ? `2px solid ${T.ink}` : `2px solid transparent` }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Account &amp; sync</h3>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{session ? session.name : "Not signed in"}</div>
                  <div style={{ fontSize: 12.5, color: T.mute }}>{session ? (session.role === "owner" ? "Owner" : "Member") : ""}</div>
                </div>
                {session && <button style={S.footBtn} onClick={logout}>Log out</button>}
              </div>
              <p style={{ fontSize: 12.5, color: T.mute, margin: "0 0 10px" }}>{lastSync ? `Last synced: ${lastSync}` : "Not synced yet."}</p>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 14 }}>Auto-sync (push ~8s after changes)</span>
                <button style={S.footBtn} onClick={() => { const v = !autoSync; setAutoSync(v); savePrefs({ autoSync: v }); }}>{autoSync ? "On" : "Off"}</button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={S.addBtn} onClick={syncPush} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
                <button style={S.footBtn} onClick={syncPull} disabled={syncing}>Refresh from server</button>
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
                <label style={S.label}>Server URL</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={S.addInput} placeholder="https://your-worker.workers.dev"
                    value={urlDraft || workerUrl} onChange={(e) => setUrlDraft(e.target.value)} />
                  <button style={S.addBtn} onClick={() => {
                    const u = (urlDraft || workerUrl).trim().replace(/\/+$/, "");
                    if (!/^https?:\/\//.test(u)) { flash("URL should start with https://"); return; }
                    setWorkerUrl(u); savePrefs({ workerUrl: u }); setUrlDraft(""); pulledOnce.current = false;
                    flash("Server URL saved");
                  }}>Save</button>
                </div>
                <p style={{ fontSize: 12, color: (workerUrl.includes("REPLACE-WITH") ? T.danger : T.mute), margin: "6px 0 0", lineHeight: 1.5 }}>
                  {workerUrl.includes("REPLACE-WITH")
                    ? "⚠ Not set yet — paste your Cloudflare Worker URL here and Save. This is almost certainly why sync isn't working."
                    : "Set once and it sticks, even when you redeploy the app."}
                </p>
              </div>
              <p style={{ fontSize: 12.5, color: T.mute, margin: "12px 0 0", lineHeight: 1.5 }}>
                Your tasks are private to you. Lists you own or that others share with you sync automatically.
              </p>
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Data</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={S.footBtn} onClick={() => setModal("export")}>Export CSV</button>
                <button style={S.footBtn} onClick={() => setModal("import")}>Import CSV</button>
                <button style={S.footBtn} onClick={clearDone}>Clear completed</button>
                <button style={{ ...S.footBtn, color: T.danger, borderColor: T.danger }} onClick={deleteAll}>Delete all tasks</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* floating add button (Tasks view) */}
      {view === "Tasks" && !addOpen && !editing && (
        <button style={S.fab} onClick={() => { setAddOpen(true); setAddFocus(true); }} aria-label="Add task" title="Add task">＋</button>
      )}

      {/* bottom navigation */}
      <div style={{ ...S.footer, justifyContent: "space-around", padding: "6px 8px calc(6px + env(safe-area-inset-bottom))" }}>
        {NAV.map((v) => (
          <button key={v} onClick={() => switchView(v)}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 10px",
              color: view === v ? T.accent : T.mute, fontWeight: view === v ? 700 : 500 }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>{NAV_ICON[v]}</span>
            <span style={{ fontSize: 11 }}>{v}</span>
          </button>
        ))}
      </div>

      {toast && (
        <div style={{ ...S.toast, display: "flex", alignItems: "center", gap: 12 }}>
          {typeof toast === "object" ? toast.msg : toast}
          {typeof toast === "object" && (
            <button style={{ background: "none", border: "none", color: T.accent, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5 }}
              onClick={() => { toast.fn(); setToast(""); }}>Undo</button>
          )}
        </div>
      )}

      {/* export modal */}
      {modal === "export" && (
        <div style={S.modalBg} onClick={() => setModal(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, fontFamily: "'Archivo', sans-serif" }}>Export to Google Sheets</h3>
            <p style={{ fontSize: 14, color: T.mute }}>Download the CSV and import it in Sheets (File → Import), or copy the text and paste into a sheet, then Data → Split text to columns.</p>
            <textarea ref={csvRef} style={S.textarea} readOnly value={toCSV(tasks)} />
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button style={S.addBtn} onClick={downloadCSV}>Download CSV</button>
              <button style={S.footBtn} onClick={copyCSV}>{copied ? "Copied ✓" : "Copy"}</button>
              <button style={S.footBtn} onClick={() => setModal("import")}>Import…</button>
              <button style={{ ...S.footBtn, marginLeft: "auto" }} onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* import modal */}
      {modal === "import" && (
        <div style={S.modalBg} onClick={() => setModal(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, fontFamily: "'Archivo', sans-serif" }}>Import CSV</h3>
            <p style={{ fontSize: 14, color: T.mute }}>Header row: Task, Category, Sub Category, Due Date, Due Time, Reminder Date, Reminder Time, Recurrence, Bucket, Status, Created, Completed. Dates YYYY-MM-DD, times HH:MM.</p>
            <textarea style={S.textarea} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste CSV here…" />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button style={S.addBtn} onClick={doImport}>Import</button>
              <button style={{ ...S.footBtn, marginLeft: "auto" }} onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* edit modal */}
      {editing && (
        <div style={S.modalBg} onClick={() => setEditing(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, fontFamily: "'Archivo', sans-serif" }}>Edit task</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={S.label}>Task</label>
              <input style={S.input} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={S.label}>Notes / items</label>
              <textarea style={{ ...S.textarea, height: 90 }} value={editing.notes || ""} placeholder="Anything extra — items from a list land here"
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {editFields(editing, setEditing)}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button style={S.addBtn} onClick={saveEdit}>Save changes</button>
              <button style={{ ...S.footBtn, marginLeft: "auto" }} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* share list modal */}
      {shareFor && (() => {
        const l = lists.find((x) => x.id === shareFor);
        if (!l) return null;
        const others = members.filter((m) => !session || m !== session.name);
        return (
          <div style={S.modalBg} onClick={() => setShareFor(null)}>
            <div style={S.modal} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0, fontFamily: "'Archivo', sans-serif" }}>Share "{l.name}"</h3>
              <p style={{ fontSize: 14, color: T.mute }}>Anyone you pick can view and edit this list's items. Only you can rename, re-share, or delete it. Changes sync on the next push.</p>
              {others.length === 0 && <div style={S.empty}>No other users yet. Add them in the Worker's USERS setting.</div>}
              <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                {others.map((m) => {
                  const on = (l.sharedWith || []).includes(m);
                  return (
                    <button key={m} onClick={() => toggleShare(l.id, m)}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                        border: `1px solid ${on ? T.accent : T.line}`, background: on ? T.accentSoft : T.card,
                        color: T.ink, borderRadius: 10, padding: "10px 14px", cursor: "pointer", fontFamily: "inherit", fontSize: 15 }}>
                      <span>{m}</span>
                      <span style={{ color: on ? T.accent : T.mute, fontWeight: 600 }}>{on ? "Shared ✓" : "Share"}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button style={S.addBtn} onClick={() => { setShareFor(null); syncPush(); }}>Done &amp; sync</button>
                <button style={{ ...S.footBtn, marginLeft: "auto" }} onClick={() => setShareFor(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
