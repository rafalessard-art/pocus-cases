# POCUS Learning Case Series

A small static teaching site by Raphael Lessard, MD — simulated point-of-care ultrasound cases for senior anesthesiology residents. Live at <https://pocus-cases.vercel.app>.

## What's here

### Pages

| File | Purpose |
|------|---------|
| `index.html` | Homepage / case index. Links to each case and to the Tools page. |
| `tools.html` | Interactive Tools landing page (served at `/tools`). |

### Cases

| File | Clean URL | Case |
|------|-----------|------|
| `GLP1_Gastric_Ultrasound_Learning_Case.html` | `/cases/glp1-gastric` | Gastric POCUS & GLP-1 receptor agonists |
| `POCUS_Learning_Case_Diaphragm_FirstRibResection.html` | `/cases/diaphragm-first-rib` | Diaphragm POCUS & first rib resection |
| `POCUS_Learning_Case_ONSD_PDPH.html` | `/cases/onsd-pdph` | Optic nerve sheath diameter & post-dural-puncture headache |
| `POCUS_Learning_Case_VascularAccess.html` | `/cases/vascular-access` | Vascular access |

An Airway POCUS case is an intentional "Coming soon" placeholder on the homepage (WIP lives on the `airway-wip` branch).

### Interactive tools (linked from `tools.html`)

| File / path | Tool |
|-------------|------|
| `Echocardiography_3D_Sono.html` | Interactive 3D Heart & Live Echo (WebGL) |
| `VascularAccess_3D_Sono.html` | 3D Arm & Live Ultrasound (WebGL) |
| `echo-simulator/` | EchoSimulator — 2D parametric pathology echo (63 prebuilt clips + `manifest.json`) |

### Shared assets

| File | Purpose |
|------|---------|
| `theme.css` / `theme.js` | Site-wide styling and the auto/manual dark-mode toggle. |
| `vh_heart_data.js`, `echo_clips.js` | Data for the 3D heart and echo tools. |
| `vercel.json` | Clean-URL `rewrites` (`/cases/*`, `/tools`) and `.html`→clean-URL `redirects`. |
| `.vercelignore` / `.gitignore` | Keep drafts, literature reviews, benchmarks, and `_backups/` out of the deploy. |
| `design-system/` | `@pocus/design-system` — a React component library extracted from the site (Storybook + Vite). Not part of the deployed static site. |

It is plain static HTML — no build step, no framework, no server code. Any folder that serves these files together is a working site. (The `design-system/` package is a separate, optional React build.)

## Adding a new case

1. Drop the new case's `.html` file into this folder.
2. Open `index.html` and replace the "Coming Soon" placeholder card (search for `class="card soon"`) with a real link card, copying the pattern of the existing cards. Point `href` at the new case's clean URL.
3. Add a `rewrite` and a `.html`→clean-URL `redirect` for it in `vercel.json`, matching the existing entries.
4. Update the counts in the `index.html` masthead `.stats` block.
5. Commit and push (see `DEPLOYMENT_GUIDE.md` for the GitHub + Vercel workflow).

## Hosting

Currently deployed on Vercel. See `DEPLOYMENT_GUIDE.md` for connecting a GitHub repo so pushes auto-redeploy.
