// Floating invoice card mesh + interaction state.
//
// Each card is a Group containing:
//   - a colored billboard (compact view)
//   - a larger "expanded" plane that swaps in when the card is grabbed
// Visuals encode signal: height proportional to amount, color
// green->red by confidence.

import * as THREE from "three";
import type { Card as InvoiceCard, SpecterData } from "../../shared/types";

const COMPACT_W = 0.55;
const EXPANDED_W = 1.2;

export type CardState = "idle" | "hover" | "grabbed" | "approving" | "rejecting";

export class InvoiceCardObject {
  readonly group = new THREE.Group();
  private readonly compactMesh: THREE.Mesh;
  private readonly expandedMesh: THREE.Mesh;
  private readonly compactCanvas: HTMLCanvasElement;
  private readonly expandedCanvas: HTMLCanvasElement;
  private readonly compactTexture: THREE.CanvasTexture;
  private readonly expandedTexture: THREE.CanvasTexture;
  private readonly glowMesh: THREE.Mesh;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly compactMat: THREE.MeshBasicMaterial;

  private _state: CardState = "idle";
  public enrichment: SpecterData | null = null;
  public approveProgress = 0; // 0..1 hold charge for A/X
  public rejectProgress = 0; // 0..1 hold charge for B/Y
  public dismissed = false;

  constructor(public readonly data: InvoiceCard) {
    const heightFactor = Math.min(
      1.5,
      0.55 + Math.log10(Math.max(1, data.invoice.amount_gbp / 100)) * 0.18,
    );
    const compactHeight = COMPACT_W * heightFactor;

    this.compactCanvas = document.createElement("canvas");
    this.compactCanvas.width = 512;
    this.compactCanvas.height = Math.round(512 * heightFactor);
    this.compactTexture = new THREE.CanvasTexture(this.compactCanvas);
    this.compactTexture.colorSpace = THREE.SRGBColorSpace;
    this.compactTexture.anisotropy = 8;

    this.compactMat = new THREE.MeshBasicMaterial({
      map: this.compactTexture,
      transparent: true,
    });
    this.compactMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(COMPACT_W, compactHeight),
      this.compactMat,
    );
    this.group.add(this.compactMesh);

    this.glowMat = new THREE.MeshBasicMaterial({
      color: this.confidenceColor(),
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    this.glowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(COMPACT_W * 1.18, compactHeight * 1.18),
      this.glowMat,
    );
    this.glowMesh.position.z = -0.005;
    this.group.add(this.glowMesh);

    const expandedHeight = EXPANDED_W * 0.72;
    this.expandedCanvas = document.createElement("canvas");
    this.expandedCanvas.width = 1024;
    this.expandedCanvas.height = Math.round(1024 * 0.72);
    this.expandedTexture = new THREE.CanvasTexture(this.expandedCanvas);
    this.expandedTexture.colorSpace = THREE.SRGBColorSpace;
    this.expandedTexture.anisotropy = 8;

    this.expandedMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(EXPANDED_W, expandedHeight),
      new THREE.MeshBasicMaterial({
        map: this.expandedTexture,
        transparent: true,
      }),
    );
    this.expandedMesh.visible = false;
    this.expandedMesh.position.z = 0.01;
    this.group.add(this.expandedMesh);

