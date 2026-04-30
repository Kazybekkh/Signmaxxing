// Visualises the AI auto-paying invoices: streams a flock of small
// "PAID" cards across the user's view so 51 silent backend decisions
// become a tangible, watchable event.
//
// Used by main.ts after /agent/run finishes:
//   const stream = new AutoPayStream(scene);
//   stream.play(autoPaidInvoices);

import * as THREE from "three";
import type { Invoice } from "../../shared/types";

const CARD_W = 0.36;
const CARD_H = 0.21;

// Spawn cards far behind/right of the user so they appear to fly *toward*
// then past, ending stacked on a "ledger pile" to the left. Geometry is
// expressed in world space relative to the user at (0, 1.6, 0).
const SPAWN = new THREE.Vector3(2.4, 1.4, -2.6);
const PASS = new THREE.Vector3(0.6, 1.45, -1.0);
const PILE = new THREE.Vector3(-1.55, 0.9, -1.6);

const FLY_DURATION_MS = 2400;
const STAGGER_MS = 110;

type Phase = "approach" | "stamp" | "depart";

class AutoPayCard {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly tex: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private spawnedAt = 0;
  private phase: Phase = "approach";
  private stamped = false;
  private done = false;

  constructor(public readonly invoice: Invoice, public readonly slotIdx: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 300;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;

    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), this.mat);
    this.group.add(this.mesh);

    this.draw(false);
    this.group.position.copy(SPAWN);
    this.group.scale.setScalar(0.6);
  }

  start(now: number): void {
    this.spawnedAt = now;
  }

  /** Returns false once the card has been removed from the scene. */
  tick(now: number, camera: THREE.Camera): boolean {
    if (this.done) return false;
    const t = (now - this.spawnedAt) / FLY_DURATION_MS;

    if (t < 0) return true; // hasn't started yet (still in stagger queue)

    if (t >= 1) {
      this.done = true;
      return false;
    }

    // Three-phase flight: approach (0..0.45), stamp pause (0.45..0.62), depart (0.62..1)
    if (t < 0.45) {
      this.phase = "approach";
      const k = easeOutCubic(t / 0.45);
      this.group.position.lerpVectors(SPAWN, PASS, k);
      this.group.scale.setScalar(0.6 + 0.6 * k); // grow as it nears
      this.mat.opacity = 0.4 + 0.6 * k;
    } else if (t < 0.62) {
      this.phase = "stamp";
      this.group.position.copy(PASS);
      // Squash-overshoot punch when the stamp lands.
      const sk = (t - 0.45) / 0.17;
      const punch = 1.05 + easeOutBack(Math.min(1, sk * 1.4)) * 0.18;
      this.group.scale.setScalar(punch);
      if (!this.stamped) {
        this.stamped = true;
        this.draw(true);
      }
    } else {
      this.phase = "depart";
      const k = easeInCubic((t - 0.62) / 0.38);
      this.group.position.lerpVectors(PASS, PILE, k);
      this.group.scale.setScalar(1.2 - 0.95 * k);
      this.mat.opacity = 1 - k * 0.85;
    }

    // Always face the camera
    this.group.lookAt(camera.position);
    return true;
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }

  private draw(stamped: boolean): void {
    const ctx = this.canvas.getContext("2d")!;
    const { width: W, height: H } = this.canvas;

    ctx.clearRect(0, 0, W, H);

    // Card background
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    if (stamped) {
      grad.addColorStop(0, "#064e3b");
      grad.addColorStop(1, "#022c22");
    } else {
      grad.addColorStop(0, "#1e293b");
      grad.addColorStop(1, "#0f172a");
    }
    ctx.fillStyle = grad;
    roundRect(ctx, 8, 8, W - 16, H - 16, 22);
    ctx.fill();

    ctx.strokeStyle = stamped ? "#22c55e" : "#475569";
    ctx.lineWidth = 4;
    roundRect(ctx, 8, 8, W - 16, H - 16, 22);
    ctx.stroke();

    // Top accent strip
    ctx.fillStyle = stamped ? "#22c55e" : "#6366f1";
    ctx.fillRect(20, 18, W - 40, 6);

    // Vendor
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 36px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ellipsisText(ctx, this.invoice.vendor, 28, 40, W - 56);

    // Amount
    ctx.fillStyle = stamped ? "#86efac" : "#cbd5e1";
    ctx.font = "bold 44px ui-sans-serif, sans-serif";
    ctx.fillText(
      `£${(this.invoice.amount_gbp / 100).toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
      28,
      94,
    );

    // Bottom row
    ctx.fillStyle = "#94a3b8";
    ctx.font = "20px ui-monospace, monospace";
    ctx.fillText(this.invoice.id, 28, 168);

    // AI badge
    const badgeText = stamped ? "AI · AUTO-PAID" : "AI · scoring…";
    const badgeColor = stamped ? "#22c55e" : "#6366f1";
    ctx.fillStyle = badgeColor + "33";
    roundRect(ctx, 28, 220, 240, 50, 14);
    ctx.fill();
    ctx.strokeStyle = badgeColor;
    ctx.lineWidth = 2;
    roundRect(ctx, 28, 220, 240, 50, 14);
    ctx.stroke();
    ctx.fillStyle = badgeColor === "#6366f1" ? "#c7d2fe" : "#bbf7d0";
    ctx.font = "bold 24px ui-sans-serif, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeText, 44, 245);
    ctx.textBaseline = "top";

    // PAID stamp on the right (rotated)
    if (stamped) {
      ctx.save();
      ctx.translate(W - 110, 220);
      ctx.rotate(-0.18);
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 6;
      roundRect(ctx, -78, -38, 156, 76, 14);
      ctx.stroke();
      ctx.fillStyle = "#16a34a";
      ctx.font = "bold 46px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("PAID", 0, 0);
      ctx.restore();
    }

    this.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Stream controller
// ---------------------------------------------------------------------------

export class AutoPayStream {
  private active: AutoPayCard[] = [];
  private pendingTimers: number[] = [];
  private counterEl: HTMLElement | null = null;
  private totalEl: HTMLElement | null = null;
  private vendorEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;
  private played = 0;
  private total = 0;
  private bannerEl: HTMLElement | null = null;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.counterEl = document.getElementById("autopay-count");
    this.totalEl = document.getElementById("autopay-total");
    this.vendorEl = document.getElementById("autopay-vendor");
    this.barEl = document.getElementById("autopay-bar");
    this.bannerEl = document.getElementById("autopay-banner");
  }

  /** Schedule one card per invoice, staggered so they form a flowing stream. */
  play(invoices: Invoice[]): void {
    this.cancel();
    if (invoices.length === 0) return;

    this.played = 0;
    this.total = invoices.length;
    this.showBanner(true);
    this.updateHud("");

    invoices.forEach((inv, i) => {
      const t = window.setTimeout(() => {
        const card = new AutoPayCard(inv, i);
        card.start(performance.now());
        this.scene.add(card.group);
        this.active.push(card);
        this.played++;
        this.updateHud(inv.vendor);
        if (this.played === this.total) {
          // Hide banner shortly after the last card arrives.
          window.setTimeout(() => this.showBanner(false), FLY_DURATION_MS + 400);
        }
      }, i * STAGGER_MS);
      this.pendingTimers.push(t);
    });
  }

  /** Drive every active card forward; called from the render loop. */
  tick(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const alive = this.active[i]!.tick(now, this.camera);
      if (!alive) {
        this.scene.remove(this.active[i]!.group);
        this.active[i]!.dispose();
        this.active.splice(i, 1);
      }
    }
  }

  /** Stop scheduling and dispose anything still in flight. */
  cancel(): void {
    for (const t of this.pendingTimers) window.clearTimeout(t);
    this.pendingTimers = [];
    for (const c of this.active) {
      this.scene.remove(c.group);
      c.dispose();
    }
    this.active = [];
    this.showBanner(false);
  }

  private showBanner(show: boolean): void {
    if (!this.bannerEl) return;
    this.bannerEl.classList.toggle("show", show);
  }

  private updateHud(currentVendor: string): void {
    if (this.counterEl) this.counterEl.textContent = String(this.played);
    if (this.totalEl) this.totalEl.textContent = String(this.total);
    if (this.vendorEl && currentVendor) this.vendorEl.textContent = currentVendor;
    if (this.barEl && this.total > 0) {
      const pct = Math.min(100, Math.round((this.played / this.total) * 100));
      this.barEl.style.width = `${pct}%`;
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function easeInCubic(t: number): number {
  return t * t * t;
}
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function ellipsisText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  let s = text;
  while (ctx.measureText(s + "…").width > maxWidth && s.length > 0) {
    s = s.slice(0, -1);
  }
  if (s.length < text.length) s = s + "…";
  ctx.fillText(s, x, y);
}
