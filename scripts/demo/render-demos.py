import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("DEMO_ROOT", "/tmp/opencode"))
FONT = os.environ.get("DEMO_FONT", "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf")

sys.path.insert(0, str(ROOT / "py"))

import pyte
from PIL import Image, ImageDraw, ImageFont

SCENES = ("ask", "allow", "abstain")
TERMINAL = 420
SIZE = (800, 530)
BG = "#1d222c"
FOOTER = "#191c24"
WHITE = "#eceef4"
MUTED = "#a4aab7"
ACCENT = {"ask": "#e8b074", "allow": "#88c0d5", "abstain": "#dd96a1"}
MATCH = {"ask": "MATCHED", "allow": "NO MATCH", "abstain": "NO MATCH"}
JEVVY = {"ask": "NOT CALLED", "allow": "APPROVES", "abstain": "FLAGS RISK"}
font10 = ImageFont.truetype(FONT, 10)
font11 = ImageFont.truetype(FONT, 11)
font13 = ImageFont.truetype(FONT, 13)
font14 = ImageFont.truetype(FONT, 14)
font15 = ImageFont.truetype(FONT, 15)
font19 = ImageFont.truetype(FONT, 19)


def footer(image, host, scene):
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, TERMINAL, 799, 529), fill=FOOTER)
    draw.line((0, TERMINAL, 799, TERMINAL), fill="#4d5361", width=1)
    rule = "shell: git push * → ask" if host == "open" else "Bash(git push *)"
    draw.text((20, 431), "CONFIGURED ASK", font=font11, fill=MUTED)
    draw.text((160, 428), rule, font=font14, fill=WHITE)
    draw.line((20, 455, 780, 455), fill="#424854", width=1)
    for x, title, value in ((20, "RULE CHECK", MATCH[scene]), (420, "JEVVY", JEVVY[scene])):
        draw.text((x, 466), title, font=font11, fill=MUTED)
        draw.text((x, 486), value, font=font19, fill=ACCENT[scene])
    draw.text((377, 488), "→", font=font19, fill=MUTED)
    return image


def terminal_claude(screen):
    image = Image.new("RGB", SIZE, BG)
    draw = ImageDraw.Draw(image)
    for y in range(28):
        row = screen.buffer[y]
        for x in range(80):
            cell = row[x]
            char = cell.data
            if char.strip():
                color = f"#{cell.fg}" if len(cell.fg) == 6 else WHITE if cell.fg == "default" else MUTED
                draw.text((x * 10, y * 15 - 2), char, font=font15, fill=color)
    return image


def render_claude(scene, destination):
    data = json.loads((ROOT / f"claude-{scene}.json").read_text())
    chunks = data["chunks"]
    start = data["recordFrom"]
    screen = pyte.Screen(80, 28)
    stream = pyte.Stream(screen)
    index = 0
    for frame in range(32):
        at = start + 400 + min(frame, 21) * 100
        while index < len(chunks) and chunks[index]["t"] <= at:
            stream.feed(base64.b64decode(chunks[index]["data"]).decode("utf8", errors="replace"))
            index += 1
        image = footer(terminal_claude(screen), "claude", scene)
        image.save(destination / f"{SCENES.index(scene) * 32 + frame:03}.png")


def render_open(scene, destination):
    sources = sorted((ROOT / "demo-frames" / scene).glob("*.png"))[-32:]
    for frame in range(32):
        with Image.open(sources[frame]) as source:
            top = source.crop((0, 0, 1000, 260))
            bottom = source.crop((0, 535, 1000, 800))
            terminal = Image.new("RGB", (1000, 525), "#101010")
            terminal.paste(top, (0, 0))
            terminal.paste(bottom, (0, 260))
            terminal = terminal.resize((800, TERMINAL), Image.Resampling.LANCZOS)
            image = Image.new("RGB", SIZE)
            image.paste(terminal, (0, 0))
        footer(image, "open", scene).save(destination / f"{SCENES.index(scene) * 32 + frame:03}.png")


for host in ("open", "claude"):
    if host == "open" and not all((ROOT / "demo-frames" / scene).is_dir() for scene in SCENES):
        print("open frames missing, skipping")
        continue
    if host == "claude" and not all((ROOT / f"claude-{scene}.json").exists() for scene in SCENES):
        print("claude captures missing, skipping")
        continue
    destination = ROOT / "rendered" / host
    destination.mkdir(parents=True, exist_ok=True)
    for scene in SCENES:
        if host == "open":
            render_open(scene, destination)
        else:
            render_claude(scene, destination)
    print(host, "rendered", len(list(destination.glob("*.png"))), "frames")
