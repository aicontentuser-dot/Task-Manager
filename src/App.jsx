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

/* ---------- storage ---------- */
const STORE_KEY = "taskmanager:tasks-v1"; // same key: existing tasks carry over
const PREFS_KEY = "taskmanager:prefs-v1";
const LISTS_KEY = "taskmanager:lists-v1";

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
const advance = (s, r) =>
  r === "daily" ? addDays(s, 1) : r === "weekly" ? addDays(s, 7)
  : r === "monthly" ? addMonths(s, 1) : r === "yearly" ? addMonths(s, 12) : s;

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
const HEADERS = ["Task","Category","Sub Category","Due Date","Due Time","Reminder Date","Reminder Time","Recurrence","Bucket","Status","Created","Completed"];
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (ts) => [HEADERS.join(","), ...ts.map((t) =>
  [t.title, t.category, t.subCategory, t.dueDate, t.dueTime, t.reminderDate, t.reminderTime, t.recurrence, t.bucket, t.done ? "Done" : "Open", t.createdAt, t.completedAt].map(esc).join(",")
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
    tagBg: "#EFEEE7", overlay: "rgba(32,36,31,0.45)", shadow: "0 1px 2px rgba(32,36,31,0.05)",
    footBg: "rgba(247,246,241,0.95)", rowAlt: "#FBFAF6",
  },
  dark: {
    bg: "#151815", card: "#1E221E", ink: "#E9E8E1", mute: "#9AA096", line: "#343A34",
    accent: "#3FAE8C", accentSoft: "#1E332C", danger: "#E06A4A", dangerSoft: "#3A251F",
    amber: "#D9A644", amberSoft: "#332B18",
    tagBg: "#2A2F2A", overlay: "rgba(0,0,0,0.6)", shadow: "0 1px 3px rgba(0,0,0,0.4)",
    footBg: "rgba(21,24,21,0.95)", rowAlt: "#1A1E1A",
  },
};

