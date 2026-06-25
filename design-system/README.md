# @pocus/design-system

React + TypeScript components extracted from the **POCUS Learning Case Series** static teaching site. The components carry the site's existing look — a warm `paper` base with `petrol` / `clay` / `moss` / `sky` / `gold` accents, a serif + sans pairing — encoded as plain CSS over a single CSS-variable token layer.

## Why this exists

The teaching site was hand-authored page by page, so its visual language was duplicated and had drifted (the index used `--petrol` / `--rule` / `--paper2`; the case files used `--teal` / `--line` / `--paper-card` for the same roles). This package makes the index palette canonical in `src/styles/tokens.css` and aliases the case-file names onto it, so one source of truth backs every component.

## Usage

```tsx
import '@pocus/design-system/styles.css';
import { Masthead, CaseCard, AnswerKey } from '@pocus/design-system';
```

Components read their colors from CSS variables defined on `:root` by `styles.css`, so the stylesheet must be loaded for them to look right.

### The accent mechanism

Accent-aware components (`CaseCard`, `NumBadge`, `Tag`, `Panel`, `PartTag`) take an `accent` prop — one of `petrol | clay | moss | sky | gold`. It sets the `--accent` CSS variable on the element, which the component CSS reads via `var(--accent, var(--petrol))`. Children inherit it: a `CaseCard accent="clay"` themes its badge, topic, and action link automatically.

## Components

| Group | Components |
|---|---|
| Layout | `PageWrap`, `TopNav`, `Masthead`, `SectionLabel` |
| Cards | `CaseCard` (+ `soon` placeholder), `NumBadge`, `Tag` |
| Panels | `Panel` |
| Case content | `PartTag`, `Vignette`, `Question`, `AnswerKey`, `Pearl`, `EvidenceGrade`, `Figure`, `DataTable`, `ReferenceList` |

## Scripts

```bash
npm install
npm run build          # → dist/ (ESM + style.css + index.d.ts)
npm run typecheck      # tsc --noEmit
npm run storybook      # component gallery on :6006
npm run build-storybook
```
