import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

// Models live in "models/", their pictures in "images/". models/models.json
// lists them and is rebuilt automatically by a GitHub Action, as entries like:
//   { "file": "LeafAMS.3mf", "name": "Knitted Maple Leaf", "image": "LeafAMS.png" }
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
    const res = await fetch(MODELS_DIR + encodeURIComponent(file));
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
      worker.postMessage({ id, buffer, fileName: file }, [buffer]);
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

// Build one Object3D for the chosen plate (or all plates packed in a row),
// rotated Y-up, sitting on the ground and centered on the origin.
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

// --- Gallery --------------------------------------------------------------

function normalizeEntry(e) {
  if (typeof e === 'string') e = { file: e };
  if (!e || typeof e.file !== 'string' || !/\.3mf$/i.test(e.file)) return null;
  return { file: e.file, name: e.name || e.file.replace(/\.3mf$/i, ''), image: e.image || null };
}

async function buildGallery() {
  let entries;
  try {
    const res = await fetch(MODELS_DIR + 'models.json', { cache: 'no-cache' });
    entries = (await res.json()).map(normalizeEntry).filter(Boolean);
  } catch {
    galleryStatus.textContent = 'Could not read models/models.json.';
    galleryStatus.classList.add('error');
    return;
  }
  if (!entries.length) {
    galleryStatus.textContent = 'No models yet. Upload .3mf files to the models folder, then refresh in a minute.';
    return;
  }
  galleryStatus.textContent = '';

  const missingImages = [];
  for (const entry of entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = entry.name;
    if (entry.image) {
      const img = document.createElement('img');
      img.src = IMAGES_DIR + encodeURIComponent(entry.image);
      img.alt = entry.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onerror = () => { img.remove(); missingImage(entry, thumb); };
      thumb.append(img);
    } else {
      missingImages.push([entry, thumb]);
    }
    btn.append(thumb, name);
    btn.addEventListener('click', () => openViewer(entry));
    li.append(btn);
    grid.append(li);
  }
  for (const [entry, thumb] of missingImages) await missingImage(entry, thumb);
}

// No picture for this model: render one from the model itself.
let thumbRenderer = null;
async function missingImage(entry, thumb) {
  thumb.textContent = 'Making preview…';
  try {
    const result = await loadModel(entry.file);
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      thumbRenderer.setSize(640, 480, false);
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2e37);
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
  scene.background = new THREE.Color(0x15171c);
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

function showPlate(plateIndex) {
  const v = viewer;
  if (v.object) v.scene.remove(v.object);
  if (v.grid) { v.scene.remove(v.grid); v.grid.geometry.dispose(); }
  const { object, size } = buildObject(v.result, plateIndex);
  v.object = object;
  v.size = size;
  v.scene.add(object);
  const span = Math.max(size.x, size.z) * 1.8;
  v.grid = new THREE.GridHelper(span, 18, 0x4a505c, 0x2c3038);
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
  const token = ++openToken;
  galleryView.hidden = true;
  viewerView.hidden = false;
  viewer.resize();
  viewer.start();
  viewerName.textContent = entry.name;
  plateBar.hidden = true;
  if (viewer.object) { viewer.scene.remove(viewer.object); viewer.object = null; }
  if (viewer.grid) { viewer.scene.remove(viewer.grid); viewer.grid = null; }
  setProgress(0, 'Downloading');

  try {
    const result = await loadModel(entry.file, (f, label) => token === openToken && setProgress(f, label));
    if (token !== openToken) return;
    viewer.result = result;
    viewerName.textContent = result.designer ? `${result.name} — by ${result.designer}` : result.name;
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

function closeViewer() {
  openToken++;
  viewerView.hidden = true;
  galleryView.hidden = false;
  if (viewer) viewer.stop();
}

$('back-btn').addEventListener('click', closeViewer);
$('reset-btn').addEventListener('click', () => {
  if (viewer && viewer.size) frameCamera(viewer.camera, viewer.size, viewer.controls);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewerView.hidden) closeViewer();
});

buildGallery();
