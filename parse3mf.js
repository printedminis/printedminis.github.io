// Fast .3mf reader (Bambu Studio, OrcaSlicer, PrusaSlicer and standard 3MF).
// Plain string scanning instead of an XML parser, so it can run in a Web
// Worker and handle files with millions of triangles in a few seconds.
//
// Returns one colored triangle soup per print plate:
//   { name, designer, plates: [{ name, positions: Float32Array, colors: Float32Array }] }
//
// Triangle colors come from, in order: painted areas, standard 3MF colors,
// the filament the part/object is assigned to, then a default grey.

import { unzipSync, strFromU8 } from './vendor/fflate.js';

const DEFAULT_COLOR = '#c8ccd4';
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function parse3MF(buffer, fileName = 'model.3mf', onStage = () => {}) {
  onStage('Unzipping');
  const zip = unzipSync(new Uint8Array(buffer));
  const zipIndex = new Map();
  for (const key of Object.keys(zip)) zipIndex.set(normPath(key), key);
  const readText = (path) => {
    const key = zipIndex.get(normPath(path));
    return key ? strFromU8(zip[key]) : null;
  };

  let rootPath = '3D/3dmodel.model';
  const rels = readText('_rels/.rels');
  const relMatch = rels && rels.match(/Target="\/?([^"]+\.model)"/i);
  if (relMatch) rootPath = relMatch[1];

  onStage('Reading shapes');
  const modelCache = new Map();
  const getModel = (path) => {
    const key = normPath(path);
    if (!modelCache.has(key)) {
      const text = readText(path);
      modelCache.set(key, text ? parseModel(text) : null);
    }
    return modelCache.get(key);
  };
  const root = getModel(rootPath);
  if (!root) throw new Error('This file has no 3D model inside.');

  const filaments = readFilamentColors(readText).map(hexToLinear);
  const settings = readObjectSettings(readText);
  const plateDefs = readPlates(readText);
  const defaultColor = hexToLinear(DEFAULT_COLOR);
  const colorCache = new Map();
  const color = (hex) => {
    if (!colorCache.has(hex)) colorCache.set(hex, hexToLinear(hex));
    return colorCache.get(hex);
  };
  const paintCache = new Map();

  // Each build item goes to the plate that lists its object id.
  const groups = plateDefs.map((p) => ({ name: p.name, ids: p.objectIds, chunks: [] }));
  const other = { name: groups.length ? 'Other parts' : 'Model', ids: null, chunks: [] };
  const groupFor = (objectId) => groups.find((g) => g.ids.has(objectId)) || other;

  onStage('Building model');
  function emitMesh(model, obj, matrix, extruder, out) {
    const { verts, tris, triPid, triP1, triPaint } = obj.mesh;
    const n = tris.length / 3;
    const pos = new Float32Array(n * 9);
    const col = new Float32Array(n * 9);
    const m = matrix;
    const flip = det3(m) < 0;
    const fallback = (extruder >= 1 && filaments[extruder - 1]) || defaultColor;
    let objColor = null;
    if (obj.pid != null && obj.pindex != null) {
      const g = model.materials.get(obj.pid);
      if (g && g[obj.pindex]) objColor = color(g[obj.pindex]);
    }

    for (let t = 0; t < n; t++) {
      let c = null;
      const paint = triPaint && triPaint[t];
      if (paint) {
        let s = paintCache.get(paint);
        if (s === undefined) { s = paintState(paint); paintCache.set(paint, s); }
        if (s > 0 && filaments[s - 1]) c = filaments[s - 1];
      }
      if (!c && triPid) {
        const pid = triPid[t] ?? obj.pid;
        const idx = triP1[t] ?? obj.pindex;
        const g = pid != null ? model.materials.get(pid) : null;
        if (g && idx != null && g[idx]) c = color(g[idx]);
      }
      if (!c) c = objColor || fallback;

      for (let k = 0; k < 3; k++) {
        const vi = tris[t * 3 + (flip && k ? 3 - k : k)] * 3;
        const x = verts[vi], y = verts[vi + 1], z = verts[vi + 2];
        const o = t * 9 + k * 3;
        pos[o] = x * m[0] + y * m[3] + z * m[6] + m[9];
        pos[o + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
        pos[o + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
        col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
      }
    }
    out.chunks.push({ pos, col });
  }

  function addObject(modelPath, objectId, matrix, extruder, partExtruders, out, depth) {
    if (depth > 16) return;
    const model = getModel(modelPath);
    const obj = model && model.objects.get(objectId);
    if (!obj) return;
    if (obj.mesh) emitMesh(model, obj, matrix, extruder, out);
    for (const c of obj.components) {
      const childExtruder = (partExtruders && partExtruders.get(c.objectId)) ?? extruder;
      addObject(c.path || modelPath, c.objectId, mul(c.matrix, matrix), childExtruder, null, out, depth + 1);
    }
  }

  for (const item of root.build) {
    const s = settings.get(item.objectId);
    addObject(rootPath, item.objectId, item.matrix, s?.extruder ?? 1, s?.parts, groupFor(item.objectId), 0);
  }

  const plates = [];
  for (const g of [...groups, other]) {
    if (!g.chunks.length) continue;
    const total = g.chunks.reduce((sum, c) => sum + c.pos.length, 0);
    const positions = new Float32Array(total);
    const colors = new Float32Array(total);
    let off = 0;
    for (const c of g.chunks) { positions.set(c.pos, off); colors.set(c.col, off); off += c.pos.length; }
    plates.push({ name: g.name || `Plate ${plates.length + 1}`, positions, colors });
  }
  if (!plates.length) throw new Error('No printable shapes were found in this file.');

  return {
    name: root.metadata.Title || prettyName(fileName),
    designer: root.metadata.Designer || '',
    plates,
  };
}

// --- helpers --------------------------------------------------------------

function normPath(p) { return p.replace(/^\/+/, '').toLowerCase(); }

export function prettyName(fileName) {
  return fileName.replace(/\.3mf$/i, '').replace(/[_-]+/g, ' ').trim();
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function hexToLinear(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{6}/i.test(h)) return hexToLinear(DEFAULT_COLOR);
  return [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
}

// 3MF matrices are 12 numbers for row vectors: p' = p * M.
function parseMatrix(str) {
  if (!str) return IDENTITY;
  const a = str.trim().split(/\s+/).map(Number);
  return a.length === 12 && a.every(Number.isFinite) ? a : IDENTITY;
}

// Apply A first, then B.
function mul(A, B) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    }
  }
  for (let j = 0; j < 3; j++) {
    r[9 + j] = A[9] * B[j] + A[10] * B[3 + j] + A[11] * B[6 + j] + B[9 + j];
  }
  return r;
}

