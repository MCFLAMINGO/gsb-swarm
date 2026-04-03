#!/bin/bash
# Install Python dependencies for bleeding.cash financial triage
# Runs at Railway build time via nixpacks

echo "[install] Installing Python dependencies..."

# Try system pip first, then pip3, then pip with --user
pip install reportlab xlrd openpyxl pandas pypdf Pillow pypdfium2 \
  --quiet --break-system-packages 2>/dev/null || \
pip3 install reportlab xlrd openpyxl pandas pypdf Pillow pypdfium2 \
  --quiet --break-system-packages 2>/dev/null || \
pip install reportlab xlrd openpyxl pandas pypdf Pillow pypdfium2 \
  --quiet --user 2>/dev/null

echo "[install] Python deps install complete"
python3 -c "import reportlab, openpyxl, pandas, pypdf; print('[install] All imports OK')"
