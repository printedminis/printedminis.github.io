// Reads a .3mf file (including Bambu Studio / OrcaSlicer / PrusaSlicer files)
// and turns it into one colored three.js geometry.
//
// Colors come from, in order:
//   1. painted triangles (multi-color painting in Bambu/Prusa)
//   2. standard 3MF materials / color groups
//   3. the filament (extruder) each object or part is assigned to
//   4. a default grey

import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';

const DEFAULT_COLOR = '#c8ccd4';

export function parse3MF(arrayBuffer, fileName = 'model.3mf') {
  const zip = unzipSync(new Uint8Array(arrayBuffer));

  // Case-insensitive file lookup inside the zip, with or without leading "/".
  const zipIndex = new Map();
  for (const key of Object.keys(zip)) zipIndex.set(key.replace(/^\/+/, '').toLowerCase(), key);
  const readText = (path) => {
    const key = zipIndex.get(path.replace(/^\/+/, '').toLowerCase());
    return key ? strFromU8(zip[key]) : null;
  };

  // Find the main model file.
  let rootPath = '3D/3dmodel.model';
  const rels = readText('_rels/.rels');
  const relMatch = rels && rels.match(/Target="\/?([^"]+\.model)"/i);
  if (relMatch) rootPath = relMatch[1];

  const modelCache = new Map();
  const getModel = (path) => {
    const key = path.replace(/^\/+/, '').toLowerCase();
    if (!modelCache.has(key)) {
      const xml = readText(path);
      modelCache.set(key, xml ? parseModelXml(xml) : null);
    }
    return modelCache.get(key);
  };

  const root = getModel(rootPath);
  if (!root) throw new Error('This file has no 3D model inside.');

  const filaments = readFilamentColors(readText);
  const settings = readObjectSettings(readText);

  const colorCache = new Map();
  const rgb = (hex) => {
    if (!colorCache.has(hex)) {
      const c = new THREE.Color();
      try { c.setStyle(String(hex).slice(0, 7)); } catch { c.setStyle(DEFAULT_COLOR); }
      colorCache.set(hex, [c.r, c.g, c.b]);
    }
    return colorCache.get(hex);
  };
  const filamentColor = (n) => (n >= 1 && filaments[n - 1]) || null;

  const paintCache = new Map();
  const positions = [];
  const colors = [];
  const v = new THREE.Vector3();

  function addMesh(model, obj, matrix, extruder) {
    const { vertices, triangles } = obj.mesh;
    for (const t of triangles) {
      let hex = null;
      if (t.paint) {
        if (!paintCache.has(t.paint)) paintCache.set(t.paint, paintState(t.paint));
        const state = paintCache.get(t.paint);
        if (state > 0) hex = filamentColor(state);
      }
      if (!hex) {
        const pid = t.pid ?? obj.pid;
        const idx = t.p1 ?? obj.pindex;
        const group = pid != null ? model.materials.get(pid) : null;
        if (group && idx != null && group[idx]) hex = group[idx];
      }
      if (!hex) hex = filamentColor(extruder) || DEFAULT_COLOR;
      const [r, g, b] = rgb(hex);

      for (const vi of [t.v1, t.v2, t.v3]) {
        v.set(vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2]).applyMatrix4(matrix);
        positions.push(v.x, v.y, v.z);
        colors.push(r, g, b);
      }
    }
  }

  function addObject(modelPath, objectId, matrix, extruder, partExtruders, depth) {
    if (depth > 16) return;
    const model = getModel(modelPath);
    const obj = model && model.objects.get(objectId);
    if (!obj) return;
    if (obj.mesh) addMesh(model, obj, matrix, extruder);
    for (const c of obj.components) {
      const childPath = c.path || modelPath;
      const childMatrix = matrix.clone().multiply(c.matrix);
      const childExtruder = (partExtruders && partExtruders.get(c.objectId)) ?? extruder;
      addObject(childPath, c.objectId, childMatrix, childExtruder, null, depth + 1);
    }
  }

  for (const item of root.build) {
    const s = settings.get(item.objectId);
    addObject(rootPath, item.objectId, item.matrix, s?.extruder ?? 1, s?.parts, 0);
  }

  if (positions.length === 0) throw new Error('No printable shapes were found in this file.');

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const title = root.metadata.Title || prettyName(fileName);
  return { geometry, name: title, designer: root.metadata.Designer || '' };
}

function prettyName(fileName) {
  return fileName.replace(/\.3mf$/i, '').replace(/[_-]+/g, ' ').trim();
}

// --- XML parsing ----------------------------------------------------------

const byTag = (el, tag) => el.getElementsByTagNameNS('*', tag);
const childrenByTag = (el, tag) => [...el.children].filter((c) => c.localName === tag);
const num = (s) => (s == null || s === '' ? null : Number(s));

