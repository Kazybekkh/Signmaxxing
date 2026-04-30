// Floating "PDF-style" invoice viewer + paper receipt that prints on approval.
//
// These are pure cosmetic affordances on top of the InvoiceCardObject —
// they make the demo feel like real paperwork instead of just a HUD card.

import * as THREE from "three";
import type { Invoice, SignedApproval } from "../../shared/types";

const DOC_W = 0.85;
const DOC_H = DOC_W * 1.414; // A4-ish portrait
const RECEIPT_W = 0.42;
const RECEIPT_H = RECEIPT_W * 1.85;

// ---------------------------------------------------------------------------
// Invoice "PDF" panel
// ---------------------------------------------------------------------------

export class InvoiceDocument {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.MeshBasicMaterial;
  private spawnedAt = performance.now();

  constructor(public readonly invoice: Invoice) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 640;
    this.canvas.height = Math.round(640 * 1.414);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;

    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(DOC_W, DOC_H), this.mat);
    this.group.add(this.mesh);

    this.draw();
    this.group.scale.setScalar(0.001);
  }

  /** Smooth spawn-in / spawn-out scale animation. Returns true when active. */
  tick(_now: number): boolean {
    const dt = (performance.now() - this.spawnedAt) / 320;
    if (dt < 1) {
      const e = elasticOut(Math.max(0, dt));
      this.group.scale.setScalar(e);
      return true;
    }
    this.group.scale.setScalar(1);
    return false;
  }

  /** Begin a fade-out and fully dispose after ~250ms. */
  fadeOutAndDispose(onDone: () => void): void {
    const start = performance.now();
    const startOpacity = this.mat.opacity || 1;
    const startScale = this.group.scale.x;
    const tick = () => {
      const t = (performance.now() - start) / 250;
      if (t >= 1) {
        onDone();
        this.dispose();
        return;
      }
      this.mat.opacity = startOpacity * (1 - t);
      this.group.scale.setScalar(startScale * (1 - t * 0.3));
      requestAnimationFrame(tick);
    };
    tick();
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const inv = this.invoice;

    // Paper
    ctx.fillStyle = "#fdfcf7";
    ctx.fillRect(0, 0, W, H);
    // subtle vignette
    const vg = ctx.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, "rgba(0,0,0,0.05)");
    vg.addColorStop(0.5, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.07)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // Top accent band
    ctx.fillStyle = "#312e81";
    ctx.fillRect(0, 0, W, 14);

    // Header
    ctx.fillStyle = "#0f172a";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = "bold 56px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(inv.vendor, 36, 48);

    ctx.fillStyle = "#475569";
    ctx.font = "20px ui-monospace, monospace";
    ctx.fillText(`${inv.vendor_metadata.domain ?? "no-domain.example"}`, 36, 116);
    ctx.fillText(
      `Incorporated ${inv.vendor_metadata.incorporated ?? "—"} · ${
        inv.vendor_metadata.country ?? "—"
      }`,
      36,
      142,
    );

    // Right-aligned INVOICE block
    ctx.textAlign = "right";
    ctx.fillStyle = "#312e81";
    ctx.font = "bold 38px ui-sans-serif, sans-serif";
    ctx.fillText("INVOICE", W - 36, 48);
    ctx.font = "20px ui-monospace, monospace";
    ctx.fillStyle = "#1e293b";
    ctx.fillText(`# ${inv.id}`, W - 36, 96);
    ctx.fillStyle = "#475569";
    ctx.fillText(`Issued  ${todayIso()}`, W - 36, 122);
    ctx.fillText(`Due     ${inv.due_date}`, W - 36, 148);

    // Divider
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    line(ctx, 36, 196, W - 36, 196);

    // Bill-to
    ctx.textAlign = "left";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 16px ui-sans-serif, sans-serif";
    ctx.fillText("BILL TO", 36, 218);
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 26px ui-sans-serif, sans-serif";
    ctx.fillText("Signmaxxing Ltd", 36, 240);
    ctx.fillStyle = "#475569";
    ctx.font = "20px ui-sans-serif, sans-serif";
    ctx.fillText("Cursor Hack London 2026", 36, 272);
    ctx.fillText("Finance Ops · ap@signmaxxing.dev", 36, 298);

    // Line items table
    const tableY = 360;
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(36, tableY, W - 72, 36);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 18px ui-sans-serif, sans-serif";
    ctx.fillText("DESCRIPTION", 48, tableY + 9);
    ctx.textAlign = "right";
    ctx.fillText("QTY", 360, tableY + 9);
    ctx.fillText("UNIT", 480, tableY + 9);
    ctx.fillText("AMOUNT", W - 48, tableY + 9);
    ctx.textAlign = "left";

    const items = synthLineItems(inv);
    let y = tableY + 50;
    ctx.fillStyle = "#0f172a";
    ctx.font = "20px ui-sans-serif, sans-serif";
    let runningTotalPence = 0;
    for (const item of items) {
      const row = item.amount_pence;
      runningTotalPence += row;
      ctx.fillStyle = "#0f172a";
      wrapText(ctx, item.label, 48, y, 290, 22, 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#475569";
      ctx.fillText(String(item.qty), 360, y);
      ctx.fillText(`£${(item.unit_pence / 100).toFixed(2)}`, 480, y);
      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 20px ui-sans-serif, sans-serif";
      ctx.fillText(`£${(row / 100).toFixed(2)}`, W - 48, y);
      ctx.font = "20px ui-sans-serif, sans-serif";
      ctx.textAlign = "left";

      y += 50;
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      line(ctx, 48, y - 8, W - 48, y - 8);
    }

    // Totals - reconcile rounding error so VAT + sub matches inv.amount_gbp
    const total = inv.amount_gbp;
    const subtotal = Math.round(total / 1.2);
    const vat = total - subtotal;
    void runningTotalPence; // intentional: line items are illustrative

    const totalsX = W - 320;
    ctx.fillStyle = "#475569";
    ctx.font = "20px ui-sans-serif, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Subtotal", totalsX, y + 16);
    ctx.fillText("VAT (20%)", totalsX, y + 46);
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 22px ui-sans-serif, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`£${(subtotal / 100).toFixed(2)}`, W - 48, y + 16);
    ctx.fillText(`£${(vat / 100).toFixed(2)}`, W - 48, y + 46);

    // Total bar
    const totalBarY = y + 84;
    ctx.fillStyle = "#312e81";
    ctx.fillRect(totalsX - 16, totalBarY, W - 32 - totalsX + 16, 50);
    ctx.fillStyle = "#fef3c7";
    ctx.font = "bold 20px ui-sans-serif, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("TOTAL DUE", totalsX, totalBarY + 13);
    ctx.font = "bold 26px ui-sans-serif, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(
      `£${(total / 100).toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
      W - 48,
      totalBarY + 11,
    );

    // Footer description block
    const footY = totalBarY + 90;
    ctx.fillStyle = "#475569";
    ctx.textAlign = "left";
    ctx.font = "italic 18px ui-sans-serif, sans-serif";
    wrapText(ctx, `Re: ${inv.description}`, 36, footY, W - 72, 24, 2);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "16px ui-monospace, monospace";
    ctx.fillText(
      "Pay via SEPA · IBAN GB·· ···· ···· ···· ····  Ref " + inv.id,
      36,
      footY + 60,
    );
    ctx.fillText(
      "Signmaxxing routes this through Specter for vendor verification.",
      36,
      footY + 84,
    );

    // Faint watermark
    ctx.save();
    ctx.translate(W / 2, H - 80);
    ctx.rotate(-0.06);
    ctx.fillStyle = "rgba(49,46,129,0.07)";
    ctx.font = "bold 96px ui-sans-serif, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("AWAITING APPROVAL", 0, 0);
    ctx.restore();

    this.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Receipt printout
// ---------------------------------------------------------------------------

export class Receipt {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.MeshBasicMaterial;
  private printedAt = performance.now();
  private removed = false;

  constructor(
    invoice: Invoice,
    decision: "approve" | "reject",
    signed: SignedApproval,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 360;
    this.canvas.height = Math.round(360 * 1.85);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;

    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(RECEIPT_W, RECEIPT_H),
      this.mat,
    );
    this.group.add(this.mesh);

    this.draw(invoice, decision, signed);
  }

  /** Returns a 0..1 ease for the "print out" reveal animation. */
  tick(): number {
    const dt = (performance.now() - this.printedAt) / 900;
    const t = Math.min(1, Math.max(0, dt));
    // unfurl effect: scale Y from 0 to 1, slight wobble
    const e = easeOutBack(t);
    this.group.scale.set(1, e, 1);
    const wobble = (1 - t) * Math.sin(performance.now() * 0.013) * 0.01;
    this.mesh.rotation.z = wobble;
    return t;
  }

  /** Animate a downward float-out then dispose. */
  fadeOut(onDone: () => void): void {
    if (this.removed) return;
    this.removed = true;
    const start = performance.now();
    const initialY = this.group.position.y;
    const tick = () => {
      const t = (performance.now() - start) / 700;
      if (t >= 1) {
        this.dispose();
        onDone();
        return;
      }
      this.group.position.y = initialY - t * 0.4;
      this.mat.opacity = 1 - t;
      requestAnimationFrame(tick);
    };
    tick();
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }

  private draw(
    invoice: Invoice,
    decision: "approve" | "reject",
    signed: SignedApproval,
  ): void {
    const ctx = this.canvas.getContext("2d")!;
    const W = this.canvas.width;
    const H = this.canvas.height;

    // Paper with thin top/bottom serrated edge
    ctx.fillStyle = "#fffaf0";
    ctx.fillRect(0, 0, W, H);
    drawSerrated(ctx, W, 0, "down");
    drawSerrated(ctx, W, H, "up");

    // Body
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 24px ui-monospace, monospace";
    ctx.fillText("SIGNMAXXING", W / 2, 28);
    ctx.fillStyle = "#475569";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText("ed25519 payments register", W / 2, 56);

    ctx.fillStyle = "#0f172a";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("─────────────────────────────────", W / 2, 76);

    ctx.textAlign = "left";
    ctx.font = "13px ui-monospace, monospace";
    ctx.fillStyle = "#1e293b";
    let y = 96;
    const row = (label: string, value: string) => {
      ctx.fillStyle = "#64748b";
      ctx.fillText(label, 24, y);
      ctx.fillStyle = "#0f172a";
      ctx.fillText(value, 24, y + 14);
      y += 38;
    };

    row("DATE", new Date(signed.timestamp).toLocaleString("en-GB"));
    row("INVOICE", invoice.id);
    row("VENDOR", invoice.vendor);
    row(
      "AMOUNT",
      `£${(invoice.amount_gbp / 100).toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`,
    );
    row("DECISION", decision.toUpperCase());

    ctx.fillStyle = "#0f172a";
    ctx.fillText("─────────────────────────────────", 24, y);
    y += 22;
    ctx.fillStyle = "#64748b";
    ctx.fillText("AUTH PUBKEY", 24, y);
    ctx.fillStyle = "#0f172a";
    ctx.fillText(signed.pubkey.slice(0, 28) + "…", 24, y + 16);
    y += 44;
    ctx.fillStyle = "#64748b";
    ctx.fillText("SIGNATURE", 24, y);
    ctx.fillStyle = "#0f172a";
    ctx.fillText(signed.signature.slice(0, 28) + "…", 24, y + 16);
    ctx.fillText(signed.signature.slice(28, 56) + "…", 24, y + 32);

    // Stamp (rotated)
    const stampColor = decision === "approve" ? "#16a34a" : "#dc2626";
    const stampLabel = decision === "approve" ? "PAID" : "VOID";
    ctx.save();
    ctx.translate(W / 2 + 36, H - 130);
    ctx.rotate(-0.18);
    ctx.strokeStyle = stampColor;
    ctx.lineWidth = 6;
    roundRect(ctx, -90, -42, 180, 84, 14);
    ctx.stroke();
    ctx.fillStyle = stampColor;
    ctx.font = "bold 56px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(stampLabel, 0, 0);
    ctx.font = "bold 12px ui-monospace, monospace";
    ctx.fillText(new Date().toISOString().slice(0, 10), 0, 38);
    ctx.restore();

    ctx.fillStyle = "#475569";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(
      decision === "approve" ? "*** TRANSMITTED TO BANK ***" : "*** PAYMENT BLOCKED ***",
      W / 2,
      H - 50,
    );
    ctx.fillText("retain for audit · cursor hack 2026", W / 2, H - 32);

    this.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Stamp burst — pure VFX that lands on the card the moment you commit.
// ---------------------------------------------------------------------------

export class StampBurst {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly canvas: HTMLCanvasElement;
  private readonly tex: THREE.CanvasTexture;
  private readonly start = performance.now();
  private done = false;

  constructor(decision: "approve" | "reject") {
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = 256;
    const color = decision === "approve" ? "#16a34a" : "#dc2626";
    const label = decision === "approve" ? "PAID" : "VOID";
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 256);
    ctx.translate(128, 128);
    ctx.rotate(-0.2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    roundRect(ctx, -110, -55, 220, 110, 16);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "bold 72px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 6);

    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), this.mat);
    this.group.add(this.mesh);
    this.group.scale.setScalar(2.5);
  }

  /** Returns false once the burst is finished and ready to be removed. */
  tick(): boolean {
    if (this.done) return false;
    const t = (performance.now() - this.start) / 700;
    if (t >= 1) {
      this.done = true;
      return false;
    }
    // Quick squash-into-place with overshoot, then fade.
    const punch = t < 0.35 ? 2.5 - 1.6 * easeOutBack(t / 0.35) : 0.9;
    this.group.scale.setScalar(punch);
    this.mat.opacity = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
    return true;
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function elasticOut(t: number): number {
  if (t === 0 || t === 1) return t;
  const p = 0.4;
  const s = p / 4;
  return Math.pow(2, -10 * t) * Math.sin(((t - s) * (2 * Math.PI)) / p) + 1;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function line(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
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

function drawSerrated(
  ctx: CanvasRenderingContext2D,
  W: number,
  baseY: number,
  facing: "up" | "down",
): void {
  // Carve a zig-zag silhouette by erasing little triangles past the edge.
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  const tooth = 10;
  const dir = facing === "down" ? -1 : 1;
  const tipY = baseY + dir * 6;
  ctx.moveTo(0, baseY);
  let i = 0;
  for (let x = 0; x <= W; x += tooth) {
    ctx.lineTo(x, i % 2 === 0 ? tipY : baseY);
    i++;
  }
  ctx.lineTo(W, baseY - dir * 12);
  ctx.lineTo(0, baseY - dir * 12);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
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
  let lineStr = "";
  let lineNo = 0;
  for (let i = 0; i < words.length; i++) {
    const test = lineStr ? `${lineStr} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxWidth && lineStr) {
      ctx.fillText(lineStr, x, y + lineNo * lineHeight);
      lineStr = words[i] ?? "";
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
      lineStr = test;
    }
  }
  if (lineStr) ctx.fillText(lineStr, x, y + lineNo * lineHeight);
}

