/**
 * TASK MANAGER — GOOGLE SHEETS SYNC BACKEND
 * ==========================================
 * One-time setup (about 3 minutes):
 * 1. Open your Google Sheet (or create a new one).
 * 2. Extensions → Apps Script. Delete any code there, paste ALL of this file.
 * 3. Click Deploy → New deployment → gear icon → "Web app".
 *      - Description: task sync
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 4. Click Deploy, authorize it with your Google account, and copy the
 *    Web app URL (ends in /exec).
 * 5. Paste that URL into the task app: ⚙ (footer) → Apps Script web app URL.
 *
 * That's it. "Sync to Sheets" now writes your tasks into a tab called
 * "Tasks", and "Pull from sheet" reads them back.
 *
 * NOTE: if you later edit this script, you must Deploy → Manage deployments
 * → edit → new version, or the /exec URL keeps serving the old code.
 */

const SHEET_NAME = "Tasks";
const HEADERS = [
  "id", "Task", "Category", "Sub Category", "Due Date", "Due Time",
  "Reminder Date", "Reminder Time", "Recurrence", "Bucket",
  "Status", "Created", "Completed"
];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Force everything to text so dates/times don't get mangled by Sheets
function asText_(v) {
  return v === null || v === undefined ? "" : String(v);
}

/** PUSH: the app sends { mode: "push", tasks: [...] } as text/plain POST */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.mode !== "push" || !Array.isArray(body.tasks)) {
      return json_({ ok: false, error: "Expected { mode: 'push', tasks: [] }" });
    }
    const sh = getSheet_();
    sh.clearContents();
    const rows = body.tasks.map(function (t) {
      return [
        asText_(t.id), asText_(t.title), asText_(t.category), asText_(t.subCategory),
        asText_(t.dueDate), asText_(t.dueTime), asText_(t.reminderDate), asText_(t.reminderTime),
        asText_(t.recurrence), asText_(t.bucket),
        t.done ? "Done" : "Open", asText_(t.createdAt), asText_(t.completedAt)
      ];
    });
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    if (rows.length) {
      const range = sh.getRange(2, 1, rows.length, HEADERS.length);
      range.setNumberFormat("@"); // keep dates/times as plain text
      range.setValues(rows);
    }
    return json_({ ok: true, count: rows.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** PULL: the app calls GET <url>?mode=pull and gets { ok, tasks: [...] } */
function doGet(e) {
  try {
    if (!e.parameter || e.parameter.mode !== "pull") {
      return json_({ ok: true, info: "Task sync endpoint is live. Use ?mode=pull to read tasks." });
    }
    const sh = getSheet_();
    const values = sh.getDataRange().getDisplayValues();
    if (values.length < 2) return json_({ ok: true, tasks: [] });

    const tasks = values.slice(1).map(function (r) {
      return {
        id: r[0], title: r[1], category: r[2], subCategory: r[3],
        dueDate: r[4], dueTime: r[5], reminderDate: r[6], reminderTime: r[7],
        recurrence: r[8], bucket: r[9],
        done: String(r[10]).toLowerCase() === "done",
        createdAt: r[11], completedAt: r[12]
      };
    }).filter(function (t) { return t.title; });

    return json_({ ok: true, tasks: tasks });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}
