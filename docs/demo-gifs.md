# Demo GIFs — what to record

A recording brief for the six animated demos the two READMEs have slots for. The slots are already
in place: each one is an HTML comment containing the `![…]` line, so the file is one edit away from
live and the README renders cleanly until then.

**Read [Before you record](#before-you-record) first** — two of the rules there are about a GIF
being permanent once it is public.

## Where the slots are

Five in each README, in the same places, with the same content. The Chinese set is `.zh.gif`, the
English set `.en.gif`, and both live in `docs/assets/`.

| # | File | Section (both READMEs) |
| --- | --- | --- |
| 1 | `first-run.{zh,en}.gif` | 快速上手 / Getting started — right after the six-step walkthrough |
| 2 | `configure-provider.{zh,en}.gif` | 内置的模型服务商 / Built-in model providers |
| 3 | `first-lesson.{zh,en}.gif` | 内置助理：引导学习 / The built-in assistant |
| 4 | `quiz-and-notes.{zh,en}.gif` | 功能特点 · 学习和对话 / Features · Studying and conversation |
| 5 | `library-and-mention.{zh,en}.gif` | 功能特点 · 资料 / Features · Material |

A sixth is planned but has no slot yet — `diagram-and-threads` — and it is the one to drop if
recording five is already enough work. Say so and a slot gets added.

## Before you record

- **Use a throwaway data folder and a throwaway workspace**, and delete both afterwards. A GIF
  pushed to GitHub is in the history permanently, and a screenshot of somebody's real notes is not
  something a later commit can take back.
- **No API key can be photographed** — the provider dialog's key field is `type="password"`, and the
  provider list shows only 已配置/未配置. Even so, **revoke the key you used**, once, after
  recording. Doing it once means never having to think about it again.
- **Fix the window at 1280×800** and do not resize during a take: every frame re-lays-out, and the
  reflow is what makes a demo look janky.
- **End each GIF on a settled screen.** Not mid-dropdown, not mid-scroll — it loops, and a loop that
  restarts from a half-open menu reads as a glitch.
- **Run the flow once without recording** to check the model is in a good mood. The scripted fake
  LLM used by the test suite cannot be used here: the point of these is real teaching.
- **Record the Chinese set in one sitting**, then switch the language once and record the English
  set. Same prompts, same clicks — so the two sets cannot drift apart in content.

## The toolchain

macOS records with `Cmd+Shift+5` (screen recording → selected portion). Then:

```bash
ffmpeg -i in.mov -vf "fps=12,scale=1000:-1:flags=lanczos" -f gif - | gifsicle -O3 --lossy=80 > out.gif
```

- **12 fps**, not 30: a UI demo has almost no motion, and 30 fps triples the size for nothing.
- **1000px wide** is the ceiling. GitHub renders in a column, so wider is only heavier.
- `gifsicle -O3 --lossy=80` usually halves what ffmpeg produced, and the artefacts are invisible on
  flat UI.
- **Budget ≤ 3 MB each.** For scale: the largest binary committed today is a 97 KB `.icns`. If a
  flow will not fit, it is two GIFs, not one bigger one.

## The six cases

### 1. `first-run` — from nothing to a usable window

≤ 20s. The one sequence a non-technical user must be able to follow.

1. Launch the control panel. It appears with no data folder chosen.
2. Click the offered default folder (`~/ilearnassist`).
3. Create the superadmin: a username and a password.
4. The server starts by itself; click **Open app**.
5. Sign in.

**Ends on:** the workspace home page, empty.

### 2. `configure-provider` — the first thing that blocks everybody

≤ 15s. The cause and the effect have to be in one take, because the whole point is that the model
list is empty *until* a key is saved.

1. From the rail, open **平台管理 → 模型服务** (Platform console → Model services).
2. Pick DeepSeek, paste an API key, save.
3. Go back to a conversation and open the model picker — **the provider is now listed**.

**Ends on:** the open model picker with the provider in it. That frame is the whole point.

### 3. `first-lesson` — the one that shows this is not another chat box

≤ 25s, and the most important of the six. Split it into two if it runs long (the plan appearing is
one GIF; teaching and quizzing is another).

1. New workspace → new conversation → assistant: **引导学习 · Guided Learning**.
2. Say: *"我想学 Rust 的所有权"* (English: *"I want to learn Rust ownership"*).
3. It searches, then produces a plan. The **计划 (Plan) panel on the right fills with a numbered
   tree** — this is the frame to hold.
4. Say 可以 (go ahead). It teaches the first item.
5. It poses a question, which renders as a **quiz card** the user can answer.

**Ends on:** the quiz card.

### 4. `quiz-and-notes` — being checked, and keeping what you underlined

≤ 25s. Two widgets, and one gesture that no amount of prose explains.

1. Answer the quiz card — **pick a wrong option on purpose**, so the grading has something to say.
2. The assistant marks it and says plainly what was wrong.
3. Select a passage in the reply with the mouse → the floating bar appears → write a note.
4. The **笔记 (Notes) panel** shows it. Click it → **the conversation scrolls back to the passage**.

**Ends on:** the scrolled-to passage with the note highlighted.

### 5. `library-and-mention` — it reads your material

≤ 20s.

1. Open the library, upload a PDF.
2. In the composer, type `@` → the picker opens → choose that PDF.
3. Ask: *"这份文档的第三章讲了什么？"* (English: *"What does chapter three of this document say?"*).
4. The assistant answers **from the document**, not from general knowledge.

**Ends on:** the answer, with the reference chip still visible above the composer.

### 6. `diagram-and-threads` — optional

≤ 20s, and the least essential: it demonstrates the two panels that are impressive and least
central.

1. Ask for a diagram — *"画一张图说明…"*.
2. The assistant calls the diagram tool and the drawing renders in the reply.
3. The **图表 (Figures) panel** lists it; click to open it.
4. Switch to **脉络 (Threads)** — the conversation has been filed by topic automatically.

**Ends on:** the thread tree.

## When a GIF lands

1. Put it in `docs/assets/` with the exact name from the table above.
2. In the README, delete the two comment lines (`<!--` … `-->`) around the `![…]` line, leaving the
   image line itself.
3. Check the rendered page on GitHub: the caption line above each image is part of the slot's
   surrounding prose, so nothing else needs writing.

A handover either way is fine — the files, or a message saying they are in place, and the
uncommenting gets done in one commit.
