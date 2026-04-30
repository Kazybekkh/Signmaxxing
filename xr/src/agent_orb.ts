// 3D representation of the Cursor agent. Sits floating above the
// escalation arc and tells the operator at a glance what the AI is doing:
//   - idle:      gentle pulse, soft indigo
//   - charging:  bright orange ring fills as user holds the grip
//   - thinking:  spins fast, glows hot, emits thought panels
//   - done:      green flash, settles back to idle
//
// Trace lines from /agent/trace stream out as little floating text panels
// that orbit then drift away, giving the operator a visible sense of the
// agent reasoning step by step.

import * as THREE from "three";

const ORB_POS = new THREE.Vector3(0, 2.05, -1.55);
const ORB_RADIUS = 0.28;

export type OrbState = "idle" | "charging" | "thinking" | "done";

export class AgentOrb {
  readonly group = new THREE.Group();

  private innerMesh: THREE.Mesh;
  private wireMesh: THREE.Mesh;
  private ringMesh: THREE.Mesh;
  private chargeRing: THREE.Mesh;
  private innerMat: THREE.MeshBasicMaterial;
  private wireMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private chargeMat: THREE.MeshBasicMaterial;

  private statusMesh: THREE.Mesh;
  private statusCanvas: HTMLCanvasElement;
  private statusTex: THREE.CanvasTexture;
  private statusMat: THREE.MeshBasicMaterial;

  private state: OrbState = "idle";
  private chargeProgress = 0;
  private thoughts: ThoughtPanel[] = [];
  private startedThinkingAt = 0;

  constructor() {
    this.group.position.copy(ORB_POS);

    // Solid inner glow
    this.innerMat = new THREE.MeshBasicMaterial({
      color: 0x6366f1,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.innerMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(ORB_RADIUS, 1),
      this.innerMat,
    );
    this.group.add(this.innerMesh);

    // Wireframe shell that spins independently
    this.wireMat = new THREE.MeshBasicMaterial({
      color: 0xa5b4fc,
      wireframe: true,
      transparent: true,
      opacity: 0.85,
    });
    this.wireMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(ORB_RADIUS * 1.18, 1),
      this.wireMat,
    );
    this.group.add(this.wireMesh);

    // Outer faint ring (background halo)
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x6366f1,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(ORB_RADIUS * 1.45, ORB_RADIUS * 1.6, 64),
      this.ringMat,
    );
    this.group.add(this.ringMesh);

    // Charge ring (orange arc that fills as user holds the trigger)
    this.chargeMat = new THREE.MeshBasicMaterial({
      color: 0xfb923c,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.chargeRing = new THREE.Mesh(
      new THREE.RingGeometry(ORB_RADIUS * 1.65, ORB_RADIUS * 1.85, 64, 1, 0, 0.0001),
      this.chargeMat,
    );
    this.group.add(this.chargeRing);

    // Status caption below the orb
    this.statusCanvas = document.createElement("canvas");
    this.statusCanvas.width = 1024;
    this.statusCanvas.height = 192;
    this.statusTex = new THREE.CanvasTexture(this.statusCanvas);
    this.statusTex.colorSpace = THREE.SRGBColorSpace;
    this.statusMat = new THREE.MeshBasicMaterial({
      map: this.statusTex,
      transparent: true,
      depthWrite: false,
    });
    this.statusMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.26),
      this.statusMat,
    );
    this.statusMesh.position.set(0, -ORB_RADIUS * 2.1, 0);
    this.group.add(this.statusMesh);