    this.group.userData.card = this;
    this.drawCompact();
    this.drawExpanded();
  }

  private confidenceColor(): THREE.Color {
    const c = THREE.MathUtils.clamp(this.data.confidence, 0, 1);
    return new THREE.Color().setHSL(0.33 * c, 0.85, 0.5);
  }

  setState(state: CardState): void {
    this._state = state;
    switch (state) {
      case "idle":
        this.expandedMesh.visible = false;
        this.glowMat.opacity = 0;
        break;
      case "hover":
        this.expandedMesh.visible = false;
        this.glowMat.opacity = 0.35;
        break;
      case "grabbed":
        this.expandedMesh.visible = true;
        this.glowMat.opacity = 0.55;
        this.drawExpanded();
        break;
      case "approving":
        this.glowMat.color.set("#22c55e");
        this.glowMat.opacity = 0.7;
        break;
      case "rejecting":
        this.glowMat.color.set("#ef4444");
        this.glowMat.opacity = 0.7;
        break;
    }
  }

  get state(): CardState {
    return this._state;
  }

  setEnrichment(data: SpecterData): void {
    this.enrichment = data;
    this.drawExpanded();
  }

  setHoldProgress(kind: "approve" | "reject", p: number): void {
    const clamped = THREE.MathUtils.clamp(p, 0, 1);
    if (kind === "approve") this.approveProgress = clamped;
    else this.rejectProgress = clamped;
    this.drawExpanded();
  }

  private drawCompact(): void {
    const ctx = this.compactCanvas.getContext("2d")!;
    const { width: W, height: H } = this.compactCanvas;
    ctx.textAlign = "left";

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#0f172a");
    grad.addColorStop(1, "#1e293b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const col = this.confidenceColor();
    const hex = "#" + col.getHexString();
    ctx.strokeStyle = hex;
    ctx.lineWidth = 12;
    roundRect(ctx, 6, 6, W - 12, H - 12, 32);
    ctx.stroke();

    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, W, 14);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 56px ui-sans-serif, system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "top";
    wrapText(ctx, this.data.invoice.vendor, 36, 60, W - 72, 60, 2);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "44px ui-sans-serif, system-ui, sans-serif";
    const amount = `£${(this.data.invoice.amount_gbp / 100).toLocaleString(
      "en-GB",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}`;
    ctx.fillText(amount, 36, 200);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "30px ui-sans-serif, sans-serif";
    ctx.fillText(`due ${this.data.invoice.due_date}`, 36, 260);

    // Big call-to-action: "POINT + TRIGGER to inspect"
    const ctaY = H - 130;
    ctx.fillStyle = "rgba(99,102,241,0.18)";
    roundRect(ctx, 24, ctaY, W - 48, 80, 14);
    ctx.fill();
    ctx.fillStyle = "#c7d2fe";
    ctx.font = "bold 28px ui-sans-serif, sans-serif";
    ctx.fillText("Point + pull TRIGGER", 44, ctaY + 16);
    ctx.fillStyle = "#a5b4fc";
    ctx.font = "24px ui-sans-serif, sans-serif";
    ctx.fillText("to inspect this invoice", 44, ctaY + 48);

    ctx.fillStyle = hex;
    ctx.font = "bold 24px ui-sans-serif, sans-serif";
    ctx.fillText(
      `confidence ${(this.data.confidence * 100).toFixed(0)}%`,
      36,
      H - 36,
    );

    this.compactTexture.needsUpdate = true;
  }

  private drawExpanded(): void {
    const ctx = this.expandedCanvas.getContext("2d")!;
    const { width: W, height: H } = this.expandedCanvas;
    ctx.textAlign = "left";

    ctx.fillStyle = "rgba(8, 11, 18, 0.97)";
    ctx.fillRect(0, 0, W, H);

    const hex = "#" + this.confidenceColor().getHexString();
    ctx.strokeStyle = hex;
    ctx.lineWidth = 6;
    roundRect(ctx, 8, 8, W - 16, H - 16, 28);
    ctx.stroke();

    // ── HEADER ─────────────────────────────────────────────────────────
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 52px ui-sans-serif, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(this.data.invoice.vendor, 36, 28);

    ctx.fillStyle = hex;
    ctx.font = "bold 38px ui-sans-serif, sans-serif";
    const amount = `£${(this.data.invoice.amount_gbp / 100).toLocaleString(
      "en-GB",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}`;
    ctx.fillText(amount, 36, 90);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "22px ui-sans-serif, sans-serif";
    ctx.fillText(
      `${this.data.invoice.id} · due ${this.data.invoice.due_date}`,
      36,
      140,
    );
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "22px ui-sans-serif, sans-serif";
    wrapText(ctx, this.data.invoice.description, 36, 170, W - 72, 26, 1);

    // ── REASON + SPECTER (left column) ─────────────────────────────────
    const colY = 215;
    ctx.fillStyle = "#fde68a";
    ctx.font = "bold 20px ui-sans-serif, sans-serif";
    ctx.fillText("AGENT REASON", 36, colY);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "22px ui-sans-serif, sans-serif";
    wrapText(ctx, this.data.reason, 36, colY + 28, W - 72, 28, 4);

    const specterY = colY + 28 + 28 * 4 + 16;
    if (this.enrichment) {
      ctx.fillStyle = "#a5b4fc";
      ctx.font = "bold 20px ui-sans-serif, sans-serif";
      ctx.fillText(
        `SPECTER · ${this.enrichment.source}`,
        36,
        specterY,
      );
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "20px ui-sans-serif, sans-serif";
      const lines = [
        `domain ${this.enrichment.domain ?? "—"}`,
        `incorporated ${this.enrichment.incorporation_date ?? "—"} · ${
          this.enrichment.employee_count ?? "—"
        } employees`,
      ];
      lines.forEach((l, i) => ctx.fillText(l, 36, specterY + 28 + i * 26));
      ctx.fillStyle = "#fca5a5";
      this.enrichment.risk_flags.slice(0, 2).forEach((flag, i) => {
        ctx.fillText(`! ${flag}`, 36, specterY + 28 + lines.length * 26 + i * 26);
      });
    } else {
      ctx.fillStyle = "#64748b";
      ctx.font = "italic 20px ui-sans-serif, sans-serif";
      ctx.fillText("Loading Specter enrichment…", 36, specterY);
    }

    // ── BUTTON INSTRUCTIONS (bottom band) ─────────────────────────────
    const bandY = H - 200;
    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    roundRect(ctx, 24, bandY, W - 48, 178, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
    ctx.lineWidth = 2;
    roundRect(ctx, 24, bandY, W - 48, 178, 18);
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "bold 18px ui-sans-serif, sans-serif";
    ctx.fillText("DECIDE WITH CONTROLLER", 44, bandY + 14);

    // Approve column (left)
    const approveX = 44;
    const approveY = bandY + 50;
    drawButtonBadge(ctx, approveX, approveY, "A", "X", "#22c55e");
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 28px ui-sans-serif, sans-serif";
    ctx.fillText("Hold to APPROVE", approveX + 110, approveY + 6);
    ctx.fillStyle = "#86efac";
    ctx.font = "20px ui-sans-serif, sans-serif";
    ctx.fillText("right A · left X", approveX + 110, approveY + 42);

    drawHoldBar(
      ctx,
      approveX,
      approveY + 76,
      W / 2 - 70,
      14,
      this.approveProgress,
      "#22c55e",
    );

    // Reject column (right)
    const rejectX = W / 2 + 20;
    const rejectY = bandY + 50;
    drawButtonBadge(ctx, rejectX, rejectY, "B", "Y", "#ef4444");
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 28px ui-sans-serif, sans-serif";
    ctx.fillText("Hold to REJECT", rejectX + 110, rejectY + 6);
    ctx.fillStyle = "#fca5a5";
    ctx.font = "20px ui-sans-serif, sans-serif";
    ctx.fillText("right B · left Y", rejectX + 110, rejectY + 42);

    drawHoldBar(
      ctx,
      rejectX,
      rejectY + 76,
      W / 2 - 70,
      14,
      this.rejectProgress,
      "#ef4444",
    );

    // Footer hint: release trigger to drop card
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "16px ui-sans-serif, sans-serif";
    ctx.fillText(
      "release the TRIGGER to drop this card without deciding",
      44,
      bandY + 152,
    );

    this.expandedTexture.needsUpdate = true;
  }

  /** Run small per-frame visual effects (idle bob, grab follow). */
  tick(t: number): void {
    if (this.state === "idle" || this.state === "hover") {
      this.compactMesh.position.y = Math.sin(t * 0.0009 + this.group.id) * 0.012;
    }
  }

  dispose(): void {
    this.compactTexture.dispose();
    this.expandedTexture.dispose();
    this.compactMesh.geometry.dispose();
    this.expandedMesh.geometry.dispose();
    this.glowMesh.geometry.dispose();
    (this.compactMesh.material as THREE.Material).dispose();
    (this.expandedMesh.material as THREE.Material).dispose();
    (this.glowMesh.material as THREE.Material).dispose();
  }
}

