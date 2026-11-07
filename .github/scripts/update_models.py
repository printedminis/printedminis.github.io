"""Rebuild models/models.json and pull a preview picture out of each .3mf.

Layout:
  models/<file>.3mf            -> shown on the home page
  models/<Folder>/<file>.3mf   -> shown inside the folder <Folder>
  images/[<Folder>/]<file>.jpg -> the model's picture (same path as the model)

If a picture with the model's name already exists (.png/.jpg/.jpeg/.webp) it is
kept, so you can upload your own. Otherwise the best picture stored inside the
3MF is saved as a small JPG.

gallery-settings.json (optional):
  "remove_from_names": text cut out of every model name.
  "order": file names (without .3mf) in display order for the home page.
  "folders": { "<Folder>": { "outline": "#hex", "order": [...],
                             "remove_from_names": [...] } }
             Folders appear in this order; other folders follow alphabetically.
"""
import html
import io
import json
import os
import re
import zipfile

MODELS, IMAGES = 'models', 'images'
IMAGE_EXTS = ('.png', '.jpg', '.jpeg', '.webp')
# Best first: the designer's photo/render, then the slicer's plate picture.
PREFERRED = [
    'auxiliaries/.thumbnails/thumbnail_middle.png',
    'auxiliaries/.thumbnails/thumbnail_3mf.png',
    'auxiliaries/model pictures/',
    'metadata/plate_1.png',
    'metadata/thumbnail.png',
    'auxiliaries/.thumbnails/thumbnail_small.png',
]


def load_settings():
    try:
        with open('gallery-settings.json') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def existing_image(rel_base):
    for ext in IMAGE_EXTS:
        if os.path.exists(os.path.join(IMAGES, rel_base + ext)):
            return rel_base + ext
    return None


def save_small(data, rel_base, ext):
    """Save a gallery-sized JPG (fast to load). Falls back to the original."""
    out_dir = os.path.dirname(os.path.join(IMAGES, rel_base))
    os.makedirs(out_dir, exist_ok=True)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        img.thumbnail((640, 480))
        if img.mode != 'RGB':
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.convert('RGBA').getchannel('A'))
            img = bg
        img.save(os.path.join(IMAGES, rel_base + '.jpg'), 'JPEG', quality=82, optimize=True, progressive=True)
        return rel_base + '.jpg'
    except Exception:
        with open(os.path.join(IMAGES, rel_base + ext), 'wb') as fh:
            fh.write(data)
        return rel_base + ext


def extract_image(zf, rel_base):
    names = {n.lower(): n for n in zf.namelist()}
    for want in PREFERRED:
        for low, real in names.items():
            if (low == want or (want.endswith('/') and low.startswith(want))) and low.endswith(IMAGE_EXTS):
                return save_small(zf.read(real), rel_base, os.path.splitext(low)[1])
    return None


def title_of(zf):
    try:
        root = zf.read('3D/3dmodel.model')[:200000].decode('utf-8', 'ignore')
    except KeyError:
        return None
    m = re.search(r'<metadata\s+name="Title"\s*>([^<]*)</metadata>', root)
    return html.unescape(m.group(1)).strip() if m and m.group(1).strip() else None


def clean_name(name, remove):
    for text in remove:
        shorter = re.sub(r'\s+', ' ', re.sub(re.escape(text), ' ', name, flags=re.IGNORECASE)).strip(' -')
        if shorter:  # never remove the whole name
            name = shorter
    return name


def order_key(entry, order):
    stem = os.path.splitext(os.path.basename(entry['file']))[0].lower()
    stem = re.sub(r'\s*\(\d+\)$', '', stem)  # "santa_ams (1)" -> "santa_ams"
    for i, want in enumerate(order):
        if stem == want.lower():
            return (0, i, '')
    return (1, 0, entry['name'].lower())


def read_models(folder, remove):
    """All .3mf files directly inside models/<folder> ('' = models/)."""
    directory = os.path.join(MODELS, folder)
    entries = []
    if not os.path.isdir(directory):
        return entries
    for f in sorted(os.listdir(directory), key=str.lower):
        if not f.lower().endswith('.3mf'):
            continue
        rel = f'{folder}/{f}' if folder else f
        rel_base = os.path.splitext(rel)[0]
        entry = {'file': rel, 'name': os.path.splitext(f)[0].replace('_', ' ').replace('-', ' ')}
        try:
            with zipfile.ZipFile(os.path.join(MODELS, rel)) as zf:
                entry['name'] = title_of(zf) or entry['name']
                image = existing_image(rel_base) or extract_image(zf, rel_base)
        except zipfile.BadZipFile:
            image = existing_image(rel_base)
        entry['name'] = clean_name(entry['name'], remove)
        if image:
            entry['image'] = image
        entries.append(entry)
    return entries


def main():
    settings = load_settings()
    remove = settings.get('remove_from_names', [])
    folder_settings = settings.get('folders', {})
    os.makedirs(IMAGES, exist_ok=True)

    on_disk = [d for d in os.listdir(MODELS) if os.path.isdir(os.path.join(MODELS, d)) and not d.startswith('.')]
    names = [f for f in folder_settings if f in on_disk]
    names += sorted((d for d in on_disk if d not in folder_settings), key=str.lower)

    folders = []
    for name in names:
        cfg = folder_settings.get(name, {})
        models = read_models(name, remove + cfg.get('remove_from_names', []))
        if not models:
            continue
        models.sort(key=lambda e: order_key(e, cfg.get('order', [])))
        folder = {'name': name, 'models': models}
        if cfg.get('outline'):
            folder['outline'] = cfg['outline']
        folders.append(folder)

    loose = read_models('', remove)
    loose.sort(key=lambda e: order_key(e, settings.get('order', [])))

    with open(os.path.join(MODELS, 'models.json'), 'w') as fh:
        json.dump({'folders': folders, 'models': loose}, fh, indent=2, ensure_ascii=False)
        fh.write('\n')


if __name__ == '__main__':
    main()
