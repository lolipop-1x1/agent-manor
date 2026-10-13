import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createEstate } from "./estate";
import { createTeaScene } from "./tea";

export type SceneFeature = "overview" | "sessions" | "code-map" | "resources";
export interface SceneOptions {
  installationOpen: boolean;
  paused: boolean;
  view: "estate" | "tea";
  resetKey: number;
}
interface Callbacks {
  onFeature(feature: SceneFeature): void;
  onHover(feature: SceneFeature | null): void;
  onError(): void;
}
export interface ManorController {
  setOptions(options: SceneOptions): void;
  dispose(): void;
}
interface CameraPose { position: THREE.Vector3; target: THREE.Vector3; zoom: number; offset: number }
const estatePose = (): CameraPose => ({ position: new THREE.Vector3(32, 28, 40), target: new THREE.Vector3(0, 2, 1), zoom: 1, offset: .14 });
const teaPose = (): CameraPose => ({ position: new THREE.Vector3(17, 11.5, 20), target: new THREE.Vector3(5.6, 1.35, 5.7), zoom: 2.7, offset: .14 });

export function createManorController(canvas: HTMLCanvasElement, host: HTMLElement, callbacks: Callbacks): ManorController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.setClearColor(0xf6f4ed, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfffbed, 0x869881, 2.3));
  const sun = new THREE.DirectionalLight(0xffedcd, 3.1);
  sun.position.set(-22, 35, 23);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 90 });
  sun.shadow.normalBias = .035;
  sun.shadow.bias = -.00015;
  sun.shadow.radius = 2;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xc5def7, .65);
  fill.position.set(20, 14, -20);
  scene.add(fill);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: 0x546343, opacity: .16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -.48;
  ground.receiveShadow = true;
  scene.add(ground);
  const estate = createEstate();
  const tea = createTeaScene();
  tea.group.position.set(5.8, .35, 5.7);
  scene.add(estate.group, tea.group);

  const camera = new THREE.OrthographicCamera(-30, 30, 16.5, -16.5, .1, 180);
  const initial = estatePose();
  camera.position.copy(initial.position);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(initial.target);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.rotateSpeed = .5;
  controls.minPolarAngle = Math.PI / 7;
  controls.maxPolarAngle = Math.PI / 2.6;
  controls.minAzimuthAngle = -Math.PI * .48;
  controls.maxAzimuthAngle = Math.PI * .48;
  controls.update();

  let options: SceneOptions = { installationOpen: false, paused: false, view: "estate", resetKey: 0 };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let visible = true, disposed = false, frame = 0, elapsed = 9.6, lastTime = performance.now();
  let width = 1, height = 1, offset = initial.offset;
  let savedPose: CameraPose | null = null;
  let transition: { from: CameraPose; to: CameraPose; started: number } | null = null;
  const capture = (): CameraPose => ({ position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom, offset });
  function projection() {
    const halfHeight = 16.5;
    camera.left = -halfHeight * width / height;
    camera.right = halfHeight * width / height;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.setViewOffset(width, height, -width * offset, 0, width, height);
    camera.updateProjectionMatrix();
  }
  function apply(pose: CameraPose) {
    camera.position.copy(pose.position);
    controls.target.copy(pose.target);
    camera.zoom = pose.zoom;
    offset = pose.offset;
    projection();
    controls.update();
  }
  function goTo(pose: CameraPose) {
    if (reduced.matches) { transition = null; apply(pose); }
    else transition = { from: capture(), to: pose, started: performance.now() };
    requestFrame();
  }
  function render(now: number) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    const delta = Math.min((now - lastTime) / 1000, .05);
    lastTime = now;
    // 自动暂停由页面偏好处理；用户明确播放时允许恢复角色动画。
    if (!options.paused) elapsed += delta;
    if (transition) {
      const t = Math.min(1, (now - transition.started) / 850);
      const eased = 1 - (1 - t) ** 4;
      const { from, to } = transition;
      apply({ position: from.position.clone().lerp(to.position, eased), target: from.target.clone().lerp(to.target, eased), zoom: THREE.MathUtils.lerp(from.zoom, to.zoom, eased), offset: THREE.MathUtils.lerp(from.offset, to.offset, eased) });
      if (t === 1) transition = null;
    }
    estate.update(elapsed);
    tea.update(elapsed);
    renderer.render(scene, camera);
    // 用可观察的 DOM 状态验证暂停、恢复与镜头，不暴露产品数据或全局调试对象。
    host.dataset.sceneTime = elapsed.toFixed(3);
    host.dataset.camera = [...camera.position.toArray(), ...controls.target.toArray(), camera.zoom].map(n => n.toFixed(3)).join(",");
    host.dataset.drawCalls = String(renderer.info.render.calls);
    host.dataset.triangles = String(renderer.info.render.triangles);
    if (transition || !options.paused) requestFrame();
  }
  function requestFrame() { if (!frame && !disposed && visible && !document.hidden) frame = requestAnimationFrame(render); }
  function wake() { lastTime = performance.now(); requestFrame(); }
  const resize = new ResizeObserver(() => {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false); projection(); wake();
  });
  resize.observe(host);
  const intersection = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    host.dataset.visible = String(visible);
    if (visible) wake();
    else { cancelAnimationFrame(frame); frame = 0; }
  });
  intersection.observe(host);
  document.addEventListener("visibilitychange", wake);
  reduced.addEventListener("change", wake);
  controls.addEventListener("change", requestFrame);
  const stopTransition = () => { transition = null; };
  controls.addEventListener("start", stopTransition);

  const pointer = new THREE.Vector2(), ray = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  function hit(event: PointerEvent) {
    const bounds = canvas.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
    ray.setFromCamera(pointer, camera);
    const object = ray.intersectObjects(estate.hotspots.map(hotspot => hotspot.object), false)[0]?.object;
    return estate.hotspots.find(hotspot => hotspot.object === object)?.feature ?? null;
  }
  function hover(event: PointerEvent) {
    const feature = down ? null : hit(event);
    canvas.style.cursor = down ? "grabbing" : feature ? "pointer" : "grab";
    const bounds = host.getBoundingClientRect();
    host.style.setProperty("--pointer-x", `${event.clientX - bounds.left + 14}px`);
    host.style.setProperty("--pointer-y", `${event.clientY - bounds.top + 14}px`);
    callbacks.onHover(feature);
  }
  function pointerDown(event: PointerEvent) { down = { x: event.clientX, y: event.clientY }; callbacks.onHover(null); }
  function pointerUp(event: PointerEvent) {
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5 && !options.installationOpen) {
      const feature = hit(event); if (feature) callbacks.onFeature(feature);
    }
    down = null;
  }
  function leave() { down = null; callbacks.onHover(null); }
  function zoom(delta: number) { transition = null; camera.zoom = THREE.MathUtils.clamp(camera.zoom * Math.exp(delta), .7, 4.3); projection(); requestFrame(); }
  function wheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); zoom(-event.deltaY * .002);
  }
  function keydown(event: KeyboardEvent) {
    if (["+", "=", "-", "_"].includes(event.key)) { event.preventDefault(); zoom(event.key === "-" || event.key === "_" ? -.12 : .12); return; }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault(); transition = null;
    const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    if (event.key === "ArrowLeft") spherical.theta -= .09;
    if (event.key === "ArrowRight") spherical.theta += .09;
    if (event.key === "ArrowUp") spherical.phi -= .07;
    if (event.key === "ArrowDown") spherical.phi += .07;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
    spherical.theta = THREE.MathUtils.clamp(spherical.theta, controls.minAzimuthAngle, controls.maxAzimuthAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    controls.update(); requestFrame();
  }
  function contextLost(event: Event) { event.preventDefault(); callbacks.onError(); }
  canvas.addEventListener("pointermove", hover);
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("keydown", keydown);
  canvas.addEventListener("webglcontextlost", contextLost);
  requestFrame();

  return {
    setOptions(next) {
      if (next.installationOpen && !options.installationOpen) { savedPose = capture(); goTo(teaPose()); }
      else if (!next.installationOpen && options.installationOpen) { goTo(savedPose ?? estatePose()); savedPose = null; }
      else if (next.view !== options.view || next.resetKey !== options.resetKey) goTo(next.view === "tea" ? teaPose() : estatePose());
      controls.enabled = !next.installationOpen;
      options = next;
      host.dataset.view = next.installationOpen ? "installation" : next.view;
      host.dataset.paused = String(next.paused);
      wake();
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame);
      resize.disconnect(); intersection.disconnect();
      document.removeEventListener("visibilitychange", wake); reduced.removeEventListener("change", wake);
      controls.removeEventListener("change", requestFrame); controls.removeEventListener("start", stopTransition); controls.dispose();
      canvas.removeEventListener("pointermove", hover); canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", keydown); canvas.removeEventListener("webglcontextlost", contextLost);
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
        }
      });
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
      sun.shadow.map?.dispose(); renderer.dispose();
    },
  };
}
