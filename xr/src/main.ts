// Three.js + WebXR scene. Renders escalations as floating cards in front
// of the user, lets controllers point/grab/approve/reject.
//
// Mirrored to the laptop via the live HUD overlays in index.html so the
// judges can follow what the headset wearer is doing.

import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

import { InvoiceCardObject } from "./card.ts";
import { enrich } from "./specter.ts";
import { loadOrCreateKeypair, signApproval, type Keypair } from "./sign.ts";
import {
  fetchEscalations,
  fetchLedger,
  fetchTrace,
  postApproval,
  registerPubkey,
  resetDemo,
  runAgentStub,
} from "./api.ts";
import type { Card } from "../../shared/types";

const SEMICIRCLE_RADIUS = 1.4;
const CARD_HEIGHT = 1.5;

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let controller0: THREE.Group;
let controller1: THREE.Group;
let controllerGrip0: THREE.Group;
let controllerGrip1: THREE.Group;
let pointerLine: THREE.Line;
let pointerLine2: THREE.Line;
let cards: InvoiceCardObject[] = [];
let placeholderMesh: THREE.Mesh | null = null;
let keypair: Keypair;
let toastEl: HTMLDivElement;
let mouseControls: MouseControls;

type ControllerSlot = {
  index: 0 | 1;
  controller: THREE.Group;
  grip: THREE.Group;
  raycaster: THREE.Raycaster;
  hovered: InvoiceCardObject | null;
  grabbed: InvoiceCardObject | null;
  approveHoldStart: number; // unix ms when A/X went down (0 = not held)
  rejectHoldStart: number;
  buttonsPrev: boolean[]; // edge-detection
};
const slots: ControllerSlot[] = [];

const APPROVE_HOLD_MS = 800;
const REJECT_HOLD_MS = 800;

// xr-standard gamepad mapping (Quest / Zapbox / Index / Pico):
// 0 = trigger, 1 = squeeze (grip), 3 = thumbstick press,
// 4 = A (right) / X (left), 5 = B (right) / Y (left)
const BTN_TRIGGER = 0;
const BTN_GRIP = 1;
const BTN_PRIMARY = 4; // A or X
const BTN_SECONDARY = 5; // B or Y

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function bootSay(line: string): void {
  const w = window as unknown as { __sx_boot?: (s: string) => void };
  if (w.__sx_boot) w.__sx_boot(line);
}
function bootDone(): void {
  const w = window as unknown as { __sx_done?: () => void };
  if (w.__sx_done) w.__sx_done();
}

async function boot(): Promise<void> {
  bootSay("loading scene…");
  toastEl = document.getElementById("toast") as HTMLDivElement;
  buildScene();
  bindHud();

  bootSay("starting render loop…");
  startLoop();

  keypair = loadOrCreateKeypair();
  document.getElementById("key-line")!.textContent =
    `key: ${keypair.publicKeyB64.slice(0, 18)}…`;

  bootSay("registering pubkey…");
  registerPubkey(keypair.publicKeyB64)
    .then(() => setStatus("ready", "ok"))
    .catch((err) => {
      console.error(err);
      setStatus("backend offline", "err");
    });

  bootSay("fetching escalations…");
  refreshAll().catch((err) => console.warn("refreshAll failed:", err));
  setupVRButton();
  setInterval(refreshHud, 4000);

  bootDone();
}

function buildScene(): void {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f1a);
  scene.fog = new THREE.FogExp2(0x0b0f1a, 0.04);

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.05,
    50,
  );
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 1.4, -SEMICIRCLE_RADIUS);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  document.getElementById("app")!.appendChild(renderer.domElement);

  const ambient = new THREE.HemisphereLight(0x9ab1ff, 0x0a0820, 0.7);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.5);
  dir.position.set(2, 4, 1);
  scene.add(dir);

  const grid = new THREE.GridHelper(20, 40, 0x1f2937, 0x0f172a);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.4;
  scene.add(grid);

  const horizon = new THREE.Mesh(
    new THREE.RingGeometry(8, 9, 64),
    new THREE.MeshBasicMaterial({
      color: 0x6366f1,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
    }),
  );
  horizon.rotation.x = -Math.PI / 2;
  horizon.position.y = 0.01;
  scene.add(horizon);

  setupControllers();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  mouseControls = new MouseControls(camera, renderer.domElement);
}

