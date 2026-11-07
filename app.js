import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// Models live in "models/" (optionally in sub-folders like models/Dogs/), and
// their pictures in "images/" at the same path. models/models.json is rebuilt
// automatically by a GitHub Action:
//   { "folders": [{ "name": "Dogs", "outline": "#fff", "models": [...] }],
//     "models": [ { "file": "x.3mf", "name": "X", "image": "x.jpg" } ] }
const MODELS_DIR = 'models/';
const IMAGES_DIR = 'images/';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const galleryStatus = $('gallery-status');
const galleryView = $('gallery-view');
const viewerView = $('viewer-view');
const viewerName = $('viewer-name');
const viewerStatus = $('viewer-status');
const progressBar = $('progress-bar');
const plateBar = $('plate-bar');
const pageTitle = $('page-title');
const pageSub = $('page-sub');
const homeLink = $('home-link');

const urlFor = (dir, path) => dir + path.split('/').map(encodeURIComponent).join('/');

// --- Light / dark theme ----------------------------------------------------

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const themeBtn = $('theme-btn');

function currentTheme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
function paintThemeButton() {
  const dark = currentTheme() === 'dark';
  themeBtn.innerHTML = dark ? SUN : MOON;
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  paintThemeButton();
  if (viewer) applyViewerTheme();
});
paintThemeButton();

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// --- Loading models in a background worker -------------------------------

const worker = new Worker(new URL('./loader-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;
worker.onmessage = (e) => {
  const job = pending.get(e.data.id);
  if (!job) return;
  if (e.data.stage) return job.onStage(e.data.stage);
  pending.delete(e.data.id);
  if (e.data.error) job.reject(new Error(e.data.error));
  else job.resolve(e.data.result);
};

const loaded = new Map(); // file -> Promise<result>

function loadModel(file, onProgress = () => {}) {
  if (loaded.has(file)) return loaded.get(file);
  const promise = (async () => {
    const res = await fetch(urlFor(MODELS_DIR, file));
    if (!res.ok) throw new Error(`Couldn't find ${file} in the models folder.`);
    const total = +res.headers.get('content-length') || 0;
    let buffer;
    if (res.body && total) {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(Math.min(got / total, 1), 'Downloading');
      }
      const data = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { data.set(c, off); off += c.length; }
      buffer = data.buffer;
    } else {
      onProgress(0, 'Downloading');
      buffer = await res.arrayBuffer();
    }
    onProgress(1, 'Reading model');
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, onStage: (s) => onProgress(1, s) });
      worker.postMessage({ id, buffer, fileName: file.split('/').pop() }, [buffer]);
    });
  })();
  loaded.set(file, promise);
  promise.catch(() => loaded.delete(file));
  return promise;
}

// --- Turning plates into meshes ------------------------------------------

const material = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.6,
  metalness: 0,
  flatShading: true,
  side: THREE.DoubleSide,
});

// One Object3D for the chosen plate (or all plates packed in a row), rotated
// Y-up, sitting on the ground and centered on the origin.
function buildObject(result, plateIndex) {
  const group = new THREE.Group();
  const list = plateIndex === 'all' ? result.plates : [result.plates[plateIndex]];
  let cursorX = 0;
  for (const plate of list) {
    plate.geometry ||= (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(plate.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(plate.colors, 3));
      g.rotateX(-Math.PI / 2); // 3MF is Z-up
      g.computeBoundingBox();
      return g;
    })();
    const box = plate.geometry.boundingBox;
    const size = box.getSize(new THREE.Vector3());
    const mesh = new THREE.Mesh(plate.geometry, material);
    const gap = list.length > 1 ? Math.max(size.x, size.z) * 0.15 + 4 : 0;
    mesh.position.set(cursorX - box.min.x, -box.min.y, -(box.min.z + box.max.z) / 2);
    cursorX += size.x + gap;
    group.add(mesh);
  }
  const full = new THREE.Box3().setFromObject(group);
  const center = full.getCenter(new THREE.Vector3());
  group.position.set(-center.x, 0, -center.z);
  return { object: group, size: full.getSize(new THREE.Vector3()) };
}

function makeLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444a55, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1, 2, 1.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-1.5, 0.5, -1);
  scene.add(fill);
}

// Fit the camera so the whole model fills the view, looking slightly down.
function frameCamera(camera, size, controls) {
  const target = new THREE.Vector3(0, size.y / 2, 0);
  const radius = Math.max(size.length() / 2, 1);
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dist = radius / Math.sin(Math.min(vFov, hFov) / 2) * 0.95;
  const dir = new THREE.Vector3(0.35, 0.35, 1).normalize();
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.near = dist / 200;
  camera.far = dist * 50;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  if (controls) {
    controls.target.copy(target);
    controls.minDistance = radius * 0.2;
    controls.maxDistance = dist * 4;
    controls.update();
  }
}

// --- Gallery data ----------------------------------------------------------

function normalizeEntry(e) {
  if (typeof e === 'string') e = { file: e };
  if (!e || typeof e.file !== 'string' || !/\.3mf$/i.test(e.file)) return null;
  const base = e.file.split('/').pop().replace(/\.3mf$/i, '');
  return { file: e.file, name: e.name || base, image: e.image || null };
}

let catalog = null; // { folders: [{ name, outline, models }], models: [] }
const modelIndex = new Map(); // file -> { entry, folder }

async function loadCatalog() {
  const res = await fetch(MODELS_DIR + 'models.json', { cache: 'no-cache' });
  const data = await res.json();
  if (Array.isArray(data)) return { folders: [], models: data.map(normalizeEntry).filter(Boolean) };
  return {
    folders: (data.folders || [])
      .map((f) => ({ name: String(f.name), outline: f.outline || null, models: (f.models || []).map(normalizeEntry).filter(Boolean) }))
      .filter((f) => f.models.length),
    models: (data.models || []).map(normalizeEntry).filter(Boolean),
  };
}

// --- Gallery rendering -----------------------------------------------------

const FOLDER_ICON = '<svg class="folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.5h8.4A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';

function imageEl(entry) {
  const img = document.createElement('img');
  img.src = urlFor(IMAGES_DIR, entry.image);
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  return img;
}

function applyOutline(card, color) {
  if (!color) return;
  card.classList.add('outlined');
  card.style.setProperty('--outline', color);
}

function modelCard(entry, outline) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'card';
  a.href = '#/model/' + encodeURIComponent(entry.file);
  applyOutline(a, outline);
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = entry.name;
  if (entry.image) {
    const img = imageEl(entry);
    img.alt = entry.name;
    img.onerror = () => { img.remove(); renderPreview(entry, thumb); };
    thumb.append(img);
  } else {
    queuePreview(entry, thumb);
  }
  a.append(thumb, name);
  li.append(a);
  return li;
}

