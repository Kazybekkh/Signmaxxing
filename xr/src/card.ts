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
  public approveProgress = 0; // 0..1 squeeze charge
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

  setApproveProgress(p: number): void {
    this.approveProgress = THREE.MathUtils.clamp(p, 0, 1);
    this.drawExpanded();
  }

  private drawCompact(): void {
    const ctx = this.compactCanvas.getContext("2d")!;
    const { width: W, height: H } = this.compactCanvas;

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

    ctx.fillStyle = hex;
    ctx.font = "bold 28px ui-sans-serif, sans-serif";
    ctx.fillText(
      `confidence ${(this.data.confidence * 100).toFixed(0)}%`,
      36,
      H - 60,
    );

    this.compactTexture.needsUpdate = true;
  }

  private drawExpanded(): void {
    const ctx = this.expandedCanvas.getContext("2d")!;
    const { width: W, height: H } = this.expandedCanvas;

    ctx.fillStyle = "rgba(8, 11, 18, 0.96)";
    ctx.fillRect(0, 0, W, H);

    const hex = "#" + this.confidenceColor().getHexString();
    ctx.strokeStyle = hex;
    ctx.lineWidth = 6;
    roundRect(ctx, 8, 8, W - 16, H - 16, 28);
    ctx.stroke();

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 56px ui-sans-serif, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(this.data.invoice.vendor, 36, 32);

    ctx.fillStyle = hex;
    ctx.font = "bold 40px ui-sans-serif, sans-serif";
    const amount = `£${(this.data.invoice.amount_gbp / 100).toLocaleString(
      "en-GB",
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}`;
    ctx.fillText(amount, 36, 100);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "26px ui-sans-serif, sans-serif";
    ctx.fillText(this.data.invoice.description, 36, 160);
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(
      `${this.data.invoice.id} · due ${this.data.invoice.due_date}`,
      36,
      200,
    );

    ctx.fillStyle = "#fde68a";
    ctx.font = "bold 24px ui-sans-serif, sans-serif";
    ctx.fillText("AGENT REASON", 36, 250);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "26px ui-sans-serif, sans-serif";
    wrapText(ctx, this.data.reason, 36, 282, W - 72, 32, 4);

    if (this.enrichment) {
      const yBase = 420;
      ctx.fillStyle = "#a5b4fc";
      ctx.font = "bold 24px ui-sans-serif, sans-serif";
      ctx.fillText(
        `SPECTER ENRICHMENT (${this.enrichment.source})`,
        36,
        yBase,
      );

      ctx.fillStyle = "#e2e8f0";
      ctx.font = "24px ui-sans-serif, sans-serif";
      const lines = [
        `domain: ${this.enrichment.domain ?? "—"}`,
        `incorporated: ${this.enrichment.incorporation_date ?? "—"}`,
        `employees: ${
          this.enrichment.employee_count !== undefined
            ? this.enrichment.employee_count
            : "—"
        }`,
      ];
      lines.forEach((l, i) => ctx.fillText(l, 36, yBase + 36 + i * 30));

      const flagsY = yBase + 36 + lines.length * 30 + 10;
      ctx.fillStyle = "#fca5a5";
      this.enrichment.risk_flags.slice(0, 3).forEach((flag, i) => {
        ctx.fillText(`! ${flag}`, 36, flagsY + i * 30);
      });
    } else {
      ctx.fillStyle = "#64748b";
      ctx.font = "italic 22px ui-sans-serif, sans-serif";
      ctx.fillText("Loading Specter enrichment…", 36, 430);
    }

    const barX = 36;
    const barY = H - 70;
    const barW = W - 72;
    const barH = 28;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(ctx, barX, barY, barW, barH, 14);
    ctx.fill();
    ctx.fillStyle = "#22c55e";
    roundRect(
      ctx,
      barX,
      barY,
      Math.max(2, barW * this.approveProgress),
      barH,
      14,
    );
    ctx.fill();

    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 22px ui-sans-serif, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "Hold trigger to approve  ·  flick down to reject",
      barX + 12,
      barY + barH / 2,
    );
    ctx.textBaseline = "top";

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