function setupControllers(): void {
  const factory = new XRControllerModelFactory();

  controller0 = renderer.xr.getController(0);
  controller1 = renderer.xr.getController(1);
  controllerGrip0 = renderer.xr.getControllerGrip(0);
  controllerGrip1 = renderer.xr.getControllerGrip(1);

  controllerGrip0.add(factory.createControllerModel(controllerGrip0));
  controllerGrip1.add(factory.createControllerModel(controllerGrip1));
  scene.add(controller0, controller1, controllerGrip0, controllerGrip1);

  pointerLine = makePointerLine();
  pointerLine2 = makePointerLine();
  controller0.add(pointerLine);
  controller1.add(pointerLine2);

  slots.push(makeSlot(0, controller0, controllerGrip0));
  slots.push(makeSlot(1, controller1, controllerGrip1));

  // Trigger = grab/release the card under the laser pointer.
  // Grip = also release (some users squeeze grip instead of trigger).
  // A/X = approve (held). B/Y = reject (held).
  bindXrEvent(controller0, "selectstart", () => onSelectStart(slots[0]!));
  bindXrEvent(controller0, "selectend", () => onSelectEnd(slots[0]!));
  bindXrEvent(controller1, "selectstart", () => onSelectStart(slots[1]!));
  bindXrEvent(controller1, "selectend", () => onSelectEnd(slots[1]!));
}

function bindXrEvent(
  obj: THREE.Object3D,
  ev: "selectstart" | "selectend" | "squeezestart" | "squeezeend",
  fn: () => void,
): void {
  // The XR controller events ("selectstart", etc.) aren't in three's strict
  // Object3DEventMap typings, so we route through the generic dispatcher.
  (obj as unknown as {
    addEventListener: (ev: string, fn: () => void) => void;
  }).addEventListener(ev, fn);
}

function makeSlot(
  index: 0 | 1,
  controller: THREE.Group,
  grip: THREE.Group,
): ControllerSlot {
  return {
    index,
    controller,
    grip,
    raycaster: new THREE.Raycaster(),
    hovered: null,
    grabbed: null,
    approveHoldStart: 0,
    rejectHoldStart: 0,
    buttonsPrev: [],
  };
}

function makePointerLine(): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1.5),
  ]);
  const mat = new THREE.LineBasicMaterial({
    color: 0x6366f1,
    transparent: true,
    opacity: 0.7,
  });
  return new THREE.Line(geo, mat);
}

function setupVRButton(): void {
  const btn = document.getElementById("enter-xr") as HTMLButtonElement;
  if (!("xr" in navigator)) {
    btn.textContent = "WebXR not available";
    btn.disabled = true;
    return;
  }
  navigator.xr!.isSessionSupported("immersive-vr").then((vr) => {
    if (!vr) {
      btn.textContent = "Headset not detected";
      btn.disabled = true;
      return;
    }
    const vrButton = VRButton.createButton(renderer);
    btn.replaceWith(vrButton);
    vrButton.id = "enter-xr";
    vrButton.style.cssText = (document.getElementById("enter-xr")?.style.cssText ?? "");
  });
}

function startLoop(): void {
  renderer.setAnimationLoop((t) => {
    if (!renderer.xr.isPresenting) {
      mouseControls.update();
    }
    for (const slot of slots) updateController(slot, t);
    for (const card of cards) card.tick(t);
    renderer.render(scene, camera);
  });
}

// ---------------------------------------------------------------------------
// Cards layout
// ---------------------------------------------------------------------------

function layoutCards(): void {
  for (const c of cards) {
    scene.remove(c.group);
    c.dispose();
  }
  cards = [];

  const filtered = currentEscalations.filter((c) => !c.invoice.id.startsWith("__"));
  showPlaceholder(filtered.length === 0);
  if (filtered.length === 0) return;

  const span = Math.max(0.6, Math.min(1.6, filtered.length * 0.55));
  for (let i = 0; i < filtered.length; i++) {
    const t =
      filtered.length === 1 ? 0 : (i / (filtered.length - 1) - 0.5) * span;
    const angle = -Math.PI / 2 + t;
    const x = Math.cos(angle) * SEMICIRCLE_RADIUS;
    const z = Math.sin(angle) * SEMICIRCLE_RADIUS;
    const card = new InvoiceCardObject(filtered[i]!);
    card.group.position.set(x, CARD_HEIGHT, z);
    card.group.lookAt(new THREE.Vector3(0, CARD_HEIGHT, 0));
    scene.add(card.group);
    cards.push(card);
  }
}

