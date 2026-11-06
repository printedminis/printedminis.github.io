# 3D Printed Minis

A gallery of 3D print models at https://printedminis.github.io. Each model gets a
preview image, and clicking it opens a full-color 3D view you can rotate and zoom.
It shows the colors saved by Bambu Studio, OrcaSlicer and PrusaSlicer (filament
colors and painted areas) and standard 3MF colors.

The site loads nothing from other websites. Everything it needs is in this repo.

## Adding models
1. Open the `models` folder on GitHub, click **Add file → Upload files**, and drop in your `.3mf` files.
2. Commit. Within about a minute a GitHub Action updates `models/models.json` and
   copies each model's preview picture (stored inside the 3MF) into `images/`.

## Gallery pictures (`images/`)
Each model's card shows `images/<model name>.png` (or .jpg/.webp). They're pulled
out of the 3MF automatically. To use your own picture instead, upload one with
the same name as the model, e.g. `images/LeafAMS.jpg` for `models/LeafAMS.3mf`,
and delete the old one.

## Viewing it on your own computer
Run a small local server in this folder (double-clicking index.html won't work):

    python -m http.server 8000

then open http://localhost:8000

## Order and names (`gallery-settings.json`)
- `order`: model file names (without `.3mf`) in the order they appear. Models not
  in the list go after these, sorted by name. `"santa_ams"` also matches
  re-uploads like `santa_ams (1).3mf`.
- `remove_from_names`: text cut out of every name, e.g. `"Knitted "` and `" - Christmas"`.

Edit it on GitHub (pencil icon) and commit. The gallery updates in about a minute.
