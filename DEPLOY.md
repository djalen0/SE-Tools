# Deploying the Pinning Sheet Editor

This app is a small Flask server plus a static frontend, packaged with a
Dockerfile. It holds one shared "job" in memory (the pinning sheet currently
being edited) and persists it to `data/current_job.json` on every save, so
the whole crew hits the same URL and sees the same sheet -- one person
edits at a time, everyone else can open the same link read-only.

These steps use Render, since it deploys a Dockerfile with no extra
config. Fly.io works almost identically (see the note at the end) if you'd
rather use that instead.

## 1. Put the project in a GitHub repo

Render deploys from a git repo, not a local folder upload.

1. Create a new (private is fine) repo on GitHub.
2. From this project's folder:
   ```
   git init
   git add .
   git commit -m "Pinning sheet editor webapp"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

## 2. Create the Render web service

1. Go to https://dashboard.render.com -> **New** -> **Web Service**.
2. Connect your GitHub account and pick the repo you just pushed.
3. Render will detect the `Dockerfile` automatically -- leave **Environment**
   set to **Docker**.
4. Name it whatever you like (e.g. `pinning-sheets`). Region: pick whatever's
   closest to your crew.
5. **Instance type**: the free tier works for trying this out, but read the
   persistence note below before relying on it for a real show.
6. Click **Create Web Service**. The first build takes a few minutes
   (installing pdfplumber/openpyxl); Render gives you a live build log.

When it finishes, Render gives you a URL like
`https://pinning-sheets.onrender.com` -- that's the link the whole crew uses.
Share `https://pinning-sheets.onrender.com/?view=1` instead for a read-only
copy (view-only disables editing, upload, and save, but Export still works).

## 2a. About the free tier (read this before a real show)

Render's free web services:
- **Spin down after 15 minutes of no traffic** and take 30-60 seconds to
  wake back up on the next request -- the first person to open the link
  after a lull will see a slow load, not a broken app.
- **Cannot attach a persistent disk.** This app writes `data/current_job.json`
  to its own local disk on every save so an in-progress sheet survives a
  restart -- on the free tier, that file (and the color/numbering settings
  sidecar) disappears every time the service spins down or redeploys.

For anything beyond kicking the tires, upgrade the service to a paid
instance (Starter, ~$7/mo at time of writing) and attach a persistent disk
mounted at `/app/data` (Render's dashboard -> your service -> **Disks** ->
**Add Disk**, $0.25/GB/mo). That keeps the current job and your color/Hi-D
settings across restarts and redeploys. Without it, everything still works
during a single continuous session -- it just won't survive the server
restarting.

## 3. Using the app

- Open the URL, click **Upload sheet**, and pick a `.pdf` or `.txt` pinning
  sheet export.
- Edit circuit numbers, toggle circuit colors / breakout (Hi-D) numbering
  from the two settings panels, adjust cards-per-row.
- **Save** persists the current job (and settings) to disk.
- **Export to Excel** downloads the finished `*_worksheet.xlsx`, built from
  the same `design.xlsx` template baked into this app.
- Uploading a *new* file replaces the shared job for everyone -- there's no
  per-user copy. If someone else is mid-edit, coordinate before uploading
  over their work (same as you would sharing one paper pinning sheet).

## 4. Installing it on a phone (PWA)

The app ships a web manifest + service worker, so it's installable to a
home screen without an app store:

- **iOS (Safari)**: open the site -> Share icon -> **Add to Home Screen**.
- **Android (Chrome)**: open the site -> menu (⋮) -> **Add to Home screen**
  (Chrome may also prompt automatically).

This gives an app icon and a standalone window (no browser address bar) --
it is *not* a native iOS/Android app, just this same web app installed like
one. It still needs a network connection to your Render URL; it does not
work fully offline (the job lives on the server, on purpose, so everyone
sees the same data).

If you eventually want a real App Store / Play Store listing, that's a
separate, larger project on top of this (wrapping the same web app with
Capacitor or similar, plus developer accounts and store review) -- worth
doing only once you know this workflow is the one you want to keep using.

## 5. Updating the app later

Push to the `main` branch on GitHub; Render redeploys automatically. If you
attached a persistent disk (step 2a), the current job and settings survive
the redeploy; if you didn't, the next person to open the link starts from
the empty-state screen and has to re-upload.

## Alternative: Fly.io

Fly.io deploys the same Dockerfile with its CLI instead of a git-connected
dashboard:

```
fly launch          # detects the Dockerfile, asks a few setup questions
fly volumes create data --size 1     # persistent disk, same purpose as step 2a
fly deploy
```
Mount that volume at `/app/data` when prompted (or add a `[mounts]` block
to the generated `fly.toml` pointing at `/app/data`). Fly's free allowance
and always-on behavior differ from Render's -- check https://fly.io/docs/about/pricing/
for current details before committing to it for a real show.

## Notes on the architecture (why some things work the way they do)

- **One shared job, no login.** This matches how the tool is actually used
  -- one person edits while everyone else waits their turn or looks at a
  `?view=1` link. There's no concurrent-edit merging: if two people save
  within moments of each other, the second save wins, the same risk as two
  people editing one shared spreadsheet tab.
- **Single gunicorn worker.** The Dockerfile intentionally runs one worker
  process (`--workers 1`) because the shared job lives in that process's
  memory. Running more workers would silently create multiple independent
  copies of "the current job" that drift apart. If this ever needs to
  support multiple simultaneous independent editors, the state needs to
  move to a real datastore first (Redis, Postgres, etc.) -- a bigger change
  than this deploy guide covers.