let currentEscalations: Card[] = [];

function showPlaceholder(show: boolean): void {
  if (show && !placeholderMesh) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, "#1e1b4b");
    grad.addColorStop(1, "#0f172a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.strokeStyle = "#a5b4fc";
    ctx.lineWidth = 6;
    ctx.strokeRect(20, 20, 984, 472);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 80px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("SIGNMAXXING", 512, 200);
    ctx.fillStyle = "#a5b4fc";
    ctx.font = "36px ui-sans-serif, sans-serif";
    ctx.fillText("No escalations yet — hit Run agent on the HUD", 512, 280);
    ctx.fillStyle = "#fbbf24";
    ctx.font = "28px ui-sans-serif, sans-serif";
    ctx.fillText("(or POST /agent/reset && /agent/run)", 512, 340);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    placeholderMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 1.2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
    placeholderMesh.position.set(0, 1.6, -SEMICIRCLE_RADIUS);
    scene.add(placeholderMesh);
  } else if (!show && placeholderMesh) {
    scene.remove(placeholderMesh);
    placeholderMesh.geometry.dispose();
    (placeholderMesh.material as THREE.Material).dispose();
    placeholderMesh = null;
  }
}

async function refreshAll(): Promise<void> {
  await refreshEscalations();
  await refreshHud();
}

async function refreshEscalations(): Promise<void> {
  try {
    currentEscalations = await fetchEscalations();
    layoutCards();
  } catch (err) {
    console.warn("failed to fetch escalations", err);
  }
}

async function refreshHud(): Promise<void> {
  try {
    const [ledger, trace] = await Promise.all([
      fetchLedger(),
      fetchTrace(40),
    ]);
    renderLedger(ledger);
    renderTrace(trace);
    const autoPaid = ledger.filter((e) => e.decision === "auto_pay").length;
    const escalated = currentEscalations.length;
    document.getElementById("auto-paid-count")!.textContent = String(autoPaid);
    document.getElementById("escalated-count")!.textContent = String(escalated);
  } catch (err) {
    console.warn("HUD refresh failed", err);
  }
}

function renderLedger(rows: { vendor: string; amount_gbp: number; decision: string; timestamp: number }[]): void {
  const list = document.getElementById("ledger-list")!;
  list.innerHTML = "";
  for (const r of rows.slice(0, 8)) {
    const div = document.createElement("div");
    const cls =
      r.decision === "auto_pay"
        ? "text-emerald-300"
        : r.decision === "approve"
          ? "text-sky-300"
          : "text-rose-300";
    const amount =
      r.amount_gbp === 0
        ? "—"
        : `£${(r.amount_gbp / 100).toLocaleString("en-GB", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`;
    div.innerHTML = `<span class="${cls} font-semibold uppercase mr-2">${r.decision}</span><span class="text-white/80">${escapeHtml(r.vendor)}</span> <span class="text-white/40">${amount}</span>`;
    list.appendChild(div);
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="text-white/40 italic">no transactions yet</div>`;
  }
}

function renderTrace(rows: { line: string; timestamp: number }[]): void {
  const list = document.getElementById("trace-list")!;
  list.innerHTML = "";
  for (const r of rows.slice(0, 25).reverse()) {
    const div = document.createElement("div");
    div.className = "text-white/80";
    const time = new Date(r.timestamp).toLocaleTimeString();
    div.innerHTML = `<span class="text-white/40 mr-2">${time}</span>${escapeHtml(r.line)}`;
    list.appendChild(div);
  }
  if (rows.length === 0) {
    list.innerHTML = `<div class="text-white/40 italic">agent has not run yet</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    })[c] ?? c,
  );
}

// ---------------------------------------------------------------------------
// Controller updates / gestures
// ---------------------------------------------------------------------------

const tmpQuat = new THREE.Quaternion();

function readGamepad(slot: ControllerSlot): Gamepad | null {
  const session = renderer.xr.getSession?.();
  if (!session) return null;
  const sources = session.inputSources;
  // Pair source by handedness when available, else by index.
  const desired = slot.index === 0 ? "right" : "left";
  for (const src of sources) {
    if (src.handedness === desired && src.gamepad) return src.gamepad;
  }
  // Fallback: positional
  let i = 0;
  for (const src of sources) {
    if (src.gamepad) {
      if (i === slot.index) return src.gamepad;
      i++;
    }
  }
  return null;
}

