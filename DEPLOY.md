# Deploying the Pinning Sheet Editor

This app is a small Flask server plus a static frontend, packaged with a
Dockerfile. Content is organized Home -> Show -> Date, matching the
breadcrumb in the UI: each Show (e.g. a tour) has its own page listing its
Dates (e.g. specific show days), and each Date has its own URL and its own
pinning sheet, persisted to `data/shows/<show-slug>/dates/<date-slug>/job.json`
on every save. Within one Date it's still one shared sheet -- one person
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
`https://pinning-sheets.onrender.com` -- open it, add a Show, add a Date
under it, and that Date's own URL (e.g.
`https://pinning-sheets.onrender.com/detroit-fresh-tour/7-8-2026`) is what
the crew uses for that day. Add `?view=1` to any Date's URL for a read-only
copy (view-only disables editing, upload, and save, but Export still
works). There's no full sign-in page -- everyone unlocks the same lock icon
in the corner with the shared password below.

## 2a. Set the shared password

There are no user accounts -- everyone who opens a link signs in with one
shared password, meant to keep this small internal tool off the open
internet, not to distinguish who's who. Set these in Render's dashboard
under your service -> **Environment**:

- `APP_PASSWORD` -- the password itself. Without this set, it falls back to
  `pinning`, which is fine for kicking the tires but not for a real show.
- `SECRET_KEY` -- signs the login session cookie. Without this set, a random
  one is generated per process start, which means everyone gets signed out
  on every redeploy/restart. Any long random string works (e.g. generate one
  with `python -c "import secrets; print(secrets.token_hex(32))"`).

Changing either value and redeploying signs everyone out immediately.

## 2b. About the free tier (read this before a real show)

Render's free web services:
- **Spin down after 15 minutes of no traffic** and take 30-60 seconds to
  wake back up on the next request -- the first person to open the link
  after a lull will see a slow load, not a broken app.
- **Cannot attach a persistent disk.** This app writes every Show/Date under
  `data/shows/` to its own local disk on every save so they survive a
  restart -- on the free tier, all of it (shows, dates, and the color/
  numbering settings sidecar) disappears every time the service spins down
  or redeploys.

For anything beyond kicking the tires, upgrade the service to a paid
instance (Starter, ~$7/mo at time of writing) and attach a persistent disk
mounted at `/app/data` (Render's dashboard -> your service -> **Disks** ->
**Add Disk**, $0.25/GB/mo). That keeps every show/date and your color/Hi-D
settings across restarts and redeploys. Without it, everything still works
during a single continuous session -- it just won't survive the server
restarting.

## 3. Using the app

- Open the URL, add a **Show**, then add a **Date** under it -- that Date's
  own page is where you click **Upload sheet** and pick a `.pdf` or `.txt`
  pinning sheet export.
- Edit circuit numbers, toggle circuit colors / breakout (Hi-D) numbering
  from the two settings panels, adjust cards-per-row.
- **Save** persists that Date's job (and settings) to disk.
- **Export to Excel** downloads the finished `*_worksheet.xlsx`, built from
  the same `design.xlsx` template baked into this app. **Export PDF** (grid
  or mobile layout) uses the browser's own print-to-PDF instead.
- Uploading a *new* file replaces that Date's sheet for everyone -- there's
  no per-user copy. If someone else is mid-edit, coordinate before
  uploading over their work (same as you would sharing one paper pinning
  sheet). Other dates in the same show are unaffected -- each has its own
  job entirely.

## 4. Installing it on a phone (PWA)

The app ships a web manifest + service worker, so it's installable to a
home screen without an app store:

- **iOS (Safari)**: open the site -> Share icon -> **Add to Home Screen**.
- **Android (Chrome)**: open the site -> menu (⋮) -> **Add to Home screen**
  (Chrome may also prompt automatically).

This gives an app icon and a standalone window (no browser address bar) --
it is *not* a native iOS/Android app, just this same web app installed like
one. It still needs a network connection to your Render URL; it does not
work fully offline (each Date's job lives on the server, on purpose, so
everyone looking at that Date sees the same data).

If you eventually want a real App Store / Play Store listing, that's a
separate, larger project on top of this (wrapping the same web app with
Capacitor or similar, plus developer accounts and store review) -- worth
doing only once you know this workflow is the one you want to keep using.

## 5. Updating the app later

Push to the `main` branch on GitHub; Render redeploys automatically. If you
attached a persistent disk (step 2b), every show/date and your settings
survive the redeploy; if you didn't, the next person to open the app finds
an empty Home page and has to recreate shows/dates and re-upload.

## Alternative: Fly.io

Fly.io deploys the same Dockerfile with its CLI instead of a git-connected
dashboard:

```
fly launch          # detects the Dockerfile, asks a few setup questions
fly volumes create data --size 1     # persistent disk, same purpose as step 2b
fly secrets set APP_PASSWORD=... SECRET_KEY=...   # same as Render's Environment tab
fly deploy
```
Mount that volume at `/app/data` when prompted (or add a `[mounts]` block
to the generated `fly.toml` pointing at `/app/data`). Fly's free allowance
and always-on behavior differ from Render's -- check https://fly.io/docs/about/pricing/
for current details before committing to it for a real show.

## Notes on the architecture (why some things work the way they do)

- **One shared job per Date, one shared password, no user accounts.** This
  matches how the tool is actually used -- one person edits a given Date
  while everyone else waits their turn or looks at a `?view=1` link. There's
  no concurrent-edit merging: if two people save the same Date within
  moments of each other, the second save wins, the same risk as two people
  editing one shared spreadsheet tab. The password just keeps the tool off
  the open internet; it doesn't distinguish who's who.
- **Single gunicorn worker.** The Dockerfile intentionally runs one worker
  process (`--workers 1`). Every request reads/writes a Date's job.json
  straight from disk (guarded by one in-process lock), so unlike a true
  in-memory model, multiple workers wouldn't silently drift apart on stale
  copies -- but they could still race on the same file's write without that
  shared lock. If this ever needs true concurrent multi-worker traffic, the
  locking needs to move to something that coordinates across processes
  (a real datastore, file locks, etc.) -- a bigger change than this deploy
  guide covers.
