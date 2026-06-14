# REBUILD-PLAN.md — html-video prompt→video service

> **Status:** approved direction, not yet built.
> **Author of this plan:** review pass on 2026-06-13.
> **Read this whole file before writing any code. The Guardrails (§6) and the
> Acceptance Checklist (§9) are binding. If you think you need to deviate, STOP
> and ask the owner — do not "improve" the design on your own.**

---

## 1. Goal (the only thing that matters)

An app sends a **written prompt**. A **finished narrated MP4** comes back. All the
heavy work (writing slides, TTS, rendering) happens on the **Mac mini**.

That is the entire product. Anything that does not directly serve this sentence
is out of scope.

Current state we are replacing: a 839-line `worker.ts` that calls Minimax M3,
expects strict JSON back, string-fills "premium templates", and ships a **white
screen** because nothing checks the rendered frames. See §10 for the autopsy.

---

## 2. Architecture — three dumb pieces

```
[ app ] --POST prompt--> [ queue ]  <--claim/poll-- [ Mac mini worker ]
   ^                        (thin)                        |
   |                                                      | runs:
   +----------- GET result.mp4 -------------------------- |  claude -p "<prompt>"
                                                          |   (skill = pipeline)
                                                          |   -> self-verifies
                                                          |   -> final.mp4
```

Each piece is useless-but-simple on its own. The intelligence lives ONLY in the
skill that Claude Code reads.

### Piece A — `hv make` (the brain; works with NO server)
A single local command:
```
hv make "<prompt>" -o out.mp4
```
It spawns **Claude Code headless** (`claude -p`) in a scratch working dir, with
**one skill** = the existing `workflows/speech-video.md` (audio-first pipeline).
Claude:
1. writes self-contained HTML slides (system fonts, no network assets) + narration,
2. runs `scripts/make-speech-video.mjs` (the proven framestep render driver),
3. **verifies its own output** (see §5) and re-renders if blank,
4. leaves `final.mp4` in the workdir.

`hv make` is the unit we develop and debug. It needs no queue, no auth, no
Railway. If `hv make` produces a good video, the product works.

### Piece B — the queue (thinnest public surface)
Exists for ONE reason: the Mac mini has no inbound network, so apps need a public
drop-box for prompts + a place to fetch the result. Reuse the **good half** of the
existing `webui/server.mjs` (enqueue / claim / progress / upload / download).
Replace the **missing** `job-store.mjs` + `config.mjs` with a single **SQLite
file** and ~10 env reads. No Postgres. No SSE. No multi-worker logic.

### Piece C — the worker (a wrapper, ~30 lines)
Loop: claim a job → `hv make "<prompt>"` → **hard-gate the result** (§5) → upload
`final.mp4` → report progress. That's it. No M3 calls, no template-fill, no SSE
reconnect machinery. If Piece A works, Piece C is trivial.

---

## 3. Who does what (kills the format-fragility for good)

| Concern | Owner | Why |
|---|---|---|
| Write slides + narration | **Claude Code** (Anthropic tokens) | agentic, iterates on files, tolerant of fuzzy output |
| Text-to-speech | **Minimax `mmx`** | returns audio bytes — no JSON contract to break |
| Deterministic render | **framestep adapter + make-speech-video.mjs** | already verified at real 60fps |
| Verify the video isn't blank | **skill (agent) + worker (hard gate)** | defense in depth |
| Move prompts/results | **the queue** | dumb transport only |

Minimax M3 is **no longer parsed for structured output anywhere**. That entire
class of failure is deleted, not patched.

---

## 4. What we KEEP / DELETE (be concrete)

