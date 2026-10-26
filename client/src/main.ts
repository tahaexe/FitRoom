import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { isHealthResponse } from "@fitroom/shared";
import "./style.css";

const MAX_DEVICE_PIXEL_RATIO = 2;
const FLOOR_SIZE_METERS = 4;
const FLOOR_DIVISIONS = 4;

function queryStatusPill(): HTMLElement | null {
  return document.getElementById("api-status");
}

async function refreshApiStatus(pill: HTMLElement | null): Promise<void> {
  if (pill === null) {
    return;
  }
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      pill.dataset["state"] = "offline";
      pill.textContent = "API: offline";
      return;
    }
    const payload: unknown = await response.json();
    if (isHealthResponse(payload)) {
      pill.dataset["state"] = "ok";
      pill.textContent = "API: ok";
    } else {
      pill.dataset["state"] = "offline";
      pill.textContent = "API: offline";
    }
  } catch {
    pill.dataset["state"] = "offline";
    pill.textContent = "API: offline";
  }
}

function createScene(container: HTMLElement): void {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f4f6);

  const camera = new THREE.PerspectiveCamera(
    50,
    container.clientWidth / container.clientHeight,
    0.1,
    100,
  );
  camera.position.set(3, 3, 3);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  const floor = new THREE.GridHelper(FLOOR_SIZE_METERS, FLOOR_DIVISIONS);
  scene.add(floor);

  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x9ca3af, 1.0);
  scene.add(hemisphere);

  window.addEventListener("resize", () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO));
    renderer.setSize(width, height);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

const container = document.getElementById("scene-container");
if (container !== null) {
  createScene(container);
}
void refreshApiStatus(queryStatusPill());