const BUCKETS = ["Inbox", "Next week", "Someday"];

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
const RECURRENCES = [["", "No repeat"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["yearly", "Yearly"]];
const REC_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
const NAV = ["Tasks", "Lists", "Dashboard", "Settings"];
const NAV_ICON = { Tasks: "☑", Lists: "☰", Dashboard: "▤", Settings: "⚙" };

export default function TaskManager() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dark, setDark] = useState(false);
  const [view, setView] = useState("Tasks");
  const [taskMode, setTaskMode] = useState("List");
  const [lists, setLists] = useState([]);
  const [activeListId, setActiveListId] = useState(null);
  const [newListName, setNewListName] = useState("");
  const [newItemText, setNewItemText] = useState("");
  const [newItemSection, setNewItemSection] = useState("");
  const blank = { category: "", subCategory: "", dueDate: "", dueTime: "", reminderDate: "", reminderTime: "", recurrence: "", bucket: "Inbox" };
  const [newTitle, setNewTitle] = useState("");
  const [draft, setDraft] = useState(blank);
  const [addFocus, setAddFocus] = useState(false);
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
  const [scriptUrl, setScriptUrl] = useState("");
  const [lastSync, setLastSync] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [catColors, setCatColors] = useState({});
  const [pickerFor, setPickerFor] = useState(null);
  const csvRef = useRef(null);
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
        if (!cancelled && r?.value) setTasks(JSON.parse(r.value).map((t) => ({ recurrence: "", bucket: "Inbox", completedAt: "", nextId: "", ...t })));
      } catch (e) { /* fresh start */ }
      try {
        const p = await withTimeout(store.get(PREFS_KEY), 2500);
        if (!cancelled && p?.value) {
          const prefs = JSON.parse(p.value);
          setDark(prefs.dark === true);
          if (NAV.includes(prefs.view)) setView(prefs.view);
          else if (prefs.view === "List" || prefs.view === "Table") { setView("Tasks"); setTaskMode(prefs.view); }
          if (prefs.taskMode === "List" || prefs.taskMode === "Table") setTaskMode(prefs.taskMode);
          if (prefs.scriptUrl) setScriptUrl(prefs.scriptUrl);
          if (prefs.catColors) setCatColors(prefs.catColors);
          if (prefs.lastSync) setLastSync(prefs.lastSync);
        }
      } catch (e) { /* defaults */ }
      try {
        const l = await withTimeout(store.get(LISTS_KEY), 2500);
        if (!cancelled && l?.value) setLists(JSON.parse(l.value));
      } catch (e) { /* no lists yet */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const persist = async (next) => {
    setTasks(next);
    try { await store.set(STORE_KEY, JSON.stringify(next)); } catch (e) { console.error(e); }
  };
  const savePrefs = async (patch) => {
    const p = { dark, view, taskMode, scriptUrl, lastSync, catColors, ...patch };
    try { await store.set(PREFS_KEY, JSON.stringify(p)); } catch (e) { console.error(e); }
  };
  const setTheme = (v) => { setDark(v); savePrefs({ dark: v }); };
  const switchView = (v) => { setView(v); savePrefs({ view: v }); };
  const switchTaskMode = (m) => { setTaskMode(m); savePrefs({ taskMode: m }); };
  const persistLists = async (next) => {
    setLists(next);
    try { await store.set(LISTS_KEY, JSON.stringify(next)); } catch (e) { console.error(e); }
  };
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2200); };

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
  }, [tasks, catColors]);

  const q = search.trim().toLowerCase();
  const visible = tasks.filter((t) =>
    (filterCat === "All" || t.category === filterCat) &&
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
    { key: "Today", items: dated.filter((t) => t.dueDate === today) },
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
  const addTask = () => {
    const title = newTitle.trim();
    if (!title) return;
    persist([{ id: uid(), title, done: false, createdAt: today, completedAt: "", ...draft }, ...tasks]);
    setNewTitle(""); setDraft(blank); setMoreFields(false);
    flash("Task added");
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
          flash(`Repeats ${REC_LABEL[t.recurrence].toLowerCase()} — next: ${fmtDate(nextDue)}`);
        }
      }
      persist(next);
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

  const remove = (id) => persist(tasks.filter((t) => t.id !== id));
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
    }));
    persist([...imported, ...tasks]);
    setImportText(""); setModal(null);
    flash(`Imported ${imported.length} task${imported.length === 1 ? "" : "s"}`);
  };

  /* ---------- Google Sheets sync (via Apps Script web app) ---------- */
  const syncPush = async () => {
    if (!scriptUrl.trim()) { switchView("Settings"); flash("Paste your Apps Script URL first"); return; }
    setSyncing(true);
    try {
      // text/plain avoids the CORS preflight that Apps Script can't answer
      const res = await fetch(scriptUrl.trim(), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ mode: "push", tasks, lists }),
      });
      const data = await res.json();
      if (data.ok) {
        const now = new Date().toLocaleString();
        setLastSync(now); savePrefs({ lastSync: now });
        flash(`Synced ${data.count} tasks to your sheet`);
      } else throw new Error(data.error || "Script returned an error");
    } catch (e) {
      flash("Sync failed — see Settings for setup help");
      console.error(e);
    } finally { setSyncing(false); }
  };

  const syncPull = async () => {
    if (!scriptUrl.trim()) { switchView("Settings"); flash("Paste your Apps Script URL first"); return; }
    if (!window.confirm("Replace all tasks in this app with the contents of your sheet?")) return;
    setSyncing(true);
    try {
      const res = await fetch(scriptUrl.trim() + "?mode=pull");
      const data = await res.json();
      if (data.ok && Array.isArray(data.tasks)) {
        const pulled = data.tasks.map((t) => ({
          id: t.id || uid(), title: t.title || "(untitled)",
          category: t.category || "", subCategory: t.subCategory || "",
          dueDate: t.dueDate || "", dueTime: t.dueTime || "",
          reminderDate: t.reminderDate || "", reminderTime: t.reminderTime || "",
          recurrence: (t.recurrence || "").toLowerCase(), bucket: t.bucket || "Inbox",
          done: t.done === true || String(t.status).toLowerCase() === "done",
          createdAt: t.createdAt || today, completedAt: t.completedAt || "",
        }));
        persist(pulled);
        if (Array.isArray(data.lists)) persistLists(data.lists);
        const now = new Date().toLocaleString();
        setLastSync(now); savePrefs({ lastSync: now });
        flash(`Pulled ${pulled.length} tasks from your sheet`);
        setModal(null);
      } else throw new Error(data.error || "Bad response");
    } catch (e) {
      flash("Pull failed — see Settings for setup help");
      console.error(e);
    } finally { setSyncing(false); }
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
  useEffect(() => { setNewItemText(""); setNewItemSection(""); }, [activeListId]);

  /* ---------- lists ---------- */
  const activeList = lists.find((l) => l.id === activeListId) || null;
  const addList = () => {
    const name = newListName.trim();
    if (!name) return;
    const l = { id: uid(), name, items: [], createdAt: today };
    persistLists([l, ...lists]);
    setNewListName("");
    setActiveListId(l.id);
  };
  const renameList = (id) => {
    const l = lists.find((x) => x.id === id);
    const nn = window.prompt("Rename list", l ? l.name : "");
    if (!nn || !nn.trim()) return;
    persistLists(lists.map((x) => (x.id === id ? { ...x, name: nn.trim() } : x)));
  };
  const deleteList = (id) => {
    const l = lists.find((x) => x.id === id);
    if (!window.confirm(`Delete list "${l ? l.name : ""}" and its items?`)) return;
    persistLists(lists.filter((x) => x.id !== id));
    if (activeListId === id) setActiveListId(null);
  };
  const addItem = () => {
    const text = newItemText.trim();
    if (!text || !activeList) return;
    const section = newItemSection.trim();
    persistLists(lists.map((l) => (l.id === activeList.id ? { ...l, items: [...l.items, { id: uid(), text, section, checked: false }] } : l)));
    setNewItemText(""); // keep the section filled — items are usually added in batches per section
  };
  const editItemSection = (listId, itemId, current) => {
    const s = window.prompt("Section for this item (blank for none):", current || "");
    if (s === null) return;
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, section: s.trim() } : i)) } : l)));
  };
  const sectionsOf = (list) => {
    const map = {}, order = [];
    list.items.forEach((it) => {
      const s = it.section || "";
      if (!(s in map)) { map[s] = []; order.push(s); }
      map[s].push(it);
    });
    order.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
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
    </style></head><body>
    <h1>${esc(list.name)}</h1><div class="d">${new Date().toLocaleDateString()}</div>
    ${sectionsOf(list).map(([s, items]) =>
      `${s ? `<h2>${esc(s)}</h2>` : ""}<ul>${items.map((i) => `<li class="${i.checked ? "c" : ""}">${i.checked ? "☑" : "☐"} ${esc(i.text)}</li>`).join("")}</ul>`
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
  const deleteItem = (listId, itemId) =>
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l)));
  const resetList = (listId) => {
    if (!window.confirm("Uncheck all items? (Great for reusing this list.)")) return;
    persistLists(lists.map((l) => (l.id === listId ? { ...l, items: l.items.map((i) => ({ ...i, checked: false })) } : l)));
    flash("List reset — ready to reuse");
  };
  const promoteItem = (list, item) => {
    persist([{
      id: uid(), title: item.text, done: false, createdAt: today, completedAt: "", nextId: "",
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
    card: (done) => ({ background: T.card, border: `1px solid ${T.line}`, borderRadius: 12, padding: "10px 12px", marginBottom: 8, display: "flex", gap: 10, alignItems: "flex-start", opacity: done ? 0.55 : 1, boxShadow: T.shadow }),
    check: (done) => ({ width: 22, height: 22, minWidth: 22, borderRadius: 7, border: `2px solid ${done ? T.accent : T.line}`, background: done ? T.accent : "transparent", color: "#fff", fontSize: 13, lineHeight: "18px", textAlign: "center", cursor: "pointer", marginTop: 2, padding: 0 }),
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
    footBtn: { border: `1px solid ${T.line}`, background: T.card, borderRadius: 10, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: T.ink },
    modalBg: { position: "fixed", inset: 0, background: T.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 20 },
    modal: { background: T.card, borderRadius: 16, padding: 18, width: "100%", maxWidth: 560, maxHeight: "85vh", overflowY: "auto", color: T.ink },
    textarea: { width: "100%", boxSizing: "border-box", height: 180, border: `1px solid ${T.line}`, borderRadius: 10, padding: 10, fontSize: 12.5, fontFamily: "ui-monospace, monospace", background: T.bg, color: T.ink },
    empty: { textAlign: "center", color: T.mute, padding: "50px 20px", fontSize: 15 },
    toast: { position: "fixed", bottom: 70, left: "50%", transform: "translateX(-50%)", background: T.ink, color: T.bg, borderRadius: 999, padding: "8px 18px", fontSize: 13.5, fontWeight: 500, zIndex: 30, whiteSpace: "nowrap" },
  };

  if (loading) return <div style={{ ...S.app, display: "flex", alignItems: "center", justifyContent: "center" }}>Loading your tasks…</div>;

  const showAddExtras = addFocus || newTitle.length > 0 || draft.dueDate || draft.category;

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
        <select style={S.input} value={obj.recurrence} onChange={(e) => set({ ...obj, recurrence: e.target.value })}>
          {RECURRENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div>
        <label style={S.label}>If no date, list under</label>
        <select style={S.input} value={obj.bucket} onChange={(e) => set({ ...obj, bucket: e.target.value })} disabled={!!obj.dueDate}>
          {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
    </>
  );

  const TaskCard = ({ t }) => (
    <div style={S.card(t.done)}>
      <button style={S.check(t.done)} onClick={() => toggle(t.id)} aria-label={t.done ? "Mark open" : "Mark done"}>{t.done ? "✓" : ""}</button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.title(t.done)}>{t.title}</div>
        <div style={S.meta}>
          {t.category && <span style={S.tag(catStyle(t.category, dark, colorMap).background, catStyle(t.category, dark, colorMap).color)}>{t.category}</span>}
          {t.subCategory && <span style={{ ...S.tag(catStyle(t.subCategory, dark, colorMap).background, catStyle(t.subCategory, dark, colorMap).color), boxShadow: `inset 0 0 0 1px ${dotColor(t.subCategory, dark, colorMap)}` }}>{t.subCategory}</span>}
          {t.dueDate && (
            <span style={S.tag(t.dueDate < today && !t.done ? T.dangerSoft : T.tagBg, t.dueDate < today && !t.done ? T.danger : T.mute)}>
              {fmtDate(t.dueDate)}{t.dueTime ? ` · ${fmtTime(t.dueTime)}` : ""}
            </span>
          )}
          {t.recurrence && <span style={S.tag(T.tagBg, T.mute)}>↻ {REC_LABEL[t.recurrence]}</span>}
          {t.reminderDate && <span style={S.tag(T.tagBg, T.mute)}>🔔 {fmtDate(t.reminderDate)}{t.reminderTime ? ` ${fmtTime(t.reminderTime)}` : ""}</span>}
        </div>
      </div>
      <button style={S.iconBtn} onClick={() => setEditing({ ...t })} aria-label="Edit">✎</button>
      <button style={S.iconBtn} onClick={() => remove(t.id)} aria-label="Delete">✕</button>
    </div>
  );

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
            <button style={S.round} onClick={syncPush} disabled={syncing} aria-label="Sync to Sheets" title="Sync to Sheets">{syncing ? "⧗" : "⇅"}</button>
            <button style={S.round} onClick={() => setTheme(!dark)} aria-label="Toggle dark mode">{dark ? "☀" : "☾"}</button>
          </div>
        </header>

        {/* add card — everything inline, no hidden tab */}
        {view === "Tasks" && (
          <div style={S.addCard}>
            <div style={S.addRow}>
              <input style={S.addInput} placeholder="Add a task…" value={newTitle}
                onFocus={() => setAddFocus(true)}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addTask()} />
              <button style={S.addBtn} onClick={addTask}>Add</button>
            </div>

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
                        <select style={S.input} value={draft.recurrence} onChange={(e) => setDraft({ ...draft, recurrence: e.target.value })}>
                          {RECURRENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
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
            {open.length === 0 && doneList.length === 0 && (
              <div style={S.empty}>{q || filtersActive ? "No tasks match. Try clearing search or filters." : "Nothing here yet. Add your first task above — it saves automatically."}</div>
            )}
            {groups.map((g) => (
              <section key={g.key}>
                <h2 style={S.gTitle(g.danger, g.bucket)}>{g.key} <span style={S.count}>{g.items.length}</span></h2>
                {g.items.map((t) => <TaskCard key={t.id} t={t} />)}
              </section>
            ))}
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
                    <td style={S.td}>{t.recurrence ? "↻ " + REC_LABEL[t.recurrence] : "—"}</td>
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
            <div style={{ ...S.addCard, display: "flex", gap: 8 }}>
              <input style={S.addInput} placeholder="New list (e.g. Grocery, Travel packing)…" value={newListName}
                onChange={(e) => setNewListName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addList()} />
              <button style={S.addBtn} onClick={addList}>Create</button>
            </div>
            {lists.length === 0 && <div style={S.empty}>No lists yet. Create reusable checklists — groceries, packing, routines — and promote items to Tasks when they need a date.</div>}
            {lists.map((l) => {
              const done = l.items.filter((i) => i.checked).length;
              return (
                <div key={l.id} style={{ ...S.card(false), cursor: "pointer", alignItems: "center" }} onClick={() => setActiveListId(l.id)}>
                  <span style={{ width: 18, height: 18, minWidth: 18, borderRadius: 9, background: dotColor(l.name, dark, colorMap) }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 600 }}>{l.name}</div>
                    <div style={{ fontSize: 12.5, color: T.mute, marginTop: 2 }}>{done}/{l.items.length} checked</div>
                  </div>
                  <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); renameList(l.id); }} title="Rename">✎</button>
                  <button style={S.iconBtn} onClick={(e) => { e.stopPropagation(); deleteList(l.id); }} title="Delete">✕</button>
                  <span style={{ color: T.mute, fontSize: 16 }}>›</span>
                </div>
              );
            })}
          </>
        )}

        {view === "Lists" && activeList && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <button style={S.footBtn} onClick={() => setActiveListId(null)}>‹ Lists</button>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 17 }}>{activeList.name}</div>
                <div style={{ fontSize: 12.5, color: T.mute }}>{activeList.items.filter((i) => i.checked).length}/{activeList.items.length} checked</div>
              </div>
              <button style={S.footBtn} onClick={() => printList(activeList)} title="Print this list">Print</button>
              <button style={S.footBtn} onClick={() => resetList(activeList.id)} title="Uncheck everything">Reset</button>
            </div>
            <div style={{ ...S.addCard }}>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={S.addInput} placeholder="Add an item…" value={newItemText}
                  onChange={(e) => setNewItemText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />
                <button style={S.addBtn} onClick={addItem}>Add</button>
              </div>
              <input style={{ ...S.input, marginTop: 8 }} list="listsections" placeholder="Section (optional, e.g. Vegetables) — stays filled for batch adding"
                value={newItemSection} onChange={(e) => setNewItemSection(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addItem()} />
              <datalist id="listsections">
                {Array.from(new Set(activeList.items.map((i) => i.section).filter(Boolean))).map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            {activeList.items.length === 0 && <div style={S.empty}>Empty list — add items above.</div>}
            <div style={{ marginTop: 12 }}>
              {sectionsOf(activeList).map(([sec, items]) => (
                <section key={sec || "__none"}>
                  {sec && (
                    <h2 style={S.gTitle(false, false)}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: dotColor(sec, dark, colorMap) }} />
                      {sec} <span style={S.count}>{items.filter((i) => !i.checked).length}/{items.length}</span>
                    </h2>
                  )}
                  {items.map((it) => (
                    <div key={it.id} style={{ ...S.card(it.checked), alignItems: "center" }}>
                      <button style={S.check(it.checked)} onClick={() => toggleItem(activeList.id, it.id)}>{it.checked ? "✓" : ""}</button>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 15, textDecoration: it.checked ? "line-through" : "none", overflowWrap: "anywhere" }}
                        onClick={() => editItemSection(activeList.id, it.id, it.section)} title="Tap to change section">{it.text}</div>
                      <button style={{ ...S.iconBtn, color: T.accent, fontWeight: 700 }} onClick={() => promoteItem(activeList, it)} title="Add to Tasks">➔ Task</button>
                      <button style={S.iconBtn} onClick={() => deleteItem(activeList.id, it.id)} title="Remove">✕</button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <p style={{ fontSize: 12.5, color: T.mute, marginTop: 12, lineHeight: 1.5 }}>➔ Task copies an item into your Tasks inbox — category "{activeList.name}", sub category from its section. The item stays here, so the list remains reusable. Tap an item’s text to change its section.</p>
          </>
        )}

        {/* ---------- DASHBOARD VIEW ---------- */}
        {view === "Dashboard" && (
          <>
            <div style={S.statGrid}>
              <div style={S.statCard(T.danger)}>
                <div style={{ ...S.statNum, color: stats.overdue ? T.danger : "inherit" }}>{stats.overdue}</div>
                <div style={S.statLbl}>Overdue</div>
              </div>
              <div style={S.statCard(T.accent)}>
                <div style={S.statNum}>{stats.dueToday}</div>
                <div style={S.statLbl}>Due today</div>
              </div>
              <div style={S.statCard(T.amber)}>
                <div style={S.statNum}>{stats.week}</div>
                <div style={S.statLbl}>Due in next 7 days</div>
              </div>
              <div style={S.statCard(T.line)}>
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
                <div key={cat} style={S.barRow}>
                  <span style={S.barLbl}>{cat}</span>
                  <div style={S.barTrack}><div style={S.barFill((n / maxCat) * 100, cat === "Uncategorized" ? T.mute : dotColor(cat, dark, colorMap))} /></div>
                  <span style={S.barVal}>{n}</span>
                </div>
              ))}
            </div>

            <div style={S.dashCard}>
              <h3 style={S.dashTitle}>Unscheduled</h3>
              {Object.entries(stats.buckets).map(([b, n]) => (
                <div key={b} style={S.barRow}>
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
              <h3 style={S.dashTitle}>Google Sheets sync</h3>
              <label style={S.label}>Apps Script web app URL</label>
              <input style={S.input} placeholder="https://script.google.com/macros/s/…/exec"
                value={scriptUrl} onChange={(e) => setScriptUrl(e.target.value)} onBlur={() => savePrefs({ scriptUrl })} />
              <p style={{ fontSize: 12.5, color: T.mute, margin: "6px 0 10px" }}>{lastSync ? `Last synced: ${lastSync}` : "Not synced yet."}</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={S.addBtn} onClick={() => { savePrefs({ scriptUrl }); syncPush(); }} disabled={syncing}>{syncing ? "Syncing…" : "Push to sheet"}</button>
                <button style={S.footBtn} onClick={() => { savePrefs({ scriptUrl }); syncPull(); }} disabled={syncing}>Pull from sheet</button>
              </div>
              <p style={{ fontSize: 12.5, color: T.mute, margin: "12px 0 0", lineHeight: 1.5 }}>
                Setup: Google Sheet → Extensions → Apps Script → paste the sync script → Deploy → Web app (execute as Me, access: Anyone) → paste the /exec URL above.
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

      {toast && <div style={S.toast}>{toast}</div>}

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
    </div>
  );
}
