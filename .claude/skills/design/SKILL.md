---
name: design
description: The entry point for designing new things. Routes to specialized modules for foundations, patterns, or components. Use when the user is building something new, making a design decision, or evolving their design system. For improving existing UI, use /design-review instead.
---

The entry point for designing new things. Use `/design` when you're building something, making a design decision, or need guidance on how something should work. Routes to specialized modules, produces concise recommendations, and proposes `design.md` evolution.

For improving existing UI, use `/design-review` instead — it diagnoses what's wrong and fixes it.

## Modes

### Targeted (default)
The user asks about a specific thing ("should this button be filled?", "review my loading pattern"). Route to the matching module.

### Audit
The user asks to audit `design.md` or a page against Apple HIG ("audit my design system", "review design.md against HIG", "what's missing?"). Run a comprehensive gap analysis:

1. Read `design.md` in full.
2. Invoke each module in order: `/hig-foundations`, `/hig-patterns`, `/hig-components`.
3. Each module scans its full domain against `design.md`, reporting only **conflicts and gaps** -- skip anything that already aligns.
4. Consolidate all findings into a single prioritized report:

**Output format for audit:**

### Audit: [scope]

**Conflicts** (design.md contradicts Apple HIG):
- [item]: [what design.md says] vs [what Apple recommends]. Impact: [one sentence].

**Gaps** (Apple HIG covers this, design.md doesn't):
- [item]: [what's missing]. Priority: High/Medium/Low.

**Aligned** (summary only): [one sentence noting how many areas checked out fine].

### design.md Evolution
[Consolidated changeset, same format as targeted mode.]

## Routing

Analyze the request and invoke the matching module. For broad requests, invoke in order: foundations, then patterns, then components. When the request involves text, copy, or how to word things, also invoke `/write`.

### `/hig-foundations`
Visual foundations (color, typography, spacing, layout, motion, accessibility, dark mode, icons, images, inclusion, RTL, writing, branding, materials), platform adaptation (responsive, mobile vs desktop, touch vs pointer), input methods (gestures, keyboard, pointer, focus), design system tokens.

### `/hig-patterns`
User flows (navigation, modality, onboarding, launching, search), data interaction (forms, feedback, loading, undo, drag and drop), accounts and privacy (auth, notifications, settings, permissions), content management (files, collaboration, sharing, fullscreen), media.

### `/hig-components`
Actions (buttons, menus, toggles, toolbars), layout (lists, tables, tabs, sidebars, disclosure), input (text fields, pickers, sliders, segmented controls), presentation (alerts, popovers, sheets, scroll views), status (progress, gauges), data visualization (charts, graphs).

### `/write`
Any text the user will read — button labels, error messages, empty states, onboarding copy, descriptions, tooltips, form labels, confirmation dialogs. Invoke when the request involves writing new copy or when a component/pattern recommendation includes text that needs to be written well.

## After Module Completion

Consolidate any proposed `design.md` changes into a single changeset. The user approves before any file is modified.
