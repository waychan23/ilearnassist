---
name: design-review
description: The entry point for improving existing UI. Diagnoses design problems, picks the right specialized skills, presents findings and a plan, then executes. Use when the user wants to review, improve, fix, polish, or harden something that already exists. For designing new things, use /design instead.
user-invocable: true
---

The entry point for improving existing UI. Use `/design-review` when something already exists and needs to get better — whether that's a full page, a single component, or the whole system.

For designing new things, use `/design` instead — it gives you HIG-grounded guidance for what you're building.

## Process

### 1. Understand the Request

Read the user's message and the relevant code/UI. Classify what they're asking for:

**Broad review** ("review this", "what do you think", "improve this page", "make this better")
→ Start with analysis, then route to specific fixes.

**Specific problem** ("the spacing feels off", "this is too busy", "error messages are confusing")
→ Skip analysis, route directly to the matching skill(s).

**Specific goal** ("make this production-ready", "prepare for launch", "make this more fun")
→ Route to the skill combination that achieves the goal.

### 2. Diagnose

For broad reviews, quickly assess the UI across these dimensions. You're not doing the full work of each skill — you're triaging to figure out which ones to call.

| Signal | Points to |
|---|---|
| Inconsistent tokens, hard-coded values, drift from design system | `/normalize` |
| Weak type hierarchy, bad font choices, poor readability | `/typeset` |
| Monochromatic, dull, no color strategy | `/colorize` |
| Bad spacing, monotonous grid, weak visual hierarchy | `/arrange` |
| Overcrowded, too many elements, unnecessary complexity | `/distill` |
| Unclear labels, bad error messages, confusing copy | `/clarify` |
| Copy that's verbose, hedging, abstract, or lifeless | `/write` |
| No hover/focus states, missing transitions, feels static | `/animate` |
| Functional but forgettable, no personality | `/delight` |
| Safe, generic, visually bland | `/bolder` |
| Overstimulating, too loud, garish | `/quieter` |
| Missing error handling, overflow issues, no i18n | `/harden` |
| Slow, large bundles, janky animations, bad CWV | `/optimize` |
| Broken on mobile, no responsive behavior, tiny touch targets | `/adapt` |
| Bad first-run, empty states with no guidance | `/onboard` |
| Repeated components that should be extracted | `/extract` |
| Alignment off, inconsistent details, not quite ready to ship | `/polish` |

For a thorough technical + UX review, invoke `/critique` and/or `/audit` first, then use their findings to decide what to fix.

### 3. Present the Review

You're the expert. You decide what's wrong and what to do about it. Present your full review with concrete findings and a clear plan. The user reviews your assessment — not a list of options to pick from.

Format:

> ### Review
>
> **What's working:** [1-2 sentences on what's solid]
>
> **What needs work:**
> 1. [Specific finding — what's wrong and why it matters]
> 2. [Specific finding]
> 3. ...
>
> ### Plan
>
> Here's what I'll do, in order:
>
> 1. **`/skill-name`** — [what it'll fix from the findings above]
> 2. **`/skill-name`** — [what it'll fix]
> 3. ...
>
> This should take care of [brief summary of the end result].

Then wait. The user reviews your assessment and gives the green light (or pushes back on specific findings). This is a review, not a rubber stamp — your job is to give them a strong opinion they can react to, not choices to agonize over.

### 4. Execute

Once the user confirms, invoke the skills in order. Each skill does its own work — don't duplicate what they'll do. Between skills, briefly note progress:

> Done with `/arrange`. Moving to `/typeset`.

After all skills complete, give a short summary of what changed.

## Routing Guide

### Common combos

These skills frequently go together. When one is needed, consider whether its companions apply too.

**"Make this better" (general improvement)**
`/arrange` → `/typeset` → `/colorize` → `/polish`

**"Review and fix" (full review)**
`/critique` → [route based on findings]

**"Production-ready"**
`/harden` → `/optimize` → `/adapt` → `/polish`

**"More personality"**
`/bolder` → `/delight` → `/animate`

**"Simplify this"**
`/distill` → `/clarify` → `/write` → `/arrange`

**"Design system cleanup"**
`/normalize` → `/extract` → `/polish`

**"Pre-launch polish"**
`/audit` → `/harden` → `/polish`

**"Fix the copy"**
`/clarify` → `/write` → `/polish`

**"Tone it down"**
`/quieter` → `/typeset` → `/polish`

### Ordering principles

When running multiple skills, order matters:

1. **Structural changes first** — `/distill`, `/arrange`, `/adapt` (these move things around)
2. **System alignment** — `/normalize`, `/extract` (align to tokens and patterns)
3. **Visual refinement** — `/typeset`, `/colorize`, `/bolder` or `/quieter` (style changes)
4. **Interaction layer** — `/animate`, `/delight` (motion and personality)
5. **Copy and content** — `/clarify`, `/write`, `/onboard` (text changes)
6. **Hardening** — `/harden`, `/optimize` (resilience and performance)
7. **Final pass** — `/polish` (always last — it catches whatever's left)

Don't run all of these. Pick the 2-5 that actually matter for this situation.

## DO
- Read the actual code/UI before diagnosing — don't guess from the description alone
- Make the call yourself — you're the design expert, pick the skills and the order
- Present specific findings with concrete reasoning, not vague observations
- Wait for the user to review your assessment before executing
- Run skills in a logical order (structural → visual → interaction → hardening → polish)

## DON'T
- Present a menu of skills for the user to choose from — give them your recommendation
- Run every skill on every review — pick the 2-5 that actually matter
- Do the sub-skills' work yourself — invoke them and let them handle it
- Execute before the user has reviewed your findings
- Run `/polish` first — it's a final pass, always last