function folderCard(folder) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'card';
  a.href = '#/folder/' + encodeURIComponent(folder.name);
  applyOutline(a, folder.outline);
  const thumb = document.createElement('span');
  const withImages = folder.models.filter((m) => m.image);
  // 4+ models: 2x2 collage, 2-3: two side by side, 1: a single picture.
  const covers = withImages.slice(0, withImages.length >= 4 ? 4 : Math.min(withImages.length, 2));
  thumb.className = 'thumb collage' + (covers.length === 2 ? ' two' : covers.length < 2 ? ' one' : '');
  for (const m of covers) {
    const img = imageEl(m);
    img.loading = 'eager';
    thumb.append(img);
  }
  const name = document.createElement('span');
  name.className = 'card-name';
  name.innerHTML = FOLDER_ICON;
  const label = document.createElement('span');
  label.textContent = folder.name;
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${folder.models.length} model${folder.models.length === 1 ? '' : 's'}`;
  name.append(label, count);
  a.append(thumb, name);
  a.setAttribute('aria-label', `${folder.name} folder, ${count.textContent}`);
  li.append(a);
  return li;
}

function showHome() {
  pageTitle.textContent = '3D Printed Minis';
  pageSub.textContent = catalog.folders.length ? 'Open a folder, or click a model to view it in 3D.' : 'Click a model to view it in 3D.';
  homeLink.hidden = true;
  document.title = '3D Printed Minis';
  grid.replaceChildren(
    ...catalog.folders.map(folderCard),
    ...catalog.models.map((m) => modelCard(m, null)),
  );
  galleryStatus.textContent = grid.children.length ? '' : 'No models yet. Upload .3mf files to the models folder, then refresh in a minute.';
}

function showFolder(folder) {
  pageTitle.textContent = folder.name;
  pageSub.textContent = `${folder.models.length} model${folder.models.length === 1 ? '' : 's'} · click one to view it in 3D.`;
  homeLink.hidden = false;
  document.title = `${folder.name} · 3D Printed Minis`;
  grid.replaceChildren(...folder.models.map((m) => modelCard(m, folder.outline)));
  galleryStatus.textContent = '';
}

// Pictures made from the model itself, for models without an image.
let thumbRenderer = null;
const previewQueue = [];
let previewBusy = false;
function queuePreview(entry, thumb) {
  thumb.textContent = 'Making preview…';
  previewQueue.push([entry, thumb]);
  if (!previewBusy) runPreviews();
}
async function runPreviews() {
  previewBusy = true;
  while (previewQueue.length) {
    const [entry, thumb] = previewQueue.shift();
    if (thumb.isConnected) await renderPreview(entry, thumb);
  }
  previewBusy = false;
}
async function renderPreview(entry, thumb) {
  thumb.textContent = 'Making preview…';
  try {
    const result = await loadModel(entry.file);
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      thumbRenderer.setSize(640, 480, false);
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar('--thumb'));
    makeLights(scene);
    const { object, size } = buildObject(result, result.plates.length > 1 ? 'all' : 0);
    scene.add(object);
    const camera = new THREE.PerspectiveCamera(35, 640 / 480, 0.1, 1000);
    frameCamera(camera, size);
    thumbRenderer.render(scene, camera);
    const img = new Image();
    img.alt = entry.name;
    img.src = thumbRenderer.domElement.toDataURL('image/png');
    thumb.replaceChildren(img);
  } catch (err) {
    console.error(entry.file, err);
    thumb.textContent = 'No preview';
  }
}

// --- Viewer ---------------------------------------------------------------

let viewer = null;

function setupViewer() {
  const container = $('viewer-canvas');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  makeLights(scene);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 0.8;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;

  const v = { renderer, scene, camera, controls, object: null, grid: null, size: null, running: false, result: null };

  v.resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', v.resize);
  renderer.domElement.addEventListener('dblclick', () => v.size && frameCamera(camera, v.size, controls));

  const loop = () => {
    if (!v.running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  v.start = () => { if (!v.running) { v.running = true; loop(); } };
  v.stop = () => { v.running = false; };
  return v;
}

function makeGrid(size) {
  const span = Math.max(size.x, size.z) * 1.8;
  return new THREE.GridHelper(span, 18, new THREE.Color(cssVar('--grid-main')), new THREE.Color(cssVar('--grid-line')));
}

function applyViewerTheme() {
  viewer.scene.background = new THREE.Color(cssVar('--viewer-bg'));
  if (viewer.grid && viewer.size) {
    viewer.scene.remove(viewer.grid);
    viewer.grid.geometry.dispose();
    viewer.grid = makeGrid(viewer.size);
    viewer.scene.add(viewer.grid);
  }
}

function showPlate(plateIndex) {
  const v = viewer;
  if (v.object) v.scene.remove(v.object);
  if (v.grid) { v.scene.remove(v.grid); v.grid.geometry.dispose(); }
  const { object, size } = buildObject(v.result, plateIndex);
  v.object = object;
  v.size = size;
  v.scene.add(object);
  v.grid = makeGrid(size);
  v.scene.add(v.grid);
  frameCamera(v.camera, size, v.controls);
  for (const b of plateBar.querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.plate === String(plateIndex)));
  }
}

function renderPlateButtons(result) {
  plateBar.replaceChildren();
  plateBar.hidden = result.plates.length < 2;
  if (plateBar.hidden) return;
  const add = (label, value) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.plate = String(value);
    b.addEventListener('click', () => showPlate(value));
    plateBar.append(b);
  };
  add('All parts', 'all');
  result.plates.forEach((p, i) => add(p.name, i));
}

function setProgress(fraction, label) {
  viewerStatus.classList.remove('error');
  viewerStatus.textContent = label === 'Downloading' ? `Downloading… ${Math.round(fraction * 100)}%` : `${label}…`;
  progressBar.hidden = false;
  progressBar.firstElementChild.style.width = `${Math.round((label === 'Downloading' ? fraction * 0.8 : 0.9) * 100)}%`;
}

let openToken = 0;
async function openViewer(entry) {
  if (!viewer) viewer = setupViewer();
  applyViewerTheme();
  const token = ++openToken;
  galleryView.hidden = true;
  viewerView.hidden = false;
  document.body.classList.add('viewing');
  viewer.resize();
  viewer.start();
  viewerName.textContent = entry.name;
  document.title = `${entry.name} · 3D Printed Minis`;
  plateBar.hidden = true;
  if (viewer.object) { viewer.scene.remove(viewer.object); viewer.object = null; }
  if (viewer.grid) { viewer.scene.remove(viewer.grid); viewer.grid = null; }
  setProgress(0, 'Downloading');

  try {
    const result = await loadModel(entry.file, (f, label) => token === openToken && setProgress(f, label));
    if (token !== openToken) return;
    viewer.result = result;
    renderPlateButtons(result);
    showPlate(result.plates.length > 1 ? 'all' : 0);
    viewerStatus.textContent = '';
    progressBar.hidden = true;
  } catch (err) {
    if (token !== openToken) return;
    console.error(err);
    progressBar.hidden = true;
    viewerStatus.textContent = err.message || 'This model could not be opened.';
    viewerStatus.classList.add('error');
  }
}

function hideViewer() {
  openToken++;
  viewerView.hidden = true;
  galleryView.hidden = false;
  document.body.classList.remove('viewing');
  if (viewer) viewer.stop();
}

// --- Routing: #/folder/<name> and #/model/<path> ---------------------------

let navigatedInApp = false;
let parentHash = '#';

function route() {
  if (!catalog) return;
  const hash = location.hash;
  const [, kind, raw] = hash.match(/^#\/(folder|model)\/(.+)$/) || [];
  const value = raw ? decodeURIComponent(raw) : null;

  if (kind === 'model' && modelIndex.has(value)) {
    const { entry, folder } = modelIndex.get(value);
    parentHash = folder ? '#/folder/' + encodeURIComponent(folder.name) : '#';
    if (folder) showFolder(folder); else showHome();
    openViewer(entry);
    return;
  }
  hideViewer();
  const folder = kind === 'folder' && catalog.folders.find((f) => f.name === value);
  if (folder) showFolder(folder); else showHome();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => { navigatedInApp = true; route(); });

function goBack() {
  // Use the browser's history when we got here by clicking, so the gallery
  // keeps its scroll position; otherwise jump straight to the parent page.
  if (navigatedInApp && history.length > 1) history.back();
  else location.hash = parentHash;
}

$('back-btn').addEventListener('click', goBack);
$('reset-btn').addEventListener('click', () => {
  if (viewer && viewer.size) frameCamera(viewer.camera, viewer.size, viewer.controls);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewerView.hidden) goBack();
});

(async () => {
  try {
    catalog = await loadCatalog();
  } catch {
    galleryStatus.textContent = 'Could not read models/models.json.';
    galleryStatus.classList.add('error');
    return;
  }
  for (const folder of catalog.folders) for (const m of folder.models) modelIndex.set(m.file, { entry: m, folder });
  for (const m of catalog.models) modelIndex.set(m.file, { entry: m, folder: null });
  route();
})();
