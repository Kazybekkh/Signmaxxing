// Three.js + WebXR scene. Renders escalations as floating cards in front
// of the user, lets controllers point/grab/approve/reject.
//
// Mirrored to the laptop via the live HUD overlays in index.html so the
// judges can follow what the headset wearer is doing.

import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";

import { InvoiceCardObject } from "./card.ts";
import { AutoPayStream } from "./autopay.ts";
import { AgentOrb } from "./agent_orb.ts";
import { InvoiceDocument, Receipt, StampBurst } from "./documents.ts";
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

const SEMICIRCLE_RADIUS = 1.7;
const CARD_HEIGHT = 1.5;
const MAX_LAYOUT_SPAN = 2.4; // radians of arc the cards may occupy (~137°)
const PER_CARD_SPACING = 0.6;

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
  document: InvoiceDocument | null; // PDF panel attached to grabbed card
  approveHoldStart: number; // unix ms when A/X went down (0 = not held)
  rejectHoldStart: number;
  buttonsPrev: boolean[]; // edge-detection
};
const slots: ControllerSlot[] = [];

const activeReceipts: Receipt[] = [];
const activeStamps: StampBurst[] = [];
let autoPayStream: AutoPayStream | null = null;
let agentOrb: AgentOrb | null = null;
let agentRunInFlight = false;
let lastTraceId = 0;
let traceWatchInterval: number | null = null;
const GRIP_HOLD_MS = 1500;
let gripHoldStart = 0; // performance.now ms when EITHER grip went down (0 = not held)

const APPROVE_HOLD_MS = 800;
const REJECT_HOLD_MS = 800;

// xr-standard gamepad mapping (Quest / Zapbox / Index / Pico):
// 0 = trigger, 1 = squeeze (grip), 3 = thumbstick press,
// 4 = A (right) / X (left), 5 = B (right) / Y (left)
const BTN_TRIGGER = 0;
const BTN_GRIP = 1;
const BTN_THUMB = 3; // thumbstick click — used to cycle the backdrop
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

type BgKind = "studio" | "office" | "puresky";

const BG_ORDER: BgKind[] = ["studio", "puresky", "office"];
const BG_LABEL: Record<BgKind, string> = {
  studio: "studio",
  office: "office",
  puresky: "puresky",
};
const BG_NEXT_LABEL: Record<BgKind, string> = {
  studio: "→ puresky",
  puresky: "→ office",
  office: "→ studio",
};

let studioBackground: THREE.Texture | null = null;
let officeBackground: THREE.Texture | null = null;
let pureskyBackground: THREE.Texture | null = null;
let currentBg: BgKind = "studio";

function buildScene(): void {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.05,
    100,
  );
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 1.4, -SEMICIRCLE_RADIUS);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.xr.enabled = true;
  document.getElementById("app")!.appendChild(renderer.domElement);

  const ambient = new THREE.HemisphereLight(0xe0e7ff, 0x1a2138, 0.85);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(2, 4, 2);
  scene.add(key);

  // Default: bright studio backdrop. HDRI is opt-in via the HUD button.
  studioBackground = makeStudioBackground();
  scene.background = studioBackground;
  scene.add(makeFloorDisc());

  setupControllers();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  mouseControls = new MouseControls(camera, renderer.domElement);

  autoPayStream = new AutoPayStream(scene, camera);

  agentOrb = new AgentOrb();
  scene.add(agentOrb.group);
}

function makeStudioBackground(): THREE.Texture {
  // Vertical gradient sky: warm cream at the top, deep indigo at the floor.
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, 1024);
  grad.addColorStop(0.0, "#fef3c7"); // warm sky
  grad.addColorStop(0.45, "#a5b4fc"); // mid horizon
  grad.addColorStop(0.7, "#312e81"); // floor approach
  grad.addColorStop(1.0, "#0f172a"); // deep floor
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 1024);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

