# MACMINI-FIRST-RUN — feed this to Claude Code on the Mac mini

> **You are Claude Code on the Mac mini, setting up html-video for the first time
> after a `git pull` of the `webui` branch.** Your job: get the machine to the point
> where it can take a prompt and produce a verified narrated MP4 — first as a local
> command, then through the full queue+worker loop — and report exactly what works.
>
> **Rules (do not break):**
> 1. Read `REBUILD-PLAN.md` §6 (Guardrails) first and obey it. Do NOT add infra, do
>    NOT modify the render core, do NOT "improve" scope. This is setup, not redesign.
> 2. Verify every step with evidence (command + output). If a check fails, STOP at
>    that step and report — do not guess-fix or work around it.
> 3. If a prerequisite is missing, STOP and tell the owner the exact tool + how to
>    get it. Do not silently install heavy things or invent alternatives.
> 4. Run commands from the **repo root** unless told otherwise.
> 5. Do NOT commit anything. Do NOT push. The owner handles git.

The architecture you're standing up:
`app → POST prompt → WebUI queue (SQLite) → this Mac mini worker claims it →
runs hv make (Claude writes slides + narration, mmx does TTS, framestep renders) →
hard-gate verify → upload mp4 → app downloads`. You are the worker side.

---

## Part 0 — Prerequisites (check, don't assume)

```bash
node -v       # MUST be >= 22.5 (the queue uses Node's built-in node:sqlite). 24 is fine.
corepack enable; pnpm -v
ffmpeg -version | head -1
ffprobe -version | head -1
mmx --version ; mmx auth status     # MiniMax CLI — does TTS. Must be authenticated.
claude --version                     # Claude Code CLI — authors slides. Must be logged in.
```

