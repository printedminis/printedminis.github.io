import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { parse3MF } from './threemf.js';

// .3mf files go in the "models" folder. models/models.json lists them; a
// GitHub Action rebuilds that list automatically whenever models change.
const MODELS_DIR = 'models/';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const galleryStatus = $('gallery-status');
const galleryView = $('gallery-view');
const viewerView = $('viewer-view');
const viewerName = $('viewer-name');
const viewerStatus = $('viewer-status');

const loaded = new Map(); // file name -> { geometry, name, designer }

// --- Shared scene helpers -------------------------------------------------

function makeScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 1.6, 1.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-1.2, 0.4, -1);
  scene.add(fill);
  return scene;
}

const material = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.65,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

// 3MF is Z-up; three.js is Y-up. Rotate and center the model on the ground.
function makeModelMesh(geometry) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  mesh.position.set(-center.x, -box.min.y, -center.z);
  mesh.updateMatrixWorld(true);
  return { object: mesh, size: box.getSize(new THREE.Vector3()) };
}

function frameCamera(camera, size, controls) {
  const radius = Math.max(size.length() / 2, 1);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (radius / Math.sin(fov / 2)) * 1.05;
  const target = new THREE.Vector3(0, size.y / 2, 0);
  const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  if (controls) {
    controls.target.copy(target);
    controls.update();
  }
}

async function loadModel(file) {
  if (loaded.has(file)) return loaded.get(file);
  const res = await fetch(MODELS_DIR + encodeURIComponent(file));
  if (!res.ok) throw new Error(`Couldn't find ${file} in the models folder.`);
  const result = parse3MF(await res.arrayBuffer(), file);
  loaded.set(file, result);
  return result;
}

// --- Gallery with preview images ------------------------------------------

const THUMB_SIZE = 512;
let thumbRenderer = null;

function renderThumbnail(geometry) {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
  }
  const scene = makeScene();
  scene.background = new THREE.Color(0x2a2e37);
  const { object, size } = makeModelMesh(geometry);
  scene.add(object);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  frameCamera(camera, size);
  thumbRenderer.render(scene, camera);
  return thumbRenderer.domElement.toDataURL('image/png');
}

function makeCard(file) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  thumb.textContent = 'Loading preview…';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = file.replace(/\.3mf$/i, '');
  btn.append(thumb, name);
  btn.addEventListener('click', () => openViewer(file));
  li.append(btn);
  grid.append(li);
  return { thumb, name };
}

async function buildGallery() {
  let files;
  try {
    const res = await fetch(MODELS_DIR + 'models.json', { cache: 'no-cache' });
    files = await res.json();
  } catch {
    galleryStatus.textContent = 'Could not read models/models.json. Check that it exists and lists your .3mf files.';
    galleryStatus.classList.add('error');
    return;
  }
  files = files.filter((f) => typeof f === 'string' && /\.3mf$/i.test(f));
  if (!files.length) {
    galleryStatus.textContent = 'No models yet. Upload .3mf files to the models folder, then refresh in a minute.';
    return;
  }
  galleryStatus.textContent = '';

  const cards = files.map((f) => [f, makeCard(f)]);
  // Make previews one at a time so big files don't freeze the page.
  for (const [file, card] of cards) {
    try {
      const model = await loadModel(file);
      card.name.textContent = model.name;
      const img = new Image();
      img.alt = `Preview of ${model.name}`;
      img.src = renderThumbnail(model.geometry);
      card.thumb.replaceChildren(img);
    } catch (err) {
      console.error(file, err);
      card.thumb.textContent = 'Preview failed';
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

// --- Full-screen viewer ---------------------------------------------------

let viewer = null;

function setupViewer() {
  const container = $('viewer-canvas');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);
  const scene = makeScene();
  scene.background = new THREE.Color(0x15171c);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  const v = { renderer, scene, camera, controls, resize, current: null, grid: null, size: null, running: false };
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

async function openViewer(file) {
  if (!viewer) viewer = setupViewer();
  galleryView.hidden = true;
  viewerView.hidden = false;
  viewer.resize();
  viewerName.textContent = loaded.get(file)?.name || file.replace(/\.3mf$/i, '');
  viewerStatus.textContent = 'Loading model…';
  viewerStatus.classList.remove('error');

  if (viewer.current) viewer.scene.remove(viewer.current);
  if (viewer.grid) viewer.scene.remove(viewer.grid);
  viewer.current = null;
  viewer.start();

  try {
    const model = await loadModel(file);
    viewerName.textContent = model.designer ? `${model.name} — by ${model.designer}` : model.name;
    const { object, size } = makeModelMesh(model.geometry);
    viewer.current = object;
    viewer.size = size;
    viewer.scene.add(object);
    const span = Math.max(size.x, size.z) * 1.6;
    viewer.grid = new THREE.GridHelper(span, 16, 0x4a505c, 0x30343d);
    viewer.scene.add(viewer.grid);
    frameCamera(viewer.camera, size, viewer.controls);
    viewerStatus.textContent = '';
  } catch (err) {
    console.error(err);
    viewerStatus.textContent = err.message || 'This model could not be opened.';
    viewerStatus.classList.add('error');
  }
}

function closeViewer() {
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