function makeFloorDisc(): THREE.Mesh {
  const geo = new THREE.CircleGeometry(8, 64);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(256, 256, 32, 256, 256, 256);
  grad.addColorStop(0, "rgba(165, 180, 252, 0.55)");
  grad.addColorStop(0.5, "rgba(67, 56, 202, 0.18)");
  grad.addColorStop(1, "rgba(15, 23, 42, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = "rgba(199, 210, 254, 0.55)";
  ctx.lineWidth = 2;
  for (let r = 64; r < 256; r += 48) {
    ctx.beginPath();
    ctx.arc(256, 256, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  return mesh;
}

async function loadEquirect(
  url: string,
  loader: RGBELoader | EXRLoader,
): Promise<THREE.Texture> {
  const tex = await loader.loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  pmrem.dispose();
  return envMap;
}

async function ensureOfficeHDRI(): Promise<THREE.Texture> {
  if (!officeBackground) {
    officeBackground = await loadEquirect(
      `/hdri/office.hdr?v=2026-04-30b`,
      new RGBELoader(),
    );
  }
  return officeBackground;
}

async function ensurePureskyEXR(): Promise<THREE.Texture> {
  if (!pureskyBackground) {
    pureskyBackground = await loadEquirect(
      `/hdri/puresky.exr?v=2026-04-30b`,
      new EXRLoader(),
    );
  }
  return pureskyBackground;
}

function setBgBadge(text: string, kind: "studio" | "office" | "sky" | "loading" | "err"): void {
  const badge = document.getElementById("bg-badge");
  if (!badge) return;
  badge.textContent = text;
  const palette: Record<typeof kind, [string, string, string]> = {
    studio:  ["rgba(99,102,241,0.25)",  "rgba(99,102,241,0.5)",  "#c7d2fe"],
    office:  ["rgba(34,197,94,0.25)",   "rgba(34,197,94,0.5)",   "#86efac"],
    sky:     ["rgba(56,189,248,0.25)",  "rgba(56,189,248,0.5)",  "#bae6fd"],
    loading: ["rgba(234,179,8,0.25)",   "rgba(234,179,8,0.5)",   "#fde68a"],
    err:     ["rgba(239,68,68,0.25)",   "rgba(239,68,68,0.5)",   "#fca5a5"],
  };
  const [bg, border, color] = palette[kind];
  badge.style.background = bg;
  badge.style.borderColor = border;
  badge.style.color = color;
}

function refreshBgButtonLabel(): void {
  const btn = document.getElementById("bg-cycle");
  if (btn) {
    btn.textContent = `Backdrop: ${BG_LABEL[currentBg]} ${BG_NEXT_LABEL[currentBg]}`;
  }
}

export async function setBackground(kind: BgKind): Promise<void> {
  currentBg = kind;
  refreshBgButtonLabel();

  if (kind === "studio") {
    if (!studioBackground) studioBackground = makeStudioBackground();
    scene.background = studioBackground;
    scene.environment = null;
    (scene as unknown as { backgroundBlurriness: number }).backgroundBlurriness = 0;
    (scene as unknown as { backgroundIntensity: number }).backgroundIntensity = 1;
    setBgBadge("studio", "studio");
    return;
  }

  setBgBadge(`loading ${kind}…`, "loading");
  try {
    const env = kind === "office" ? await ensureOfficeHDRI() : await ensurePureskyEXR();
    if (currentBg !== kind) return; // user moved on while we loaded
    scene.background = env;
    scene.environment = env;
    if (kind === "office") {
      (scene as unknown as { backgroundBlurriness: number }).backgroundBlurriness = 0.04;
      (scene as unknown as { backgroundIntensity: number }).backgroundIntensity = 1.6;
      setBgBadge("office", "office");
    } else {
      // Puresky reads beautifully with zero blur and a touch more intensity.
      (scene as unknown as { backgroundBlurriness: number }).backgroundBlurriness = 0;
      (scene as unknown as { backgroundIntensity: number }).backgroundIntensity = 1.15;
      setBgBadge("puresky", "sky");
    }
  } catch (err) {
    console.warn(`${kind} HDRI failed, reverting to studio:`, err);
    currentBg = "studio";
    if (studioBackground) scene.background = studioBackground;
    setBgBadge(`${kind} failed`, "err");
    refreshBgButtonLabel();
  }
}

export function cycleBackground(): Promise<void> {
  const idx = BG_ORDER.indexOf(currentBg);
  const next = BG_ORDER[(idx + 1) % BG_ORDER.length]!;
  return setBackground(next);
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
    document: null,
    approveHoldStart: 0,
    rejectHoldStart: 0,
    buttonsPrev: [],
  };
}

function makePointerLine(): THREE.Line {
  // Reach past the furthest card in the semicircle so users can see the
  // laser actually connect with whatever they are aiming at.
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -SEMICIRCLE_RADIUS - 0.5),
  ]);
  const mat = new THREE.LineBasicMaterial({
    color: 0x60a5fa,
    transparent: true,
    opacity: 0.85,
    linewidth: 3,
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
    for (const slot of slots) {
      updateController(slot, t);
      if (slot.document && slot.grabbed) {
        slot.document.tick(t);
        positionDocumentNearCard(slot.document, slot.grabbed);
      }
    }
    pollGripChargeAgent(t);
    for (const card of cards) card.tick(t);

    for (let i = activeStamps.length - 1; i >= 0; i--) {
      const alive = activeStamps[i]!.tick();
      if (!alive) {
        scene.remove(activeStamps[i]!.group);
        activeStamps[i]!.dispose();
        activeStamps.splice(i, 1);
      }
    }
    for (const r of activeReceipts) r.tick();
    autoPayStream?.tick(performance.now());

    if (agentOrb) {
      agentOrb.tick(performance.now());
      agentOrb.faceCamera(camera);
    }

    renderer.render(scene, camera);
  });
}

