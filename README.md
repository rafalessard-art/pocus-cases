# POCUS Learning Case Series

A small static teaching site by Raphael Lessard, MD — simulated point-of-care ultrasound cases for senior anesthesiology residents.

## What's here

| File | Purpose |
|------|---------|
| `index.html` | Homepage / case index. Links to each case by filename. |
| `GLP1_Gastric_Ultrasound_Learning_Case.html` | Case 1 — Gastric POCUS & GLP-1 receptor agonists |
| `POCUS_Learning_Case_Diaphragm_FirstRibResection.html` | Case 2 — Diaphragm POCUS & first rib resection |

It is plain static HTML — no build step, no framework, no server code. Any folder that serves these three files together is a working site.

## Adding a new case

1. Drop the new case's `.html` file into this folder.
2. Open `index.html` and replace the "Coming Soon" placeholder card (search for `class="card soon"`) with a real link card, copying the pattern of the existing cards. Point `href` at your new filename.
3. Update the count in the masthead `.stats` block if you like.
4. Commit and push (see DEPLOYMENT_GUIDE for the GitHub + Vercel workflow).

## Hosting

Currently deployed on Vercel. See `DEPLOYMENT_GUIDE.md` for connecting a GitHub repo so pushes auto-redeploy.
