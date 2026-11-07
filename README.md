# 3D Printed Minis

A gallery of 3D print models at https://printedminis.github.io. Each model gets a
preview image, and clicking it opens a full-color 3D view you can rotate and zoom.
It shows the colors saved by Bambu Studio, OrcaSlicer and PrusaSlicer (filament
colors and painted areas) and standard 3MF colors.

The site loads nothing from other websites. Everything it needs is in this repo.

## Adding models
1. Open the `models` folder on GitHub (or a folder inside it, like `models/Dogs`),
   click **Add file → Upload files**, and drop in your `.3mf` files.
2. Commit. Within about a minute a GitHub Action updates `models/models.json` and
   copies each model's preview picture (stored inside the 3MF) into `images/`.

## Folders
Each folder inside `models/` becomes a folder in the gallery. Models directly in
`models/` show on the home page. To make a new folder, upload to a new path:
on the upload page, type the folder name followed by `/` in front of the file
name box, e.g. `Cats/`.

## Gallery pictures (`images/`)
Pictures sit at the same path as their model: `models/Dogs/CorgiAMS.3mf` ->
`images/Dogs/CorgiAMS.jpg`. They're pulled out of the 3MF automatically. To use
your own picture, upload one with the same path and name (.png/.jpg/.webp) and
delete the old one.

## Settings (`gallery-settings.json`)
- `remove_from_names`: text cut out of every name, e.g. `"Knitted "`.
- `names`: exact names for single models, by file name without `.3mf`, e.g.
  `"OtterSplit": "Otter (Separate Parts)"`.
- `folders`: per folder, in the order they appear on the home page:
  - `outline`: card outline color, e.g. `"#d62828"` (red) or `"#ffffff"` (white).
  - `order`: model file names (without `.3mf`) in display order. Unlisted models
    follow, sorted by name. `"santa_ams"` also matches `santa_ams (1).3mf`.
  - `remove_from_names`: extra text to cut from names in that folder only.
- `order`: display order for models on the home page.

Edit it on GitHub (pencil icon) and commit. The gallery updates in about a minute.

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