type LineItem = { label: string; qty: number; unit_pence: number; amount_pence: number };

/** Synthesize plausible line items that sum (roughly) to invoice total. */
function synthLineItems(invoice: Invoice): LineItem[] {
  const total = invoice.amount_gbp;
  const seedNum = hashStr(invoice.id);
  const seed = seedNum;
  const itemCount = 2 + (seed % 3); // 2..4

  const templates: { label: string; share: number }[] = [
    { label: `Professional services — ${invoice.vendor}`, share: 0.55 },
    { label: "Implementation / integration hours", share: 0.22 },
    { label: "Compute & infra pass-through", share: 0.13 },
    { label: "Travel & expenses (rebilled)", share: 0.06 },
    { label: "Late-payment surcharge", share: 0.04 },
  ];

  const chosen = templates.slice(0, itemCount);
  // Re-normalize shares so they sum to 1
  const sumShare = chosen.reduce((s, t) => s + t.share, 0);
  const items: LineItem[] = chosen.map((t, i) => {
    const isLast = i === chosen.length - 1;
    const shareAmt = isLast ? 0 : Math.round((t.share / sumShare) * total);
    return {
      label: t.label,
      qty: 1 + ((seed + i * 7) % 5),
      unit_pence: shareAmt,
      amount_pence: shareAmt,
    };
  });
  // Last item soaks up any rounding so the table sums to invoice.amount_gbp.
  const sumSoFar = items.reduce((s, it) => s + it.amount_pence, 0);
  const tail = items[items.length - 1]!;
  tail.amount_pence = total - sumSoFar;
  tail.unit_pence = tail.amount_pence;
  return items;
}

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
