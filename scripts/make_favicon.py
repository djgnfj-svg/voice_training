"""Convert generated 1024x1024 PNG into favicon.ico + apple-touch-icon.png."""
from pathlib import Path
from PIL import Image

import os
SRC = Path(os.environ.get("TEMP", "/tmp")) / "favicon" / "original.png"
PUBLIC = Path("frontend/src/app")

img = Image.open(SRC).convert("RGBA")

# favicon.ico — multi-size (16, 32, 48) for best browser rendering
icon_sizes = [(16, 16), (32, 32), (48, 48)]
favicon_path = PUBLIC / "favicon.ico"
img.save(favicon_path, format="ICO", sizes=icon_sizes)
print(f"[write] {favicon_path} ({favicon_path.stat().st_size} bytes, sizes={icon_sizes})")

# apple-icon.png — 180x180 for iOS home screen (Next.js App Router convention)
apple_path = PUBLIC / "apple-icon.png"
apple = img.resize((180, 180), Image.LANCZOS)
apple.save(apple_path, format="PNG")
print(f"[write] {apple_path} ({apple_path.stat().st_size} bytes)")

# icon.png — 512x512 for Next.js App Router auto icon
icon_path = PUBLIC / "icon.png"
icon512 = img.resize((512, 512), Image.LANCZOS)
icon512.save(icon_path, format="PNG")
print(f"[write] {icon_path} ({icon_path.stat().st_size} bytes)")
