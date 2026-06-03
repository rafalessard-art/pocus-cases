# Deployment Guide — POCUS Learning Case Series

Your site is plain static HTML: three files that just need to be served together. There is no build step. The cleanest setup for a solo physician who adds a case now and then is **GitHub (stores the files) + Vercel (serves them, auto-redeploys on every change)**. Once connected, updating the site is: edit a file, commit, done.

Everything below is click-only — no terminal required.

---

## Part A — Put the files on GitHub (~3 min)

1. Go to <https://github.com> and sign in (create a free account if you don't have one).
2. Click the **+** (top right) → **New repository**.
3. Name it something like `pocus-cases`. Leave it **Public** (or Private — Vercel works with both). Do **not** add a README (you already have one). Click **Create repository**.
4. On the new empty repo page, click the link **"uploading an existing file"** (in the "…or upload an existing file" line).
5. Drag these four files into the upload box:
   - `index.html`
   - `GLP1_Gastric_Ultrasound_Learning_Case.html`
   - `POCUS_Learning_Case_Diaphragm_FirstRibResection.html`
   - `README.md` (optional)
6. Click **Commit changes**.

The filenames must stay **exactly** as-is — `index.html` links to the two case files by name, so any rename breaks the links.

---

## Part B — Connect Vercel (~2 min)

1. Go to <https://vercel.com> and sign in. Use **"Continue with GitHub"** so the two are linked.
2. Click **Add New… → Project**.
3. Find your `pocus-cases` repo and click **Import**. (If it's not listed, click "Adjust GitHub App Permissions" and grant Vercel access to the repo.)
4. Leave every setting at its default — Framework Preset should say **"Other"**, and there's no build command or output directory to set for static HTML.
5. Click **Deploy**.

After ~20 seconds you'll get a live URL like `https://pocus-cases.vercel.app`. `index.html` is served automatically as the homepage.

---

## Part C — Adding a new case later

1. In your GitHub repo, click **Add file → Upload files** and drop in the new `.html` case file.
2. Edit `index.html` (click it in GitHub, then the pencil icon): find the placeholder block `class="card soon"` and replace it with a real link card modeled on the existing two — set its `href` to your new filename. Commit.
3. Vercel redeploys automatically within ~30 seconds. No other steps.

---

## Notes

- **Custom domain:** In the Vercel project → Settings → Domains, you can add your own domain (e.g. `pocuscases.com`) for free if you own one.
- **Cost:** Vercel's Hobby (free) tier comfortably covers a static teaching site like this.
- **No backend needed:** These pages run entirely in the browser. Nothing to maintain server-side.