/** Park the PDF document a little to the right of the grabbed card,
 *  rotated to face the same direction. */
function positionDocumentNearCard(
  doc: InvoiceDocument,
  card: InvoiceCardObject,
): void {
  card.group.updateMatrixWorld();
  const offset = new THREE.Vector3(0.85, -0.05, -0.02);
  const world = offset.applyMatrix4(card.group.matrixWorld);
  doc.group.position.copy(world);
  doc.group.quaternion.copy(card.group.quaternion);
  // Slight outward tilt so it reads as a separate document.
  doc.group.rotateY(-0.18);
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

  const span = Math.max(
    0.6,
    Math.min(MAX_LAYOUT_SPAN, filtered.length * PER_CARD_SPACING),
  );
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
    animateSpawn(card, i * 70);
  }
}

function animateSpawn(card: InvoiceCardObject, delayMs: number): void {
  card.group.scale.setScalar(0.001);
  const start = performance.now() + delayMs;
  const tick = () => {
    const dt = (performance.now() - start) / 420;
    if (dt < 0) {
      requestAnimationFrame(tick);
      return;
    }
    if (dt >= 1) {
      card.group.scale.setScalar(1);
      return;
    }
    card.group.scale.setScalar(easeOutBack(dt));
    requestAnimationFrame(tick);
  };
  tick();
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

let currentEscalations: Card[] = [];

function showPlaceholder(show: boolean): void {
  if (show && !placeholderMesh) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
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

  // Thumbstick click cycles the backdrop.
  if (pad) {
    const thumbNow = !!pad.buttons[BTN_THUMB]?.pressed;
    const thumbPrev = !!slot.buttonsPrev[BTN_THUMB];
    if (thumbNow && !thumbPrev) {
      void cycleBackground().then(() => {
        flashToast(`Backdrop → ${currentBg}`, "ok");
      });
    }
    slot.buttonsPrev[BTN_THUMB] = thumbNow;
  }

  // GRIP held on either controller charges + fires the agent.
  if (pad) {
    const gripNow = !!pad.buttons[BTN_GRIP]?.pressed;
    slot.buttonsPrev[BTN_GRIP] = gripNow;
  }

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
    slot.grabbed.setState("idle");
    disposeSlotDocument(slot);
    layoutCards();
    slot.grabbed = null;
    // layoutCards() disposed the previously hovered card; null it so we
    // don't try to grab a stale reference below.
    slot.hovered = null;
    return;
  }
  if (!slot.hovered) return;
  slot.grabbed = slot.hovered;
  slot.grabbed.setState("grabbed");
  spawnDocumentForSlot(slot);
  void enrichCard(slot.grabbed);
  flashToast(`Inspecting ${slot.grabbed.data.invoice.vendor}`, "ok");
}