**KEEP (do not touch):**
- `packages/adapter-hyperframes/` — the `0.3.0-framestep` deterministic renderer. Verified. Hands off.
- `scripts/make-speech-video.mjs` — the audio-first driver. The render core.
- `workflows/speech-video.md` — becomes the skill Claude reads (extend it per §5, don't rewrite it).
- The request/transport half of `webui/server.mjs` (routes for enqueue/claim/progress/upload/download).

**DELETE / REPLACE:**
- `packages/cli/src/worker.ts` — gut the M3-plan / template-fill / `fillNytChart` / SSE half (≈ lines 260–748 and the SSE block). Keep only claim/progress/upload transport, fold into Piece C.
- The string-fill template path (`fillTemplate`, `fillDataTemplate`, `fillNytChart`, hand-rolled `parseYaml`). Gone.
- Reinstate the missing `webui/config.mjs` + `webui/job-store.mjs` as **SQLite**, not Postgres.
- Remove `/debug` + `/api/debug` Railway ops endpoints (not needed for a private 1-user tool).
- Delete the 18-byte `test_speech.mp3` and `test.mp3` junk in repo root.

**DEMOTE:**
- `templates/` (the 24 premium templates) — they are network-font, opacity-0 entry
  animations that the headless one-shot path cannot reliably fill or drive. They are
  **reference examples Claude may read and adapt into self-contained slides** — never
  runtime string-replace targets. Do not wire them back into the worker.

---

## 5. The white-screen killer — mandatory verification (defense in depth)

The white screen happened because **nothing looked at the output**. Fix it
structurally, in two layers:

**Layer 1 — in the skill (agent self-check), before it declares done:**
- After render, sample 3 frames (e.g. t=0.2s, mid, end) with ffmpeg.
- Measure non-background pixel ratio (ImageMagick `-format '%[fx:mean]'`). A frame
  that is ~100% one flat color = blank → **diagnose and re-render**, do not proceed.
- Assert the narration mp3 exists, is > 5 KB, and `ffprobe` duration > 0
  (catches the 18-byte error-response-as-audio case).

**Layer 2 — in the worker (deterministic hard gate), before upload:**
- Re-run the same cheap checks on `final.mp4`: has a video stream, has an audio
  stream, `ffprobe` duration within tolerance of expected, and at least one sampled
  frame is non-blank.
- **If the gate fails, the worker marks the job `failed` with the reason — it does
  NOT upload a blank video.** A failed job the app can retry beats a silent white screen.

This is the heart of the rebuild: blank output becomes **impossible to ship**,
for any template or prompt, including ones not yet written.

---

## 6. GUARDRAILS — binding rules for any AI coder (anti-over-engineering charter)

> Past agents turned a simple pipeline into a "rocket launch with a million
> failure points." These rules exist to stop that. Violating one is a defect even
> if the code works.

> **PRIME RULE — the LLM/code boundary.** The LLM does exactly ONE thing: write
> the slide HTML and the narration text (the fuzzy, creative part). EVERYTHING
> deterministic — manifest schema, file locations, scratch-dir layout, launching
> the driver from repo root, verification — is **code**, not LLM output, and not
> instructions in a markdown file. If you catch yourself adding a sentence to a doc
> to make the LLM behave more reliably (e.g. "don't invent field X", "put the file
> here"), STOP: that thing belongs in code. Fighting LLM nondeterminism with prose
> is the same "can't guarantee strict format" trap this rebuild exists to kill —
> just moved up a layer. (This is the rule the first rebuild attempt violated.)

> **STOP-LOSS.** If you make 2 attempts at the same step without shipping running
> code (a file that executes and is verified), STOP and report to the owner. Do not
> attempt #3. "Hours of `claude -p` proof runs with no wrapper written" is the
> failure this prevents.

> **HONESTY.** A checkbox is `[x]` ONLY if the code it describes exists AND you have
> pasted the command + its output as evidence. Never tick a box for behavior proven
> "by hand once" or for code not yet written. A false checkmark is a defect.

> **ZERO-DEPENDENCY VERIFICATION.** The blank-frame check uses `ffmpeg signalstats`
> (compare YMIN vs YMAX) and `ffprobe`. Do NOT require ImageMagick/`magick`, PIL, or
> any new tool for verification. If you're "blocked on a missing tool," you picked
> the wrong tool.

1. **The goal in §1 is the spec.** If a line of code doesn't serve "prompt in →
   narrated mp4 out, rendered on the Mac mini," delete it.
2. **No new infrastructure.** No Postgres, Redis, Docker-required, message broker,
   websockets/SSE, Kubernetes, microservices, ORMs. SQLite file + Node http + a CLI.
3. **No new abstraction layers** "for the future." No plugin registries, no engine
   abstraction beyond the one adapter that already works, no config frameworks.
   Inline beats indirection here.
4. **Do not re-parse Minimax M3 output as structured data.** TTS bytes only.
   If you find yourself writing JSON-repair / `<think>`-stripping / array-vs-object
   handling, you are rebuilding the bug.
5. **Do not reintroduce runtime template string-filling.** Slides are authored by
   the agent as self-contained HTML.
6. **Never ship unverified output.** The §5 hard gate is mandatory. No "upload
   then check later."
7. **The render core is frozen.** Do not modify `adapter-hyperframes` or
   `make-speech-video.mjs` to "fix" a video problem — fix the slide the agent wrote.
8. **`hv make` must run standalone** (no server, no auth) for local debugging. If a
   change can only be tested through the full distributed stack, it's wrong.
9. **Line budget is a smell test, not a target — but:** if the worker exceeds ~120
   lines or the queue exceeds ~250 lines, stop and justify it to the owner first.
10. **When unsure, ask the owner. Do not invent scope.** "It would be nice if…" is
    not a requirement.

---

## 7. Explicit NON-goals (we are NOT building these)

- Multi-tenant auth / user accounts (one shared bearer token is enough).
- Horizontal scaling / multiple workers / load balancing.
- A studio UI, live preview, timeline editor, or template marketplace.
- Real-time progress streaming (polling every few seconds is fine).
- Observability stack (metrics/tracing/structured ops dashboards).
- Cross-engine support (Remotion/Motion Canvas/Revideo). One engine: hyperframes framestep.
- Retry orchestration / dead-letter queues. A failed job is just `status=failed`.

---

## 8. Build order (phases — each independently verifiable)

**Phase 0 — prove the core by hand (no code yet).**
Manually: write 2–3 self-contained slides + narration, run `make-speech-video.mjs`,
confirm a good narrated mp4. Locks in that the render core + mmx work on the Mac mini.
*Exit:* one good mp4 exists, verified by §5 checks run manually.

**Phase 1 — the skill (slide-authoring rules ONLY).** Trim `workflows/speech-video.md`
to the creative rules the LLM needs: self-contained HTML, system fonts (no Google
Fonts), no `opacity:0` without a visible end state, no `__HV_VARS__`, one idea per
slide, narration writing tips. **Do NOT put manifest schema, file locations, or
"run the driver like this" prose in the skill** — per the PRIME RULE, the Phase 2
wrapper owns all of that.
*Exit:* the skill contains only authoring rules; a set of hand-written slides
following it renders cleanly through `make-speech-video.mjs`. **No `claude -p`
clean-dir scaffolding is required to pass Phase 1** — that was the trap; the wrapper
handles scaffolding in Phase 2.

**Phase 2 — `hv make` (the wrapper owns everything deterministic).** Thin CLI that:
creates the scratch workdir; runs `claude -p` asking the LLM for ONLY slide HTML +
narration text; **writes `manifest.json` itself** (never trusts LLM-authored
manifest); runs `make-speech-video.mjs` from repo root with an absolute path; runs
the §5 verification (ffmpeg signalstats + ffprobe, no magick); re-runs once on
failure then fails loudly.
*Exit:* `hv make "make a 20s explainer about X" -o out.mp4` produces a verified
`final.mp4` with no server running, on the Mac mini.

**Phase 3 — the queue (Piece B).** SQLite-backed `job-store.mjs` + `config.mjs`;
keep the good routes in `server.mjs`; drop the debug/ops endpoints.
*Exit:* can POST a prompt, see it queued, GET it back once a worker uploads.

**Phase 4 — the worker (Piece C).** Claim → `hv make` → §5 Layer-2 hard gate →
upload. Replace `worker.ts`.
*Exit:* end-to-end — POST prompt to queue, Mac mini renders, app downloads a
verified narrated mp4.

Do the phases in order. Do not start Phase 3 before Phase 2 produces good video.

---

## 9. Acceptance checklist (the final product MUST satisfy every item)

Tick every box with evidence (a command + its output), not assertion.

**Core capability**
- [ ] `hv make "<prompt>" -o out.mp4` produces a narrated mp4 with **no server running**.
- [ ] The mp4 has both a video and an audio stream (`ffprobe` shows both).
- [ ] `ffprobe` duration matches the narration length within ±0.1s (audio-first, no drift).
- [ ] mpdecimate shows tens of independent frames/sec during animation (real motion, not a still).
- [ ] **No blank frames:** sampled frames at t=0.2s/mid/end are non-uniform (white-screen bug gone).

**Anti-regression / scope**
- [ ] Nothing in the codebase parses Minimax M3 output as structured JSON (grep clean).
- [ ] No runtime template string-fill remains (`fillTemplate`/`fillNytChart` deleted).
- [ ] No Postgres, SSE, or Docker requirement introduced; queue store is a single SQLite file.
- [ ] `adapter-hyperframes` and `make-speech-video.mjs` are byte-for-byte unchanged from the verified versions (or changes explicitly approved by owner).
- [ ] Worker ≤ ~120 lines; queue ≤ ~250 lines (or deviation approved).

**End-to-end**
- [ ] POST a prompt to the queue → job goes `queued`→…→`completed` → `GET result.mp4` returns a verified mp4.
- [ ] A deliberately bad prompt that yields a blank render results in `status=failed` with a reason — **never a white-screen upload** (proves the §5 hard gate).
- [ ] Worker recovers from a restart mid-job (claims again, no stuck state).

**Hygiene**
- [ ] `webui/server.mjs` imports resolve (the missing modules exist); server boots clean.
- [ ] Junk removed (`test.mp3`, `test_speech.mp3`, dead endpoints).
- [ ] README/API docs describe the *actual* pipeline (Claude Code authors, mmx does TTS), not the old M3-template story.

---

## 10. Autopsy of the old design (so we don't repeat it)

- **`worker.ts` (839 lines)** reimplemented the working `make-speech-video.mjs`
  path as a one-shot M3-API pipeline, then spent most of its length defending
  against M3's unreliable JSON (`<think>` stripping, code-fence extraction, regex
  JSON extraction, array-vs-object coercion). The defense code *is* the evidence
  that the approach was wrong.
- **White screen:** the 24 "premium" templates don't read `window.__HV_VARS__`
  (the worker's injected vars do nothing); content only entered via fragile
  string-replacement of example values. Templates start every element at
  `opacity: 0` and pull Google Fonts over the network. With injection broken and
  fonts/animation unresolved headless, captured frames never leave the blank
  initial state — and nothing checked, so it uploaded anyway.
- **`webui/server.mjs`** imports `./config.mjs` and `./job-store.mjs` that **do not
  exist in the repo** — the committed server can't even boot. The deployed thing
  diverged from source.
- **`test_speech.mp3` = 18 bytes**: an API error saved as "audio." Silent TTS
  failure with no assertion. §5 Layer-1 catches this now.

The lesson encoded in §6: **the pipeline belongs in a skill the agent reads and
verifies, not in pre-decided code with a strict contract at every hop.**