/** Draws a pill showing both controller bindings, e.g.  [ A | X ]. */
function drawButtonBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rightLabel: string,
  leftLabel: string,
  color: string,
): void {
  const w = 92;
  const h = 60;
  const r = 12;

  // outer pill
  ctx.fillStyle = color + "33"; // ~20% alpha
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  roundRect(ctx, x, y, w, h, r);
  ctx.stroke();

  // divider
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y + 8);
  ctx.lineTo(x + w / 2, y + h - 8);
  ctx.strokeStyle = color + "88";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 30px ui-sans-serif, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(rightLabel, x + w / 4, y + h / 2);
  ctx.fillText(leftLabel, x + (3 * w) / 4, y + h / 2);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
}

/** Hold-to-confirm progress bar; fills as the user keeps the button pressed. */
function drawHoldBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  progress: number,
  color: string,
): void {
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  if (progress > 0.001) {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, Math.max(h, w * progress), h, h / 2);
    ctx.fill();
  }
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

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): void {
  const words = text.split(/\s+/);
  let line = "";
  let lineNo = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lineNo * lineHeight);
      line = words[i];
      lineNo++;
      if (lineNo >= maxLines - 1) {
        const remaining = words.slice(i).join(" ");
        let ellipsis = remaining;
        while (
          ctx.measureText(ellipsis + "…").width > maxWidth &&
          ellipsis.length > 0
        ) {
          ellipsis = ellipsis.slice(0, -1);
        }
        ctx.fillText(ellipsis + "…", x, y + lineNo * lineHeight);
        return;
      }
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lineNo * lineHeight);
}
