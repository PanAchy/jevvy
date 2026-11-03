# Demo recorders

Regenerate `assets/jevvy-demo.gif` and `assets/jevvy-claude-demo.gif` from the real packed plugin and the real host UIs. The Jevvy judgment comes from a local deterministic decision endpoint. The model responses are simulated.

These are maintainer tools. They are not part of the published package or normal CI.

## Prerequisites

- Bun 1.4.x and Node.js 22.19 or newer.
- `ffmpeg` on `PATH`.
- Python 3 with Pillow and pyte.
- JetBrains Mono Regular. Set `DEMO_FONT` if it is not at `/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf`.
- OpenCode 2.2.0 for the OpenCode demo.
- Claude Code 2.1.296 for the Claude Code demo.

Install the recorder dependencies and Python packages:

```bash
npm install --prefix scripts/demo
uv pip install --target "${DEMO_ROOT:-/tmp/opencode/jevvy-demo}/py" -r scripts/demo/requirements.txt
```

Pack the plugin from the repository and install that tarball into a temporary consumer. Do not point the recorders at repository source.

```bash
export DEMO_ROOT="${DEMO_ROOT:-/tmp/opencode/jevvy-demo}"
mkdir -p "$DEMO_ROOT/consumer"
npm pack --workspace=@jevvy/permissions --pack-destination "$DEMO_ROOT"
npm install --prefix "$DEMO_ROOT/consumer" "$DEMO_ROOT"/jevvy-permissions-*.tgz
export JEVVY_PLUGIN_DIR="$DEMO_ROOT/consumer/node_modules/@jevvy/permissions"
```

## OpenCode

Make the demo tools and the pinned OpenCode binary available on `PATH`, then run the launcher:

```bash
export PATH="$PWD/scripts/demo/node_modules/.bin:$PATH"
node scripts/demo/launch-demo-open.mjs
```

The launcher runs the `ask`, `allow`, and `abstain` scenes, verifies the plugin is active and the expected Jev calls happen, and writes the recordings to `$DEMO_ROOT/media`.

Extract frames for each scene in that order:

```bash
mkdir -p "$DEMO_ROOT/demo-frames"/{ask,allow,abstain}
mapfile -t takes < <(find "$DEMO_ROOT/media" -name '*.mp4' | sort)
ffmpeg -i "${takes[0]}" -vf fps=10 "$DEMO_ROOT/demo-frames/ask/%03d.png"
ffmpeg -i "${takes[1]}" -vf fps=10 "$DEMO_ROOT/demo-frames/allow/%03d.png"
ffmpeg -i "${takes[2]}" -vf fps=10 "$DEMO_ROOT/demo-frames/abstain/%03d.png"
```

## Claude Code

With `claude` 2.1.296 on `PATH`, run each scene:

```bash
for scene in ask allow abstain; do
  node scripts/demo/claude-demo-host.mjs "$scene"
done
```

The host writes the ANSI captures and timing JSON to `$DEMO_ROOT`.

## Render

```bash
DEMO_ROOT="$DEMO_ROOT" DEMO_FONT="$DEMO_FONT" python3 scripts/demo/render-demos.py
```

The renderer writes 96 frames per host under `$DEMO_ROOT/rendered`. Build each GIF with a two-pass palette:

```bash
ffmpeg -framerate 10 -i "$DEMO_ROOT/rendered/open/%03d.png" \
  -filter_complex '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3' \
  -loop 0 assets/jevvy-demo.gif

ffmpeg -framerate 10 -i "$DEMO_ROOT/rendered/claude/%03d.png" \
  -filter_complex '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3' \
  -loop 0 assets/jevvy-claude-demo.gif
```

Keep `$DEMO_ROOT`, the packed tarball, frames, and recordings untracked. The demo uses synthetic prompts, a disposable Git fixture, and a placeholder Anthropic key. The local decision endpoint returns deterministic answers; it does not call a real provider or include credentials.