function det3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

function attr(tag, name) {
  const re = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`);
  const m = tag.match(re);
  return m ? m[1] : null;
}

// Fast attribute read for the hot loops. `key` looks like ' x="'.
function quick(tag, key) {
  const k = tag.indexOf(key);
  if (k < 0) return null;
  const s = k + key.length;
  return tag.slice(s, tag.indexOf('"', s));
}

function parseModel(s) {
  const metadata = {};
  for (const m of s.matchAll(/<metadata\s+name="([^"]+)"\s*>([\s\S]*?)<\/metadata>/g)) {
    if (!(m[1] in metadata)) metadata[m[1]] = decodeXml(m[2].trim());
  }

  const materials = new Map();
  for (const m of s.matchAll(/<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g)) {
    materials.set(attr(m[1], 'id'), [...m[2].matchAll(/displaycolor="([^"]+)"/g)].map((x) => x[1]));
  }
  for (const m of s.matchAll(/<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g)) {
    materials.set(attr(m[1], 'id'), [...m[2].matchAll(/\bcolor="([^"]+)"/g)].map((x) => x[1]));
  }

  const objects = new Map();
  const openRe = /<(?:\w+:)?object[\s>]/g;
  let m;
  while ((m = openRe.exec(s))) {
    const start = m.index;
    const tagEnd = s.indexOf('>', start);
    const openTag = s.slice(start, tagEnd + 1);
    let end;
    if (openTag.endsWith('/>')) end = tagEnd;
    else {
      const closeRe = /<\/(?:\w+:)?object>/g;
      closeRe.lastIndex = tagEnd;
      const c = closeRe.exec(s);
      end = c ? c.index : s.length;
    }
    const obj = {
      pid: attr(openTag, 'pid'),
      pindex: attr(openTag, 'pindex') != null ? +attr(openTag, 'pindex') : null,
      mesh: null,
      components: [],
    };
    const meshStart = s.indexOf('<mesh', tagEnd);
    if (meshStart !== -1 && meshStart < end) obj.mesh = parseMesh(s, meshStart, end);
    const body = obj.mesh ? '' : s.slice(tagEnd, end);
    for (const cm of body.matchAll(/<(?:\w+:)?component\b([^>]*)>/g)) {
      const path = attr(cm[1], 'path');
      obj.components.push({
        objectId: attr(cm[1], 'objectid'),
        matrix: parseMatrix(attr(cm[1], 'transform')),
        path: path ? path.replace(/^\/+/, '') : null,
      });
    }
    objects.set(attr(openTag, 'id'), obj);
    openRe.lastIndex = end;
  }

  const build = [];
  const buildMatch = s.match(/<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/);
  if (buildMatch) {
    for (const im of buildMatch[1].matchAll(/<(?:\w+:)?item\b([^>]*)>/g)) {
      build.push({ objectId: attr(im[1], 'objectid'), matrix: parseMatrix(attr(im[1], 'transform')) });
    }
  }
  return { metadata, materials, objects, build };
}

function parseMesh(s, from, to) {
  const verts = [];
  let i = from;
  while ((i = s.indexOf('<vertex', i)) !== -1 && i < to) {
    const e = s.indexOf('>', i);
    const tag = s.slice(i, e);
    verts.push(+quick(tag, ' x="'), +quick(tag, ' y="'), +quick(tag, ' z="'));
    i = e;
  }

  const tris = [];
  let triPid = null, triP1 = null, triPaint = null;
  i = from;
  let t = 0;
  while ((i = s.indexOf('<triangle', i)) !== -1 && i < to) {
    const e = s.indexOf('>', i);
    const tag = s.slice(i, e);
    i = e;
    if (tag.startsWith('<triangles')) continue;
    tris.push(+quick(tag, ' v1="'), +quick(tag, ' v2="'), +quick(tag, ' v3="'));
    if (tag.length > 40) {
      const paint = quick(tag, ' paint_color="') || quick(tag, ' slic3rpe:mmu_segmentation="');
      if (paint) (triPaint ||= [])[t] = paint;
      const pid = quick(tag, ' pid="');
      const p1 = quick(tag, ' p1="');
      if (pid != null || p1 != null) {
        (triPid ||= [])[t] = pid;
        (triP1 ||= [])[t] = p1 != null ? +p1 : null;
      }
    }
    t++;
  }
  if (triPid) triP1 ||= [];
  return { verts: new Float32Array(verts), tris: new Uint32Array(tris), triPid, triP1, triPaint };
}

// --- slicer extras --------------------------------------------------------

function readFilamentColors(readText) {
  const bambu = readText('Metadata/project_settings.config');
  if (bambu) {
    try {
      const cfg = JSON.parse(bambu);
      const list = cfg.filament_colour || cfg.extruder_colour;
      if (Array.isArray(list) && list.length) return list;
    } catch { /* not JSON */ }
  }
  const prusa = readText('Metadata/Slic3r_PE.config');
  if (prusa) {
    const pick = (key) => {
      const m = prusa.match(new RegExp(`^;\\s*${key}\\s*=\\s*(.+)$`, 'm'));
      return m ? m[1].split(';').map((x) => x.trim().replace(/"/g, '')) : [];
    };
    const ext = pick('extruder_colour');
    const fil = pick('filament_colour');
    const n = Math.max(ext.length, fil.length);
    return Array.from({ length: n }, (_, k) => ext[k] || fil[k] || DEFAULT_COLOR);
  }
  return [];
}

function extruderIn(xml) {
  const m = xml.match(/key="extruder"\s+value="(\d+)"/);
  return m ? +m[1] : null;
}

function readObjectSettings(readText) {
  const result = new Map();
  const xml = readText('Metadata/model_settings.config') || readText('Metadata/Slic3r_PE_model.config');
  if (!xml) return result;
  for (const m of xml.matchAll(/<object\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const body = m[2];
    const firstPart = body.search(/<(part|volume)\b/);
    const own = firstPart === -1 ? body : body.slice(0, firstPart);
    const parts = new Map();
    for (const p of body.matchAll(/<part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)) {
      const e = extruderIn(p[2]);
      if (e) parts.set(p[1], e);
    }
    result.set(m[1], { extruder: extruderIn(own) || 1, parts });
  }
  return result;
}

function readPlates(readText) {
  const xml = readText('Metadata/model_settings.config');
  if (!xml) return [];
  const plates = [];
  for (const m of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const name = (m[1].match(/key="plater_name"\s+value="([^"]*)"/) || [])[1];
    const ids = new Set([...m[1].matchAll(/key="object_id"\s+value="([^"]+)"/g)].map((x) => x[1]));
    if (ids.size) plates.push({ name: name ? decodeXml(name) : '', objectIds: ids });
  }
  return plates;
}

// Painted triangles store a hex string describing how the triangle was split
// and painted. Read every painted piece and use the most common color.
function paintState(code) {
  let i = code.length - 1;
  const next = () => (i >= 0 ? parseInt(code[i--], 16) : 0);
  const counts = new Map();
  const walk = (depth) => {
    if (i < 0 || depth > 32) return;
    const n = next();
    const splits = n & 3;
    if (splits === 0) {
      let state = n >> 2;
      if (state === 3) state = next() + 3;
      counts.set(state, (counts.get(state) || 0) + 1);
    } else {
      for (let k = 0; k <= splits; k++) walk(depth + 1);
    }
  };
  walk(0);
  let best = 0, bestCount = -1;
  for (const [s, c] of counts) if (c > bestCount) { best = s; bestCount = c; }
  return best;
}
