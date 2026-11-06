# 3D Printed Minis

A gallery of 3D print models at https://printedminis.github.io. Each model gets a
preview image, and clicking it opens a full-color 3D view you can rotate and zoom.
It shows the colors saved by Bambu Studio, OrcaSlicer and PrusaSlicer (filament
colors and painted areas) and standard 3MF colors.

The site loads nothing from other websites. Everything it needs is in this repo.

## Adding models
1. Open the `models` folder on GitHub, click **Add file → Upload files**, and drop in your `.3mf` files.
2. Commit. A GitHub Action updates `models/models.json` automatically within about a minute.

## Viewing it on your own computer
Run a small local server in this folder (double-clicking index.html won't work):

    python -m http.server 8000

then open http://localhost:8000
