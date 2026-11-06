"""Rebuild models/models.json and pull a preview picture out of each .3mf.

For every models/<name>.3mf:
  * if images/<name>.png/.jpg/.jpeg/.webp already exists, that picture is used
    (so you can drop in your own photo);
  * otherwise the best picture stored inside the 3MF is copied to images/.
"""
import html
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


def extract_image(zf, base):
    names = {n.lower(): n for n in zf.namelist()}
    for want in PREFERRED:
        for low, real in names.items():
            if (low == want or (want.endswith('/') and low.startswith(want))) and low.endswith(IMAGE_EXTS):
                ext = os.path.splitext(low)[1]
                with open(os.path.join(IMAGES, base + ext), 'wb') as fh:
                    fh.write(zf.read(real))
                return base + ext
    return None


def title_of(zf):
    try:
        root = zf.read('3D/3dmodel.model')[:200000].decode('utf-8', 'ignore')
    except KeyError:
        return None
    m = re.search(r'<metadata\s+name="Title"\s*>([^<]*)</metadata>', root)
    return html.unescape(m.group(1)).strip() if m and m.group(1).strip() else None


def main():
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
        if image:
            entry['image'] = image
        entries.append(entry)
    with open(os.path.join(MODELS, 'models.json'), 'w') as fh:
        json.dump(entries, fh, indent=2, ensure_ascii=False)
        fh.write('\n')


if __name__ == '__main__':
    main()