function parseMatrix(str) {
  const m = new THREE.Matrix4();
  if (!str) return m;
  const a = str.trim().split(/\s+/).map(Number);
  if (a.length !== 12) return m;
  // 3MF stores a 4x3 matrix for row vectors; three.js uses column vectors.
  m.set(a[0], a[3], a[6], a[9],
        a[1], a[4], a[7], a[10],
        a[2], a[5], a[8], a[11],
        0, 0, 0, 1);
  return m;
}

function parseModelXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This 3MF file is damaged.');
  const modelEl = doc.documentElement;

  const metadata = {};
  for (const m of childrenByTag(modelEl, 'metadata')) metadata[m.getAttribute('name')] = m.textContent.trim();

  const materials = new Map();
  for (const g of byTag(doc, 'basematerials')) {
    materials.set(g.getAttribute('id'), childrenByTag(g, 'base').map((b) => b.getAttribute('displaycolor')));
  }
  for (const g of byTag(doc, 'colorgroup')) {
    materials.set(g.getAttribute('id'), childrenByTag(g, 'color').map((c) => c.getAttribute('color')));
  }

  const objects = new Map();
  for (const o of byTag(doc, 'object')) {
    const obj = {
      pid: o.getAttribute('pid'),
      pindex: num(o.getAttribute('pindex')),
      mesh: null,
      components: [],
    };
    const meshEl = childrenByTag(o, 'mesh')[0];
    if (meshEl) {
      const vEls = byTag(meshEl, 'vertex');
      const vertices = new Float32Array(vEls.length * 3);
      for (let i = 0; i < vEls.length; i++) {
        vertices[i * 3] = +vEls[i].getAttribute('x');
        vertices[i * 3 + 1] = +vEls[i].getAttribute('y');
        vertices[i * 3 + 2] = +vEls[i].getAttribute('z');
      }
      const triangles = [];
      for (const t of byTag(meshEl, 'triangle')) {
        triangles.push({
          v1: +t.getAttribute('v1'),
          v2: +t.getAttribute('v2'),
          v3: +t.getAttribute('v3'),
          pid: t.getAttribute('pid'),
          p1: num(t.getAttribute('p1')),
          paint: t.getAttribute('paint_color') || t.getAttribute('slic3rpe:mmu_segmentation') || null,
        });
      }
      obj.mesh = { vertices, triangles };
    }
    const compsEl = childrenByTag(o, 'components')[0];
    if (compsEl) {
      for (const c of childrenByTag(compsEl, 'component')) {
        let path = null;
        for (const a of c.attributes) if (a.localName === 'path') path = a.value;
        obj.components.push({
          objectId: c.getAttribute('objectid'),
          matrix: parseMatrix(c.getAttribute('transform')),
          path: path ? path.replace(/^\/+/, '') : null,
        });
      }
    }
    objects.set(o.getAttribute('id'), obj);
  }

  const build = [];
  for (const b of byTag(doc, 'build')) {
    for (const item of childrenByTag(b, 'item')) {
      build.push({ objectId: item.getAttribute('objectid'), matrix: parseMatrix(item.getAttribute('transform')) });
    }
  }

  return { metadata, materials, objects, build };
}

// --- Slicer extras (Bambu Studio, OrcaSlicer, PrusaSlicer) ----------------

function readFilamentColors(readText) {
  const bambu = readText('Metadata/project_settings.config');
  if (bambu) {
    try {
      const cfg = JSON.parse(bambu);
      const list = cfg.filament_colour || cfg.extruder_colour;
      if (Array.isArray(list) && list.length) return list;
    } catch { /* not JSON, ignore */ }
  }
  const prusa = readText('Metadata/Slic3r_PE.config');
  if (prusa) {
    const pick = (key) => {
      const m = prusa.match(new RegExp(`^;\\s*${key}\\s*=\\s*(.+)$`, 'm'));
      return m ? m[1].split(';').map((s) => s.trim()).filter(Boolean) : [];
    };
    const extruder = pick('extruder_colour');
    const filament = pick('filament_colour');
    return extruder.map((c, i) => (c && c !== '""' ? c : filament[i])).concat(filament.slice(extruder.length));
  }
  return [];
}

// Which filament each object (and each part inside it) uses.
function readObjectSettings(readText) {
  const result = new Map();
  const xml = readText('Metadata/model_settings.config') || readText('Metadata/Slic3r_PE_model.config');
  if (!xml) return result;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const extruderOf = (el) => {
    const m = childrenByTag(el, 'metadata').find((md) => md.getAttribute('key') === 'extruder');
    return m ? num(m.getAttribute('value')) : null;
  };
  for (const o of byTag(doc, 'object')) {
    const parts = new Map();
    for (const p of childrenByTag(o, 'part')) {
      const e = extruderOf(p);
      if (e) parts.set(p.getAttribute('id'), e);
    }
    result.set(o.getAttribute('id'), { extruder: extruderOf(o) || 1, parts });
  }
  return result;
}

// Painted triangles store a hex string describing how the triangle was split
// and painted. We read every painted piece and use the most common color.
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