function updateController(slot: ControllerSlot, now: number): void {
  const { controller, raycaster } = slot;

  // Poll gamepad face buttons for explicit, labeled approve/reject.
  const pad = readGamepad(slot);
  if (pad && slot.grabbed) {
    const approvePressed = !!pad.buttons[BTN_PRIMARY]?.pressed;
    const rejectPressed = !!pad.buttons[BTN_SECONDARY]?.pressed;

    if (approvePressed) {
      if (slot.approveHoldStart === 0) slot.approveHoldStart = now;
      const progress = Math.min(
        1,
        (now - slot.approveHoldStart) / APPROVE_HOLD_MS,
      );
      slot.grabbed.setHoldProgress("approve", progress);
      if (progress >= 1) {
        slot.approveHoldStart = 0;
        finalize(slot.grabbed, "approve");
        return;
      }
    } else if (slot.approveHoldStart !== 0) {
      slot.approveHoldStart = 0;
      slot.grabbed.setHoldProgress("approve", 0);
    }

    if (rejectPressed) {
      if (slot.rejectHoldStart === 0) slot.rejectHoldStart = now;
      const progress = Math.min(
        1,
        (now - slot.rejectHoldStart) / REJECT_HOLD_MS,
      );
      slot.grabbed.setHoldProgress("reject", progress);
      if (progress >= 1) {
        slot.rejectHoldStart = 0;
        finalize(slot.grabbed, "reject");
        return;
      }
    } else if (slot.rejectHoldStart !== 0) {
      slot.rejectHoldStart = 0;
      slot.grabbed.setHoldProgress("reject", 0);
    }
  }

  if (slot.grabbed) {
    const card = slot.grabbed;
    const pos = new THREE.Vector3(0, 0, -0.45).applyMatrix4(controller.matrixWorld);
    card.group.position.lerp(pos, 0.4);
    controller.getWorldQuaternion(tmpQuat);
    card.group.quaternion.slerp(tmpQuat, 0.35);
    return;
  }

  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  raycaster.ray.direction
    .set(0, 0, -1)
    .applyQuaternion(controller.getWorldQuaternion(tmpQuat));

  const meshes = cards.flatMap((c) => [c.group.children[0]!]);
  const hits = raycaster.intersectObjects(meshes, false);
  const hit = hits[0]?.object?.parent?.userData?.card as
    | InvoiceCardObject
    | undefined;

  if (slot.hovered && slot.hovered !== hit) {
    if (slot.hovered.state !== "grabbed") slot.hovered.setState("idle");
  }
  if (hit) {
    if (hit.state !== "grabbed") hit.setState("hover");
    slot.hovered = hit;
  } else {
    slot.hovered = null;
  }
}

function onSelectStart(slot: ControllerSlot): void {
  if (slot.grabbed) {
    // Re-pull a card already in hand: drop and re-grab the one under cursor.
    slot.grabbed.setState("idle");
    layoutCards();
    slot.grabbed = null;
  }
  if (!slot.hovered) return;
  slot.grabbed = slot.hovered;
  slot.grabbed.setState("grabbed");
  void enrichCard(slot.grabbed);
}

function onSelectEnd(slot: ControllerSlot): void {
  if (!slot.grabbed) return;
  if (slot.grabbed.dismissed) {
    slot.grabbed = null;
    return;
  }
  slot.grabbed.setHoldProgress("approve", 0);
  slot.grabbed.setHoldProgress("reject", 0);
  slot.grabbed.setState("idle");
  layoutCards();
  slot.grabbed = null;
  slot.approveHoldStart = 0;
  slot.rejectHoldStart = 0;
}

async function enrichCard(card: InvoiceCardObject): Promise<void> {
  if (card.enrichment) return;
  try {
    const data = await enrich(card.data.invoice.vendor);
    card.setEnrichment(data);
  } catch (err) {
    console.warn("enrichment failed", err);
  }
}

async function finalize(
  card: InvoiceCardObject,
  decision: "approve" | "reject",
): Promise<void> {
  if (card.dismissed) return;
  card.dismissed = true;
  card.setState(decision === "approve" ? "approving" : "rejecting");
  try {
    const signed = signApproval(keypair, card.data.invoice.id, decision);
    const result = await postApproval(signed);
    flashToast(
      `${card.data.invoice.vendor} → ${result.status}`,
      decision === "approve" ? "ok" : "warn",
    );
    animateOut(card, decision);
  } catch (err) {
    console.error(err);
    flashToast(`Failed: ${(err as Error).message}`, "err");
    animateShake(card);
    card.dismissed = false;
  }
  await refreshAll();
}

