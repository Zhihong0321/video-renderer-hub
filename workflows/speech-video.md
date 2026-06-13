# Workflow: Speech Video Authoring Rules

These are authoring rules only.

The LLM does one job only:
- write self-contained slide HTML
- write narration text

The wrapper code owns everything deterministic:
- scratch-dir layout
- file names and locations
- manifest schema
- driver launch
- verification

## Slide Rules

- Each slide must be a complete self-contained HTML file.
- Use only system fonts.
- Do not load Google Fonts or any network asset.
- Do not rely on external images, scripts, or stylesheets.
- Do not assume runtime variable injection exists.
- Do not use `window.__HV_VARS__`.
- Do not leave the page in a hidden default state.
- Do not use `opacity: 0` unless a visible end state is guaranteed.
- Keep content readable at 1920x1080.
- Use strong contrast and clearly visible content.
- Prefer simple CSS animations with a stable visible result.
- One idea per slide.

## Narration Rules

- Narration should be natural spoken language.
- Keep each narrated slide concise.
- Match the user's requested language.
- Write for listening, not for reading.
- Avoid URLs, raw code, and hard-to-pronounce shorthand.

## Quality Rules

- Favor clarity over visual complexity.
- Favor visible content over decorative effects.
- Avoid white-screen risk.
