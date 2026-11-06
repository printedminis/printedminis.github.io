"""Rebuild models/models.json and pull a preview picture out of each .3mf.

gallery-settings.json (optional) controls:
  * "remove_from_names": text cut out of every model name, e.g. "Knitted ".
  * "order": file names (without .3mf) in the order they should appear. A name
    also matches re-uploads like "santa_ams (1).3mf". Models not listed go
    after these, sorted by name.

For every models/<name>.3mf:
  * if images/<name>.png/.jpg/.jpeg/.webp already exists, that picture is used
    (so you can drop in your own photo);
  * otherwise the best picture stored inside the 3MF is copied to images/.
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


def existing_image(base):
    for ext in IMAGE_EXTS:
        if os.path.exists(os.path.join(IMAGES, base + ext)):
            return base + ext
    return None


def save_small(data, base, ext):
    """Save a gallery-sized JPG (fast to load). Falls back to the original."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        img.thumbnail((640, 480))
        if img.mode != 'RGB':
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.convert('RGBA').getchannel('A'))
            img = bg
        img.save(os.path.join(IMAGES, base + '.jpg'), 'JPEG', quality=82, optimize=True, progressive=True)
        return base + '.jpg'
    except Exception:
        with open(os.path.join(IMAGES, base + ext), 'wb') as fh:
            fh.write(data)
        return base + ext


def extract_image(zf, base):
    names = {n.lower(): n for n in zf.namelist()}
    for want in PREFERRED:
        for low, real in names.items():
            if (low == want or (want.endswith('/') and low.startswith(want))) and low.endswith(IMAGE_EXTS):
                return save_small(zf.read(real), base, os.path.splitext(low)[1])
    return None


def title_of(zf):
    try:
        root = zf.read('3D/3dmodel.model')[:200000].decode('utf-8', 'ignore')
    except KeyError:
        return None
    m = re.search(r'<metadata\s+name="Title"\s*>([^<]*)</metadata>', root)
    return html.unescape(m.group(1)).strip() if m and m.group(1).strip() else None


def load_settings():
    try:
        with open('gallery-settings.json') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def clean_name(name, remove):
    for text in remove:
        name = re.sub(re.escape(text), ' ', name, flags=re.IGNORECASE)
    return re.sub(r'\s+', ' ', name).strip(' -') or name


def order_key(entry, order):
    stem = os.path.splitext(entry['file'])[0].lower()
    stem = re.sub(r'\s*\(\d+\)$', '', stem)  # "santa_ams (1)" -> "santa_ams"
    for i, want in enumerate(order):
        if stem == want.lower():
            return (0, i, '')
    return (1, 0, entry['name'].lower())


def main():
    settings = load_settings()
    remove = settings.get('remove_from_names', [])
    order = settings.get('order', [])
    os.makedirs(IMAGES, exist_ok=True)
    entries = []
    for f in sorted(os.listdir(MODELS), key=str.lower):
        if not f.lower().endswith('.3mf'):
            continue
        base = os.path.splitext(f)[0]
        entry = {'file': f, 'name': base.replace('_', ' ').replace('-', ' ')}
        try:
            with zipfile.ZipFile(os.path.join(MODELS, f)) as zf:
                entry['name'] = title_of(zf) or entry['name']
                image = existing_image(base) or extract_image(zf, base)
        except zipfile.BadZipFile:
            image = existing_image(base)
        entry['name'] = clean_name(entry['name'], remove)
        if image:
            entry['image'] = image
        entries.append(entry)
    entries.sort(key=lambda e: order_key(e, order))
    with open(os.path.join(MODELS, 'models.json'), 'w') as fh:
        json.dump(entries, fh, indent=2, ensure_ascii=False)
        fh.write('\n')


if __name__ == '__main__':
    main()