    this.drawStatus("CURSOR AGENT", "idle — hold either GRIP to run", "#a5b4fc");
  }

  setState(state: OrbState): void {
    this.state = state;
    if (state === "thinking") this.startedThinkingAt = performance.now();

    switch (state) {
      case "idle":
        this.innerMat.color.set(0x6366f1);
        this.wireMat.color.set(0xa5b4fc);
        this.ringMat.color.set(0x6366f1);
        this.drawStatus("CURSOR AGENT", "idle — hold either GRIP to run", "#a5b4fc");
        break;
      case "charging":
        this.innerMat.color.set(0xfb923c);
        this.wireMat.color.set(0xfdba74);
        this.ringMat.color.set(0xf97316);
        this.drawStatus("CURSOR AGENT", "charging…", "#fdba74");
        break;
      case "thinking":
        this.innerMat.color.set(0x22d3ee);
        this.wireMat.color.set(0x67e8f9);
        this.ringMat.color.set(0x06b6d4);
        this.drawStatus("CURSOR AGENT", "thinking…", "#a5f3fc");
        break;
      case "done":
        this.innerMat.color.set(0x22c55e);
        this.wireMat.color.set(0x86efac);
        this.ringMat.color.set(0x16a34a);
        this.drawStatus("CURSOR AGENT", "done", "#bbf7d0");
        // Auto-revert to idle after 2s
        window.setTimeout(() => {
          if (this.state === "done") this.setState("idle");
        }, 2200);
        break;
    }
  }

  /** 0..1 charge progress; updated continuously while user holds the grip. */
  setChargeProgress(p: number): void {
    this.chargeProgress = THREE.MathUtils.clamp(p, 0, 1);
    // Replace the ring geometry with one that has a thetaLength matching p.
    const g = this.chargeRing.geometry as THREE.BufferGeometry;
    g.dispose();
    this.chargeRing.geometry = new THREE.RingGeometry(
      ORB_RADIUS * 1.65,
      ORB_RADIUS * 1.85,
      64,
      1,
      Math.PI / 2,
      Math.PI * 2 * Math.max(0.0001, this.chargeProgress),
    );
    this.chargeMat.opacity = this.chargeProgress > 0.001 ? 0.95 : 0;
  }

  /** Push a new agent reasoning line; renders as a floating panel. */
  pushThought(line: string): void {
    if (!line || line.length === 0) return;
    const panel = new ThoughtPanel(line);
    // Spawn near the orb, then drift to a randomised orbit offset.
    const angle = Math.random() * Math.PI * 2;
    const r = 0.9 + Math.random() * 0.4;
    panel.target.set(
      Math.cos(angle) * r,
      0.15 + Math.random() * 0.65,
      Math.sin(angle) * 0.4 - 0.05,
    );
    panel.group.position.set(0, 0, 0);
    this.group.add(panel.group);
    this.thoughts.push(panel);
    if (this.thoughts.length > 7) {
      const old = this.thoughts.shift()!;
      old.kill();
    }
  }

  /** Camera-facing status caption. */
  faceCamera(camera: THREE.Camera): void {
    this.statusMesh.lookAt(camera.position);
    for (const t of this.thoughts) t.faceCamera(camera);
  }

  tick(now: number): void {
    // Spin: faster when thinking
    const spinRate = this.state === "thinking" ? 0.012 : 0.0035;
    this.wireMesh.rotation.y += spinRate;
    this.wireMesh.rotation.x += spinRate * 0.6;
    this.innerMesh.rotation.y -= spinRate * 0.4;

    // Pulse: stronger when thinking, very stable when idle
    const pulseAmp = this.state === "thinking" ? 0.12 : 0.04;
    const pulseRate = this.state === "thinking" ? 0.005 : 0.0017;
    const s = 1 + Math.sin(now * pulseRate) * pulseAmp;
    this.innerMesh.scale.setScalar(s);

    // Outer ring slowly counter-rotates
    this.ringMesh.rotation.z += 0.0015;

    // Charge ring always faces the camera (handled by group lookAt in faceCamera)
    // but spins gently for life.
    this.chargeRing.rotation.z += 0.004;

    // Brightness oscillation while thinking
    if (this.state === "thinking") {
      const flicker = 0.55 + Math.sin(now * 0.011) * 0.25;
      this.innerMat.opacity = flicker;
      this.ringMat.opacity = 0.35 + Math.sin(now * 0.007) * 0.15;
    } else {
      this.innerMat.opacity = 0.55;
      this.ringMat.opacity = 0.25;
    }

    // Tick thought panels, removing dead ones
    for (let i = this.thoughts.length - 1; i >= 0; i--) {
      const alive = this.thoughts[i]!.tick(now);
      if (!alive) {
        this.group.remove(this.thoughts[i]!.group);
        this.thoughts[i]!.dispose();
        this.thoughts.splice(i, 1);
      }
    }
    void this.startedThinkingAt;
  }

  private drawStatus(title: string, sub: string, color: string): void {
    const ctx = this.statusCanvas.getContext("2d")!;
    const W = this.statusCanvas.width;
    const H = this.statusCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(15,23,42,0.85)";
    roundRect(ctx, 8, 8, W - 16, H - 16, 28);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    roundRect(ctx, 8, 8, W - 16, H - 16, 28);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = "bold 36px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(title, W / 2, H / 2 - 30);

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "30px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(sub, W / 2, H / 2 + 30);

    this.statusTex.needsUpdate = true;
  }

  dispose(): void {
    for (const t of this.thoughts) t.dispose();
    this.thoughts = [];
    this.innerMesh.geometry.dispose();
    this.wireMesh.geometry.dispose();
    this.ringMesh.geometry.dispose();
    this.chargeRing.geometry.dispose();
    this.statusMesh.geometry.dispose();
    this.innerMat.dispose();
    this.wireMat.dispose();
    this.ringMat.dispose();
    this.chargeMat.dispose();
    this.statusMat.dispose();
    this.statusTex.dispose();
  }
}