function animateOut(card: InvoiceCardObject, decision: "approve" | "reject"): void {
  const dir = decision === "approve" ? new THREE.Vector3(0, 1.5, 0) : new THREE.Vector3(0, -1.5, 0);
  const start = card.group.position.clone();
  const end = start.clone().add(dir);
  const startTime = performance.now();
  const duration = 700;
  const tick = () => {
    const t = (performance.now() - startTime) / duration;
    if (t >= 1) {
      scene.remove(card.group);
      card.dispose();
      cards = cards.filter((c) => c !== card);
      return;
    }
    card.group.position.lerpVectors(start, end, easeOut(t));
    card.group.scale.setScalar(1 - t);
    requestAnimationFrame(tick);
  };
  tick();
}

function animateShake(card: InvoiceCardObject): void {
  const start = card.group.position.clone();
  const startTime = performance.now();
  const duration = 350;
  const tick = () => {
    const t = (performance.now() - startTime) / duration;
    if (t >= 1) {
      card.group.position.copy(start);
      return;
    }
    const offset = Math.sin(t * Math.PI * 8) * 0.04 * (1 - t);
    card.group.position.x = start.x + offset;
    requestAnimationFrame(tick);
  };
  tick();
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------

function bindHud(): void {
  document.getElementById("run-agent")!.addEventListener("click", async () => {
    setStatus("running agent…", "warn");
    try {
      await resetDemo();
      await runAgentStub();
      await refreshAll();
      setStatus("ready", "ok");
      flashToast("Agent run complete", "ok");
    } catch (err) {
      setStatus("agent error", "err");
      flashToast(`Agent error: ${(err as Error).message}`, "err");
    }
  });
  document.getElementById("reset-demo")!.addEventListener("click", async () => {
    try {
      await resetDemo();
      currentEscalations = [];
      layoutCards();
      await refreshHud();
      flashToast("Demo reset", "ok");
    } catch (err) {
      flashToast(`Reset failed: ${(err as Error).message}`, "err");
    }
  });
}

function setStatus(label: string, kind: "ok" | "warn" | "err"): void {
  const el = document.getElementById("status-pill")!;
  el.textContent = label;
  el.className = `pill ${kind}`;
}

let toastTimer: number | null = null;
function flashToast(msg: string, kind: "ok" | "warn" | "err" = "ok"): void {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = `hud-card rounded-full px-4 py-2 text-sm show pill ${kind}`;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("show");
  }, 2500);
}

// ---------------------------------------------------------------------------
// Mouse fallback so the laptop view is interactive without a headset
// ---------------------------------------------------------------------------

class MouseControls {
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private yaw = 0;
  private pitch = 0;
  private hovered: InvoiceCardObject | null = null;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private downAt = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLCanvasElement,
  ) {
    dom.addEventListener("mousedown", (e) => {
      this.dragging = e.button === 2 || e.shiftKey;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.downAt = performance.now();
    });
    dom.addEventListener("mouseup", (e) => {
      this.dragging = false;
      const elapsed = performance.now() - this.downAt;
      if (elapsed < 200) this.handleClick(e);
    });
    dom.addEventListener("mousemove", (e) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.yaw -= dx * 0.005;
        this.pitch = Math.max(
          -Math.PI / 3,
          Math.min(Math.PI / 3, this.pitch - dy * 0.005),
        );
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    dom.addEventListener("wheel", (e) => {
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      this.camera.position.addScaledVector(dir, -e.deltaY * 0.001);
    });
    window.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      const target = this.hovered;
      if (!target) return;
      if (k === "a" || k === "x") finalize(target, "approve");
      if (k === "b" || k === "y") finalize(target, "reject");
    });
  }

  private handleClick(_e: MouseEvent): void {
    if (this.hovered) {
      void enrichCard(this.hovered);
      this.hovered.setState("grabbed");
    }
  }

  update(): void {
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const meshes = cards.flatMap((c) => [c.group.children[0]!]);
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hit = hits[0]?.object?.parent?.userData?.card as
      | InvoiceCardObject
      | undefined;
    if (this.hovered && this.hovered !== hit) {
      if (this.hovered.state !== "grabbed") this.hovered.setState("idle");
    }
    if (hit) {
      if (hit.state !== "grabbed") hit.setState("hover");
      this.hovered = hit;
    } else {
      this.hovered = null;
    }
  }
}

void boot();