**Gate:**
- `node` < 22.5 → STOP. The WebUI queue will not run. Tell the owner to upgrade Node.
- `ffmpeg`/`ffprobe` missing → `brew install ffmpeg`, re-check.
- `mmx` missing or not authed → STOP (TTS can't run). Owner must install/auth MiniMax CLI.
- `claude` missing or not logged in → STOP (slide authoring can't run). Owner must auth it.

Do not proceed past a failed gate.

---

## Part 1 — Install + build, confirm the new commands exist

```bash
pnpm install
pnpm -r build
```

**Gate — render core + CLI built:**
```bash
test -f packages/adapter-hyperframes/dist/index.js && echo "render core OK"
test -f packages/cli/dist/bin.js && echo "cli OK"
node packages/cli/dist/bin.js --help | grep -E "make|worker" && echo "make+worker commands present"
```
All must print. If the build failed, report the error and stop.

> Invoke the CLI as `node packages/cli/dist/bin.js <cmd>` throughout (that's exactly
> how the worker calls itself). The `hv` / `html-video` global alias only exists if
> you `npm link` it — not required.

---

## Part 2 — Prove the brain: `hv make` standalone (no server)

This is the make-or-break test. If this produces a good video, the product works.

```bash
node packages/cli/dist/bin.js make "Make a 15 second explainer about why this Mac mini renders videos from a prompt." -o /tmp/firstrun.mp4
```
Expect NDJSON progress: `scratch → author → manifest → render → verify → {"status":"ok",...}`.
First run is slow (Claude authors slides, mmx synthesizes, framestep renders at
~0.3s/frame). A 15s clip can take several minutes. That's normal.

**Gate (the wrapper already self-verifies, but confirm independently):**
```bash
F=/tmp/firstrun.mp4
ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$F"            # -> video AND audio
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$F"    # -> > 0
ffmpeg -hide_banner -ss 0.2 -i "$F" -frames:v 1 -vf "signalstats,metadata=print" -f null - 2>&1 | grep -E "YMIN|YMAX"
```
- Must have **both** video and audio streams.
- The blank-frame check: `YMIN` must be **less than** `YMAX` (equal = white screen → STOP and report; the wrapper should have caught it and failed, so investigate why it shipped).

If this passes: the core pipeline works on this machine. Watch the video once to
sanity-check it actually makes sense for the prompt.

---

## Part 3 — Prove the full loop locally (queue + worker on this machine)

Run the WebUI queue and the worker together on the Mac mini, post a job, watch it
complete. This proves the worker claims, renders, gates, and uploads correctly.

**3a. Start the queue** (pick any two test secrets; they only need to match below):
```bash
REQUESTER_API_KEY=devkey WORKER_SECRET=devworker PORT=3000 \
  DATA_DIR=/tmp/hv-firstrun-data PUBLIC_BASE_URL=http://127.0.0.1:3000 \
  node webui/server.mjs &
sleep 2
curl -s http://127.0.0.1:3000/health      # -> {"ok":true,...}
```
(`PUBLIC_BASE_URL` makes the dashboard's download links resolve; the API download
works without it too.)

**3b. Start the worker** pointed at the local queue (new terminal or background):
```bash
node packages/cli/dist/bin.js worker --server http://127.0.0.1:3000 --secret devworker --worker-id macmini-firstrun --poll-ms 3000 &
```

**3c. Post a job and watch it:**
```bash
JOB=$(curl -s -X POST http://127.0.0.1:3000/api/jobs \
  -H "Authorization: Bearer devkey" -H "content-type: application/json" \
  -d '{"prompt":"Make a 12 second explainer about audio-first video rendering."}')
echo "$JOB"
ID=$(printf '%s' "$JOB" | sed -n 's/.*"job_id": *"\([^"]*\)".*/\1/p')
# poll until terminal
for i in $(seq 1 120); do
  S=$(curl -s "http://127.0.0.1:3000/api/jobs/$ID" -H "Authorization: Bearer devkey")
  echo "$S" | sed -n 's/.*"status": *"\([^"]*\)".*/status=\1/p; s/.*"progress": *\([0-9]*\).*/ progress=\1/p'
  echo "$S" | grep -q '"status": *"completed"' && break
  echo "$S" | grep -q '"status": *"failed"' && { echo "JOB FAILED: $S"; break; }
  sleep 15
done
```

**3d. Download + verify the result:**
```bash
curl -s "http://127.0.0.1:3000/api/jobs/$ID/result.mp4" -H "Authorization: Bearer devkey" -o /tmp/loop-result.mp4
ffprobe -v error -show_entries stream=codec_type -of csv=p=0 /tmp/loop-result.mp4   # -> video AND audio
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/loop-result.mp4
```

**Gate:** the job reaches `completed` and the downloaded mp4 has video+audio with a
sane duration. If it reaches `failed`, read the job's `error` field and report it —
do not retry blindly.

**3e. Tear down the test:**
```bash
kill %1 %2 2>/dev/null     # stop worker + server (adjust job numbers if needed)
rm -rf /tmp/hv-firstrun-data /tmp/firstrun.mp4 /tmp/loop-result.mp4
```

---

## Part 4 — Going live (wire the worker to the real WebUI)

When the public WebUI queue is deployed (its own host — not this Mac mini), run ONLY
the worker here. It connects outbound; the Mac mini needs no inbound ports.

```bash
node packages/cli/dist/bin.js worker \
  --server https://<your-public-webui-host> \
  --secret  <WORKER_SECRET> \
  --worker-id macmini
```
- `WORKER_SECRET` must be the **same value** the WebUI server was started with. Get
  it from the owner / your secrets store — do not invent one.
- The worker needs `claude` and `mmx` authenticated on this machine (Part 0). It does
  not need any MiniMax API key in an env var — it shells out to the `mmx` CLI.
- To keep it running across reboots, the owner can wrap this in a `launchd` plist or
  a `tmux`/`pm2` process. **Do not build that yourself unless the owner asks** —
  report that it's the next step and let them choose.

---

## Part 5 — Report (use this exact shape), then STOP

```
MACMINI FIRST-RUN REPORT
- Host: macOS <version>, node <v> (>=22.5? yes/no), ffmpeg <v>
- Tools: mmx <auth state>, claude <auth state>
- Build: render core <OK/FAIL>, cli make+worker <OK/FAIL>
- Part 2 hv make standalone: <PASS/FAIL> (duration <x>s, streams <video/audio>, YMIN<YMAX <y/n>)
- Part 3 full loop: <PASS/FAIL> (job reached <status>, result streams <video/audio>, duration <x>s)
- Blockers: <none | exact missing tool/secret + how to fix>
- Ready to go live (Part 4)? <yes/no + what's needed>
```

Then clean up any leftover `/tmp/hv-*` and **stop**. Do not start Part 4 in
production, do not set up auto-start, do not commit — wait for the owner.

Do NOT touch `packages/adapter-hyperframes/` or `scripts/make-speech-video.mjs`
(Guardrail 7 — the render core is frozen).
