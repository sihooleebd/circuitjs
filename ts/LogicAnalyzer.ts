/*
    Copyright (C) Paul Falstad and Iain Sharp

    This file is part of CircuitJS1.

    CircuitJS1 is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 2 of the License, or
    (at your option) any later version.

    CircuitJS1 is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with CircuitJS1.  If not, see <http://www.gnu.org/licenses/>.
*/

// Multi-channel timing view: one row per signal, signals named like Q0..Q3 grouped into a
// Q[3:0] bus row shown in hex. Hover for values, click to drop a reference marker (shows
// delta-t), wheel to zoom, drag to pan, "Live" to follow the simulation again.

import { Dialog } from "./Dialog";
import { CirSim } from "./CirSim";
import { CircuitElm } from "./CircuitElm";
import { Locale } from "./Locale";
import { SignalRecorder, defaultSignals, isClockElm, labelForPost } from "./SignalRecorder";
import type { Signal } from "./SignalRecorder";
import { digitalOutputPosts } from "./digital/DigitalGraphBuilder";

// One display row: a single bit, or a bus (bits MSB first).
export interface AnalyzerRow { name: string; bits: SignalRecorder[]; }

// Groups labeled recorders named prefix+index (Q0, Q1 / D[0], D[1]) into bus rows; everything
// else (including made-up names like OUT1, which say nothing about bit order) stays a single-bit row. Order follows the first member's position in `recs`.
export function groupBuses(recs: SignalRecorder[]): AnalyzerRow[] {
    const rows: AnalyzerRow[] = [];
    const buses = new Map<string, { row: AnalyzerRow; idx: number[] }>();
    for (const r of recs) {
        const m = r.signal?.auto ? null : /^(.*?[^\d\[])\[?(\d+)\]?$/.exec(r.name);
        if (m == null) { rows.push({ name: r.name, bits: [r] }); continue; }
        let bus = buses.get(m[1]);
        if (bus == null) {
            bus = { row: { name: m[1], bits: [] }, idx: [] };
            buses.set(m[1], bus);
            rows.push(bus.row);
        }
        bus.row.bits.push(r);
        bus.idx.push(parseInt(m[2]));
    }
    for (const [prefix, bus] of buses) {
        if (bus.row.bits.length === 1) { bus.row.name = bus.row.bits[0].name; continue; }
        const order = bus.idx.map((n, i) => i).sort((a, b) => bus.idx[b] - bus.idx[a]);
        bus.row.bits = order.map(i => bus.row.bits[i]);
        bus.row.name = prefix + "[" + bus.idx[order[0]] + ":" + bus.idx[order[order.length - 1]] + "]";
    }
    return rows;
}

// Bus value at tick t (bits MSB first), or null if any bit is undriven/unknown.
export function rowValueAt(row: AnalyzerRow, t: number): number | null {
    let v = 0;
    for (const b of row.bits) {
        const bit = b.valueAt(t);
        if (bit == null) return null;
        v = v * 2 + bit;
    }
    return v;
}

export function formatRowValue(row: AnalyzerRow, v: number | null): string {
    if (v == null) return row.bits.length === 1 ? "Z" : "?";
    return row.bits.length === 1 ? String(v) : v.toString(16).toUpperCase();
}

// Value Change Dump of every recorded transition, times in ps.
export function toVCD(rows: AnalyzerRow[], tickSeconds: number): string {
    const ps = (t: number) => Math.round(t * tickSeconds * 1e12);
    const ids = rows.map((_, i) => String.fromCharCode(33 + (i % 94)) + (i >= 94 ? String(Math.floor(i / 94)) : ""));
    const lines = ["$date " + new Date().toISOString() + " $end", "$version CircuitJS1 $end", "$timescale 1 ps $end",
                   "$scope module circuit $end"];
    rows.forEach((r, i) => lines.push("$var wire " + r.bits.length + " " + ids[i] + " " + r.name.replace(/\s/g, "_") + " $end"));
    lines.push("$upscope $end", "$enddefinitions $end");
    const times = [...new Set(rows.flatMap(r => r.bits.flatMap(b => b.times)))].sort((a, b) => a - b);
    const last: (string | null)[] = rows.map((): string | null => null);
    for (const t of times) {
        const changes: string[] = [];
        rows.forEach((r, i) => {
            const v = rowValueAt(r, t);
            const s = r.bits.length === 1 ? (v == null ? "x" : String(v)) + ids[i]
                : "b" + (v == null ? "x".repeat(r.bits.length) : v.toString(2)) + " " + ids[i];
            if (s !== last[i]) changes.push(last[i] = s);
        });
        if (changes.length) lines.push("#" + ps(t), ...changes);
    }
    return lines.join("\n") + "\n";
}

export class LogicAnalyzer extends Dialog {
    static instance: LogicAnalyzer | null = null;
    static readonly NAME_W = 130;
    static readonly ROW_H = 26;
    static readonly WAVE_W = 640;

    static toggle(app: CirSim): void {
        if (LogicAnalyzer.instance) LogicAnalyzer.instance.closeDialog();
        else new LogicAnalyzer(app).show();
    }

    private app: CirSim;
    private recorders: SignalRecorder[] = [];
    private rows: AnalyzerRow[] = [];
    private canvas: HTMLCanvasElement;
    private status: HTMLElement;
    private grouped = true;
    private ticksPerPx = 1;
    private endTick = 0;
    private follow = true;
    private mouseX = -1;
    private markerTick: number | null = null;
    private dragStartX = -1;
    private dragStartEnd = 0;
    private frame = 0;

    constructor(app: CirSim) {
        super();
        this.app = app;
        this.closeOnEnter = false;
        LogicAnalyzer.instance = this;

        const title = document.createElement("h3");
        title.textContent = Locale.LS("Logic Analyzer");
        title.style.margin = "0 0 6px 0";
        this.dialogEl.appendChild(title);

        const bar = document.createElement("div");
        bar.style.display = "flex";
        bar.style.gap = "6px";
        bar.style.alignItems = "center";
        bar.style.marginBottom = "6px";
        const button = (label: string, fn: () => void) => {
            const b = document.createElement("button");
            b.textContent = Locale.LS(label);
            b.onclick = fn;
            bar.appendChild(b);
            return b;
        };
        button("Add Selected", () => this.addSelected());
        button("Reset Signals", () => this.setSignals(defaultSignals(this.app.elmList)));
        button("Clear", () => { this.recorders.forEach(r => r.clear()); this.markerTick = null; });
        button("Live", () => { this.follow = true; });
        const group = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.onchange = () => { this.grouped = cb.checked; this.layout(); };
        group.append(cb, Locale.LS("Group buses"));
        bar.appendChild(group);
        button("Export VCD", () => this.exportVCD());
        button("Close", () => this.closeDialog());
        this.dialogEl.appendChild(bar);

        this.canvas = document.createElement("canvas");
        this.canvas.style.display = "block";
        this.canvas.style.cursor = "crosshair";
        this.dialogEl.appendChild(this.canvas);
        this.status = document.createElement("div");
        this.status.style.fontFamily = "monospace";
        this.status.style.marginTop = "4px";
        this.dialogEl.appendChild(this.status);
        this.setupMouse();

        this.setSignals(defaultSignals(app.elmList));
        this.ticksPerPx = this.defaultZoom();
    }

    // non-modal, so the circuit stays usable (and running) while the analyzer is open
    show(): void {
        Object.assign(this.dialogEl.style, { position: "fixed", right: "20px", bottom: "20px", left: "auto", top: "auto", margin: "0" });
        this.dialogEl.show();
        const tick = () => { this.update(); this.frame = requestAnimationFrame(tick); };
        tick();
    }

    closeDialog(): void {
        cancelAnimationFrame(this.frame);
        this.recorders.forEach(r => r.detach());
        LogicAnalyzer.instance = null;
        super.closeDialog();
    }

    getRows(): AnalyzerRow[] { return this.rows; }

    setSignals(signals: Signal[]): void {
        this.recorders.forEach(r => r.detach());
        this.recorders = signals.map(s => new SignalRecorder(s));
        this.layout();
    }

    private addSelected(): void {
        const have = new Set(this.recorders.map(r => r.signal.elm.nodes?.[r.signal.post]));
        let n = 0;
        for (const elm of this.app.elmList.filter(e => e.isSelected())) {
            const posts = digitalOutputPosts(elm);
            for (const post of posts.length ? posts : [0]) {
                if (elm.nodes?.[post] == null || have.has(elm.nodes[post])) continue;
                have.add(elm.nodes[post]);
                const pin = (elm as any).pins?.[post]?.text;
                const name = labelForPost(elm, post) ?? (elm.getClassName().replace("Elm", "") + (++n) + (pin ? "." + pin : ""));
                this.recorders.push(new SignalRecorder({ elm, post, name }));
            }
        }
        this.layout();
    }

    private layout(): void {
        this.rows = this.grouped ? groupBuses(this.recorders) : this.recorders.map(r => ({ name: r.name, bits: [r] }));
        const dpr = window.devicePixelRatio || 1;
        const w = LogicAnalyzer.NAME_W + LogicAnalyzer.WAVE_W, h = Math.max(1, this.rows.length) * LogicAnalyzer.ROW_H + 20;
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.canvas.style.width = w + "px";
        this.canvas.style.height = h + "px";
    }

    // eight clock periods across the window if there's a clock, else one tick per pixel
    private defaultZoom(): number {
        const clk = this.app.elmList.find(isClockElm) as any;
        if (clk == null || !(clk.frequency > 0)) return 1;
        return 8 / (clk.frequency * this.app.sim.maxTimeStep) / LogicAnalyzer.WAVE_W;
    }

    private nowTick(): number { return this.app.sim.digitalTickEpoch + (this.app.sim.digitalGraph?.circuit.globalTime ?? 0); }
    private xToTick(x: number): number { return this.endTick - (LogicAnalyzer.NAME_W + LogicAnalyzer.WAVE_W - x) * this.ticksPerPx; }
    private tickToX(t: number): number { return LogicAnalyzer.NAME_W + LogicAnalyzer.WAVE_W - (this.endTick - t) / this.ticksPerPx; }
    private timeText(ticks: number): string { return CircuitElm.getTimeText(ticks * this.app.sim.maxTimeStep); }

    private setupMouse(): void {
        const cv = this.canvas;
        cv.addEventListener("mousemove", e => {
            this.mouseX = e.offsetX;
            if (this.dragStartX >= 0 && Math.abs(e.offsetX - this.dragStartX) > 3) {
                this.follow = false;
                this.endTick = this.dragStartEnd - (e.offsetX - this.dragStartX) * this.ticksPerPx;
            }
        });
        cv.addEventListener("mouseleave", () => { this.mouseX = -1; this.dragStartX = -1; });
        cv.addEventListener("mousedown", e => { this.dragStartX = e.offsetX; this.dragStartEnd = this.endTick; });
        cv.addEventListener("mouseup", e => {
            if (Math.abs(e.offsetX - this.dragStartX) <= 3 && e.offsetX > LogicAnalyzer.NAME_W)
                this.markerTick = this.markerTick == null ? this.xToTick(e.offsetX) : null;
            this.dragStartX = -1;
        });
        cv.addEventListener("wheel", e => {
            e.preventDefault();
            const anchor = this.xToTick(Math.max(e.offsetX, LogicAnalyzer.NAME_W));
            this.ticksPerPx *= Math.exp(e.deltaY * 0.002);
            // keep the tick under the mouse where it is
            this.endTick = anchor + (LogicAnalyzer.NAME_W + LogicAnalyzer.WAVE_W - Math.max(e.offsetX, LogicAnalyzer.NAME_W)) * this.ticksPerPx;
            if (this.endTick < this.nowTick()) this.follow = false;
        }, { passive: false });
    }

    private update(): void {
        // drop signals whose element was deleted
        const live = this.recorders.filter(r => this.app.elmList.includes(r.signal.elm));
        if (live.length !== this.recorders.length) {
            this.recorders.filter(r => !live.includes(r)).forEach(r => r.detach());
            this.recorders = live;
            this.layout();
        }
        for (const r of this.recorders) r.harvest(this.app.sim);
        if (this.follow) this.endTick = this.nowTick();
        this.draw();
    }

    private draw(): void {
        const dpr = window.devicePixelRatio || 1;
        const g = this.canvas.getContext("2d")!;
        const { NAME_W, ROW_H, WAVE_W } = LogicAnalyzer;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = "#000";
        g.fillRect(0, 0, NAME_W + WAVE_W, this.canvas.height / dpr);
        g.font = "12px sans-serif";
        g.textBaseline = "middle";
        const t0 = this.xToTick(NAME_W), t1 = this.endTick;
        const cursorTick = this.mouseX > NAME_W ? this.xToTick(this.mouseX) : null;

        this.rows.forEach((row, i) => {
            const top = i * ROW_H + 4, hi = top + 3, lo = top + ROW_H - 7, mid = (hi + lo) / 2;
            const shown = cursorTick ?? t1;
            g.fillStyle = "#ccc";
            g.fillText(row.name + " = " + formatRowValue(row, rowValueAt(row, shown)), 4, mid, NAME_W - 8);
            g.strokeStyle = "#222";
            g.beginPath(); g.moveTo(NAME_W, top + ROW_H - 2); g.lineTo(NAME_W + WAVE_W, top + ROW_H - 2); g.stroke();

            // transition times in the window, across every bit of the row
            const times = [t0];
            for (const b of row.bits) {
                let k = b.firstAfter(t0);
                for (; k < b.times.length && b.times[k] <= t1; k++) times.push(b.times[k]);
            }
            times.sort((a, b) => a - b);
            times.push(t1);
            g.strokeStyle = row.bits.length === 1 ? "#0f0" : "#0cf";
            g.lineWidth = 1.5;
            for (let k = 0; k + 1 < times.length; k++) {
                const xa = Math.max(NAME_W, this.tickToX(times[k])), xb = this.tickToX(times[k + 1]);
                const v = rowValueAt(row, times[k]);
                g.beginPath();
                if (v == null) {
                    g.strokeStyle = "#666";
                    g.moveTo(xa, mid); g.lineTo(xb, mid);
                } else if (row.bits.length === 1) {
                    g.strokeStyle = "#0f0";
                    const y = v ? hi : lo;
                    if (k > 0) { g.moveTo(xa, hi); g.lineTo(xa, lo); }
                    g.moveTo(xa, y); g.lineTo(xb, y);
                } else {
                    g.strokeStyle = "#0cf";
                    const e = Math.min(3, (xb - xa) / 2);
                    g.moveTo(xa, mid); g.lineTo(xa + e, hi); g.lineTo(xb - e, hi); g.lineTo(xb, mid);
                    g.lineTo(xb - e, lo); g.lineTo(xa + e, lo); g.closePath();
                    const s = formatRowValue(row, v);
                    if (g.measureText(s).width < xb - xa - 6) {
                        g.fillStyle = "#fff";
                        g.fillText(s, (xa + xb) / 2 - g.measureText(s).width / 2, mid);
                    }
                }
                g.stroke();
            }
        });

        const axisY = this.rows.length * ROW_H + 12;
        g.fillStyle = "#888";
        g.fillText(this.timeText(this.ticksPerPx * WAVE_W) + " / window", NAME_W + 4, axisY);
        g.lineWidth = 1;
        const vline = (x: number, color: string, dash: number[]) => {
            g.strokeStyle = color; g.setLineDash(dash);
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, axisY - 6); g.stroke();
            g.setLineDash([]);
        };
        if (this.markerTick != null) vline(this.tickToX(this.markerTick), "#f80", [4, 3]);
        if (cursorTick != null) vline(this.mouseX, "#fff", []);

        let s = cursorTick != null ? "t = " + this.timeText(cursorTick) : "t = " + this.timeText(this.nowTick());
        if (this.markerTick != null)
            s += "   marker = " + this.timeText(this.markerTick) + (cursorTick != null ? "   Δt = " + this.timeText(cursorTick - this.markerTick) : "");
        if (this.rows.length === 0) s = Locale.LS("No signals: add logic inputs/outputs or labeled nodes, or select elements and press Add Selected.");
        this.status.textContent = s;
    }

    private exportVCD(): void {
        const blob = new Blob([toVCD(this.rows, this.app.sim.maxTimeStep)], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "circuit.vcd";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
}