// ---------------------------------------------------------------------------
// Thought panel — small text card that floats up and outward from the orb
// ---------------------------------------------------------------------------

class ThoughtPanel {
  readonly group = new THREE.Group();
  readonly target = new THREE.Vector3();
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private tex: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private spawnedAt = performance.now();
  private dying = false;

  constructor(text: string) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 720;
    this.canvas.height = 130;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.14), this.mat);
    this.group.add(this.mesh);
    this.draw(text);
  }

  faceCamera(camera: THREE.Camera): void {
    this.mesh.lookAt(camera.position);
  }

  tick(now: number): boolean {
    const dt = (now - this.spawnedAt) / 4500; // 4.5s lifetime
    if (dt >= 1) return false;
    if (dt > 0.7 && !this.dying) this.dying = true;

    // Move from origin toward target with slight orbit drift
    const k = easeOutCubic(Math.min(1, dt * 1.5));
    this.group.position.lerpVectors(new THREE.Vector3(0, 0, 0), this.target, k);

    // Orbit drift
    const drift = (now - this.spawnedAt) * 0.0004;
    this.group.position.x += Math.sin(drift) * 0.02;
    this.group.position.y += Math.cos(drift) * 0.015;

    // Fade
    if (dt < 0.15) {
      this.mat.opacity = dt / 0.15;
    } else if (dt > 0.7) {
      this.mat.opacity = 1 - (dt - 0.7) / 0.3;
    } else {
      this.mat.opacity = 1;
    }
    return true;
  }

  kill(): void {
    this.spawnedAt = performance.now() - 4500;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }

  private draw(line: string): void {
    const ctx = this.canvas.getContext("2d")!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Determine color/icon by line content
    let accent = "#a5b4fc";
    let icon = "▸";
    if (/tool|specter|mcp|lookup/i.test(line)) {
      accent = "#22d3ee";
      icon = "⚙";
    } else if (/auto[-_ ]?pa(y|id)/i.test(line)) {
      accent = "#22c55e";
      icon = "✓";
    } else if (/escalat|review|risk|flag/i.test(line)) {
      accent = "#fbbf24";
      icon = "!";
    } else if (/error|fail/i.test(line)) {
      accent = "#f87171";
      icon = "×";
    } else if (/think|reason|score/i.test(line)) {
      accent = "#c4b5fd";
      icon = "◇";
    }

    ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
    roundRect(ctx, 4, 4, W - 8, H - 8, 24);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    roundRect(ctx, 4, 4, W - 8, H - 8, 24);
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.font = "bold 64px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(icon, 56, H / 2);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "30px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const text = line.length > 80 ? line.slice(0, 77) + "…" : line;
    ctx.fillText(text, 110, H / 2);

    this.tex.needsUpdate = true;
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
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