function onSelectEnd(slot: ControllerSlot): void {
  if (!slot.grabbed) return;
  if (slot.grabbed.dismissed) {
    slot.grabbed = null;
    disposeSlotDocument(slot);
    return;
  }
  slot.grabbed.setHoldProgress("approve", 0);
  slot.grabbed.setHoldProgress("reject", 0);
  slot.grabbed.setState("idle");
  disposeSlotDocument(slot);
  layoutCards();
  slot.grabbed = null;
  slot.approveHoldStart = 0;
  slot.rejectHoldStart = 0;
}

function spawnDocumentForSlot(slot: ControllerSlot): void {
  if (!slot.grabbed) return;
  if (slot.document) disposeSlotDocument(slot);
  const doc = new InvoiceDocument(slot.grabbed.data.invoice);
  scene.add(doc.group);
  positionDocumentNearCard(doc, slot.grabbed);
  slot.document = doc;
}

function disposeSlotDocument(slot: ControllerSlot): void {
  if (!slot.document) return;
  const doc = slot.document;
  slot.document = null;
  doc.fadeOutAndDispose(() => scene.remove(doc.group));
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

    spawnStampOnCard(card, decision);
    spawnReceiptForCard(card, decision, signed);
    closeSlotsHolding(card);
    animateOut(card, decision);
  } catch (err) {
    console.error(err);
    flashToast(`Failed: ${(err as Error).message}`, "err");
    animateShake(card);
    card.dismissed = false;
  }
  await refreshAll();
}

/** When a card is committed, drop any docs the slots had attached to it. */
function closeSlotsHolding(card: InvoiceCardObject): void {
  for (const slot of slots) {
    if (slot.grabbed === card) {
      disposeSlotDocument(slot);
      slot.grabbed = null;
      slot.approveHoldStart = 0;
      slot.rejectHoldStart = 0;
    }
  }
}

function spawnStampOnCard(
  card: InvoiceCardObject,
  decision: "approve" | "reject",
): void {
  const stamp = new StampBurst(decision);
  card.group.updateMatrixWorld();
  const offset = new THREE.Vector3(0, 0.05, 0.04);
  const world = offset.applyMatrix4(card.group.matrixWorld);
  stamp.group.position.copy(world);
  stamp.group.quaternion.copy(card.group.quaternion);
  scene.add(stamp.group);
  activeStamps.push(stamp);
}

