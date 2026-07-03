# Task Manager — deploy to Netlify

## Option A: GitHub + Netlify (no coding tools needed, works from a phone)
1. Create a free account at github.com if you don't have one.
2. New repository → name it (e.g. task-manager) → Create.
3. "Add file" → "Upload files" → upload EVERYTHING in this folder
   (package.json, vite.config.js, netlify.toml, index.html, and the src folder
   with main.jsx and App.jsx inside). Commit.
4. Go to app.netlify.com → Add new site → Import an existing project → GitHub
   → pick your repo. Netlify reads netlify.toml automatically. Click Deploy.
5. In ~1 minute you get a URL like https://yourname.netlify.app — that's your app.

## Option B: build locally, drag-and-drop
1. Install Node.js (nodejs.org), then in this folder run:
       npm install
       npm run build
2. Drag the generated "dist" folder onto https://app.netlify.com/drop

## Connect Google Sheets sync
1. Open your Google Sheet → Extensions → Apps Script.
2. Paste the contents of google-apps-script-sync.gs → Deploy → New deployment
   → Web app → Execute as: Me → Access: Anyone → Deploy → copy the /exec URL.
3. In your deployed app, tap the gear (⚙) in the footer, paste the URL, Done.
4. Tap "Sync to Sheets". Your tasks appear in a "Tasks" tab of the sheet.

## Notes
- Tasks are stored in the browser (localStorage), per device. Use
  "Sync to Sheets" on one device and "Pull from sheet" (in ⚙) on another
  to move tasks between devices.
- To add the app to your phone's home screen: open the Netlify URL in your
  browser → Share / menu → "Add to Home Screen". It behaves like an app.