function spawnReceiptForCard(
  card: InvoiceCardObject,
  decision: "approve" | "reject",
  signed: import("../../shared/types").SignedApproval,
): void {
  const receipt = new Receipt(card.data.invoice, decision, signed);
  card.group.updateMatrixWorld();
  // Receipt prints "off the bottom" of the card and drifts outward.
  const offset = new THREE.Vector3(0.42, -0.55, 0.03);
  const world = offset.applyMatrix4(card.group.matrixWorld);
  receipt.group.position.copy(world);
  receipt.group.quaternion.copy(card.group.quaternion);
  receipt.group.rotateZ(0.08);
  scene.add(receipt.group);
  activeReceipts.push(receipt);
  // Auto-cleanup after a few seconds.
  window.setTimeout(() => {
    receipt.fadeOut(() => {
      scene.remove(receipt.group);
      const i = activeReceipts.indexOf(receipt);
      if (i >= 0) activeReceipts.splice(i, 1);
    });
  }, 5500);
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
// Agent run + visualization
// ---------------------------------------------------------------------------

function pollGripChargeAgent(now: number): void {
  if (agentRunInFlight) {
    gripHoldStart = 0;
    agentOrb?.setChargeProgress(0);
    return;
  }
  const anyGrip =
    !!slots[0]?.buttonsPrev[BTN_GRIP] || !!slots[1]?.buttonsPrev[BTN_GRIP];
  if (anyGrip) {
    if (gripHoldStart === 0) {
      gripHoldStart = now;
      agentOrb?.setState("charging");
    }
    const progress = Math.min(1, (now - gripHoldStart) / GRIP_HOLD_MS);
    agentOrb?.setChargeProgress(progress);
    if (progress >= 1) {
      gripHoldStart = 0;
      agentOrb?.setChargeProgress(0);
      agentOrb?.setState("idle");
      void runAgentNow("controller GRIP charge");
    }
  } else if (gripHoldStart !== 0) {
    gripHoldStart = 0;
    agentOrb?.setChargeProgress(0);
    if (agentOrb && !agentRunInFlight) agentOrb.setState("idle");
  }
}

async function runAgentNow(source: string): Promise<void> {
  if (agentRunInFlight) return;
  agentRunInFlight = true;
  setStatus("running agent…", "warn");
  agentOrb?.setState("thinking");
  agentOrb?.pushThought(`run triggered via ${source}`);

  startTraceWatcher();
  try {
    await resetDemo();
    autoPayStream?.cancel();
    lastTraceId = 0;
    agentOrb?.pushThought("scoring 57 invoices…");
    const result = await runAgentStub();
    agentOrb?.pushThought(
      `${result.auto_paid.length} auto-paid · ${result.escalated.length} escalated`,
    );
    flashToast(
      `Agent: ${result.auto_paid.length} auto-pay · ${result.escalated.length} review`,
      "ok",
    );
    autoPayStream?.play(result.auto_paid);
    await refreshAll();
    setStatus("ready", "ok");
    agentOrb?.setState("done");
  } catch (err) {
    setStatus("agent error", "err");
    flashToast(`Agent error: ${(err as Error).message}`, "err");
    agentOrb?.pushThought(`error: ${(err as Error).message}`);
    agentOrb?.setState("idle");
  } finally {
    agentRunInFlight = false;
    stopTraceWatcher();
  }
}

function startTraceWatcher(): void {
  stopTraceWatcher();
  traceWatchInterval = window.setInterval(async () => {
    try {
      const rows = await fetchTrace(60);
      // /agent/trace returns newest-first; flip so we stream chronologically.
      const fresh = rows
        .filter((r) => r.id > lastTraceId)
        .sort((a, b) => a.id - b.id);
      for (const r of fresh) {
        agentOrb?.pushThought(r.line);
        lastTraceId = Math.max(lastTraceId, r.id);
      }
    } catch {
      /* poll failures are non-fatal */
    }
  }, 320);
}

function stopTraceWatcher(): void {
  if (traceWatchInterval !== null) {
    window.clearInterval(traceWatchInterval);
    traceWatchInterval = null;
  }
}

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------

function bindHud(): void {
  document.getElementById("run-agent")!.addEventListener("click", () => {
    void runAgentNow("HUD button");
  });
  document.getElementById("reset-demo")!.addEventListener("click", async () => {
    try {
      autoPayStream?.cancel();
      await resetDemo();
      currentEscalations = [];
      layoutCards();
      await refreshHud();
      agentOrb?.pushThought("demo reset");
      agentOrb?.setState("idle");
      flashToast("Demo reset", "ok");
    } catch (err) {
      flashToast(`Reset failed: ${(err as Error).message}`, "err");
    }
  });

  document.getElementById("bg-cycle")?.addEventListener("click", () => {
    void cycleBackground().then(() => {
      flashToast(`Backdrop → ${currentBg}`, "ok");
    });
  });
  refreshBgButtonLabel();
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
