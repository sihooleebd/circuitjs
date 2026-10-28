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

// Static critical-path analysis over the digital engine's chip graph, plus a live monitor for
// setup/hold violations and glitches. Elements involved are outlined on the circuit
// (TimingAnalysis.marks, drawn by UIManager).

import { Dialog } from "./Dialog";
import { CirSim } from "./CirSim";
import { CircuitElm } from "./CircuitElm";
import { Locale } from "./Locale";
import { SignalRecorder, labelForPost } from "./SignalRecorder";
import { Chip } from "./digital/chip";
import { isDigitalInitialStateSource } from "./digital/DigitalGraphBuilder";
import type { DigitalGraph } from "./digital/DigitalGraphBuilder";

export interface PathReport {
    ticks: number;              // longest combinational path, clock-to-Q of a launching register included
    elms: CircuitElm[];         // start to end
    regTicks: number | null;    // worst register-to-register path, null if there is none
    regElms: CircuitElm[];
    loop: boolean;              // a combinational feedback loop was cut
}

export interface Violation { tick: number; kind: string; elm: CircuitElm; text: string; }

export class TimingAnalysis {
    // element -> outline color; drawn by UIManager after the circuit
    static marks = new Map<CircuitElm, string>();

    static criticalPath(graph: DigitalGraph): PathReport {
        const chipElm = new Map<Chip, CircuitElm>();
        const regChips = new Set<Chip>();
        for (const [elm, chips] of graph.chipsByElm)
            for (const c of chips) {
                if (c === graph.circuit.chips[0] || c === graph.circuit.chips[1]) continue;
                chipElm.set(c, elm);
                if (isDigitalInitialStateSource(elm)) regChips.add(c);
            }
        const isStart = (c: Chip) => c.inputLinks.length === 0 || regChips.has(c);
        const delay = (c: Chip) => Math.max(c.delay[0], c.delay[1]);

        interface Arr { t: number; prev: Chip | null; fromReg: boolean; }
        const memo = new Map<Chip, Arr>();
        const visiting = new Set<Chip>();
        let loop = false;
        const arrival = (c: Chip): Arr => {
            if (isStart(c)) return { t: regChips.has(c) ? delay(c) : 0, prev: null, fromReg: regChips.has(c) };
            const m = memo.get(c);
            if (m) return m;
            if (visiting.has(c)) { loop = true; return { t: 0, prev: null, fromReg: false }; }
            visiting.add(c);
            let best: Arr = { t: -1, prev: null, fromReg: false };
            for (const link of c.inputLinks) {
                if (!link) continue;
                const a = arrival(link.chip);
                if (a.t > best.t) best = { t: a.t, prev: link.chip, fromReg: a.fromReg };
            }
            visiting.delete(c);
            const r = { t: Math.max(0, best.t) + delay(c), prev: best.prev, fromReg: best.fromReg };
            memo.set(c, r);
            return r;
        };

        const trace = (end: Chip): CircuitElm[] => {
            const out: CircuitElm[] = [];
            for (let c: Chip | null = end; c != null; c = isStart(c) ? null : arrival(c).prev) {
                const e = chipElm.get(c);
                if (e != null && out[0] !== e) out.unshift(e);
            }
            return out;
        };

        let worst: Chip | null = null, worstT = 0;
        for (const c of graph.circuit.chips) {
            if (isStart(c) || !chipElm.has(c)) continue;
            const a = arrival(c);
            if (a.t > worstT) { worstT = a.t; worst = c; }
        }
        // register data inputs fed (through logic, or directly) by another register; whatever
        // drives a register's clock pin is a clock path (e.g. a ripple counter), not a data path
        const clockDriver = new Map<CircuitElm, Set<Chip>>();
        for (const [elm] of graph.chipsByElm) {
            const pins: any[] | undefined = (elm as any).pins;
            if (!isDigitalInitialStateSource(elm as any) || !Array.isArray(pins)) continue;
            clockDriver.set(elm, new Set(pins.flatMap((p, i) => {
                const c = p.clock ? graph.triStateChipByNode.get(elm.nodes[i]) : undefined;
                return c ? [c] : [];
            })));
        }
        let regWorst: Chip | null = null, regEnd: CircuitElm | null = null, regT = -1;
        for (const r of regChips) {
            const re = chipElm.get(r)!;
            for (const link of r.inputLinks) {
                if (!link || chipElm.get(link.chip) === re || clockDriver.get(re)?.has(link.chip)) continue;
                const a = arrival(link.chip);
                if (a.fromReg && a.t > regT) { regT = a.t; regWorst = link.chip; regEnd = re; }
            }
        }
        return {
            ticks: worstT, elms: worst ? trace(worst) : [],
            regTicks: regWorst ? regT : null, regElms: regWorst ? [...trace(regWorst), regEnd!] : [],
            loop,
        };
    }
}

// a clocked element's clock and synchronous data inputs, for setup/hold checks
interface ClockedElm { elm: CircuitElm; clock: SignalRecorder; data: { rec: SignalRecorder; pin: string }[]; fallingEdge: boolean; checkedTo: number; }

const ASYNC_PINS = /^(S|R|SET|RST|RESET|PRE|CLR)$/i;

export class TimingPanel extends Dialog {
    static instance: TimingPanel | null = null;

    static toggle(app: CirSim): void {
        if (TimingPanel.instance) TimingPanel.instance.closeDialog();
        else new TimingPanel(app).show();
    }

    private app: CirSim;
    private report: HTMLElement;
    private list: HTMLElement;
    private monitorBox: HTMLInputElement;
    private setupIn: HTMLInputElement;
    private holdIn: HTMLInputElement;
    private glitchIn: HTMLInputElement;
    private graph: DigitalGraph | null = null;
    private clocked: ClockedElm[] = [];
    private watched: SignalRecorder[] = [];   // every recorder, for glitch checks
    private glitchChecked = new Map<SignalRecorder, number>();
    private frame = 0;

    constructor(app: CirSim) {
        super();
        this.app = app;
        this.closeOnEnter = false;
        TimingPanel.instance = this;
        const el = (tag: string, text = "") => { const e = document.createElement(tag); e.textContent = text; return e; };
        const tick = CircuitElm.getTimeText(app.sim.maxTimeStep);

        const title = el("h3", Locale.LS("Timing"));
        title.style.margin = "0 0 6px 0";
        this.dialogEl.appendChild(title);

        const pathBtn = el("button", Locale.LS("Find Critical Path")) as HTMLButtonElement;
        pathBtn.onclick = () => this.showCriticalPath();
        const clearBtn = el("button", Locale.LS("Clear Highlights")) as HTMLButtonElement;
        clearBtn.onclick = () => { TimingAnalysis.marks.clear(); this.app.repaint(); };
        const closeBtn = el("button", Locale.LS("Close")) as HTMLButtonElement;
        closeBtn.onclick = () => this.closeDialog();
        const row1 = el("div");
        row1.style.display = "flex"; row1.style.gap = "6px";
        row1.append(pathBtn, clearBtn, closeBtn);
        this.dialogEl.appendChild(row1);
        this.report = el("pre");
        this.report.style.whiteSpace = "pre-wrap";
        this.report.style.maxWidth = "520px";
        this.dialogEl.appendChild(this.report);

        const num = (v: number) => { const i = document.createElement("input"); i.type = "number"; i.min = "0"; i.value = String(v); i.style.width = "4em"; return i; };
        this.setupIn = num(1); this.holdIn = num(1); this.glitchIn = num(2);
        this.monitorBox = document.createElement("input");
        this.monitorBox.type = "checkbox";
        this.monitorBox.onchange = () => { this.graph = null; if (!this.monitorBox.checked) this.detachAll(); };
        const row2 = el("div");
        row2.style.display = "flex"; row2.style.gap = "6px"; row2.style.alignItems = "center"; row2.style.flexWrap = "wrap";
        const lbl = el("label");
        lbl.append(this.monitorBox, Locale.LS("Check timing while running"));
        row2.append(lbl, Locale.LS("setup"), this.setupIn, Locale.LS("hold"), this.holdIn, Locale.LS("min pulse"), this.glitchIn,
                    "ticks (1 tick = " + tick + ")");
        this.dialogEl.appendChild(row2);
        this.list = el("div");
        this.list.style.maxHeight = "200px";
        this.list.style.overflowY = "auto";
        this.list.style.fontFamily = "monospace";
        this.list.style.fontSize = "12px";
        this.dialogEl.appendChild(this.list);
    }

    show(): void {
        Object.assign(this.dialogEl.style, { position: "fixed", left: "20px", bottom: "20px", top: "auto", margin: "0" });
        this.dialogEl.show();
        const loop = () => { this.update(); this.frame = requestAnimationFrame(loop); };
        loop();
    }

    closeDialog(): void {
        cancelAnimationFrame(this.frame);
        this.detachAll();
        TimingAnalysis.marks.clear();
        this.app.repaint();
        TimingPanel.instance = null;
        super.closeDialog();
    }

    private ticksText(t: number): string { return t + " ticks = " + CircuitElm.getTimeText(t * this.app.sim.maxTimeStep); }
    private name(e: CircuitElm): string { return labelForPost(e, 0) ?? e.getClassName().replace("Elm", ""); }

    private showCriticalPath(): void {
        if (!this.app.sim.ensureDigitalGraph()) { this.report.textContent = Locale.LS("Circuit has no digital elements."); return; }
        const r = TimingAnalysis.criticalPath(this.app.sim.digitalGraph!);
        TimingAnalysis.marks.clear();
        [...r.elms, ...r.regElms].forEach(e => TimingAnalysis.marks.set(e, "#f80"));
        let s = r.elms.length === 0 ? Locale.LS("No combinational logic between inputs/registers and outputs.")
            : Locale.LS("Longest path") + ": " + this.ticksText(r.ticks) + " (" + r.elms.length + " elements)\n  "
              + r.elms.map(e => this.name(e)).join(" → ");
        if (r.regTicks != null) {
            const hz = 1 / (r.regTicks * this.app.sim.maxTimeStep);
            s += "\n" + Locale.LS("Worst register-to-register path") + ": " + this.ticksText(r.regTicks)
                + "\n  " + r.regElms.map(e => this.name(e)).join(" → ")
                + "\n" + Locale.LS("Max clock frequency") + " ≈ " + CircuitElm.getUnitText(hz, "Hz") + " (" + Locale.LS("ignores setup time") + ")";
        }
        if (r.loop) s += "\n" + Locale.LS("Note: a combinational feedback loop (e.g. a gate-level latch) was cut for this analysis.");
        this.report.textContent = s;
        this.app.repaint();
    }

    private detachAll(): void {
        this.watched.forEach(r => r.detach());
        this.watched = [];
        this.clocked = [];
        this.glitchChecked.clear();
    }

    // (re)build the watch list after the circuit changes
    private attach(): void {
        this.detachAll();
        const byNode = new Map<any, SignalRecorder>();
        const rec = (elm: CircuitElm, post: number, name: string) => {
            const node = elm.nodes?.[post];
            let r = byNode.get(node);
            if (r == null) {
                r = new SignalRecorder({ elm, post, name });
                byNode.set(node, r);
                this.watched.push(r);
            }
            return r;
        };
        for (const elm of this.app.elmList) {
            const pins: any[] | undefined = (elm as any).pins;
            if (elm.getClassName() === "LogicOutputElm") rec(elm, 0, this.name(elm));
            if (!Array.isArray(pins)) continue;
            const ck = pins.findIndex(p => p.clock);
            if (ck < 0) continue;
            const data = pins.map((p, i) => ({ p, i })).filter(({ p, i }) => i !== ck && !p.output && p.text && !ASYNC_PINS.test(p.text));
            this.clocked.push({
                elm, clock: rec(elm, ck, this.name(elm) + ".CLK"),
                data: data.map(({ p, i }) => ({ rec: rec(elm, i, this.name(elm) + "." + p.text), pin: p.text })),
                fallingEdge: !!(pins[ck].bubble || pins[ck].lineOver), checkedTo: -Infinity,
            });
        }
    }

    private update(): void {
        if (!this.monitorBox.checked) return;
        const sim = this.app.sim;
        if (sim.digitalGraph == null) return;
        if (sim.digitalGraph !== this.graph) { this.attach(); this.graph = sim.digitalGraph; }
        for (const r of this.watched) r.harvest(sim);
        const now = sim.digitalTickEpoch + sim.digitalGraph.circuit.globalTime;
        const setup = +this.setupIn.value || 0, hold = +this.holdIn.value || 0, minPulse = +this.glitchIn.value || 0;
        const found: Violation[] = [];

        for (const f of this.clocked) {
            const ct = f.clock.times, cv = f.clock.values;
            for (let k = Math.max(1, f.clock.firstAfter(f.checkedTo)); k < ct.length && ct[k] + hold <= now; k++) {
                const te = ct[k];
                f.checkedTo = te;
                if (cv[k] !== (f.fallingEdge ? 0 : 1)) continue;
                for (const d of f.data)
                    // j > 0: index 0 is the value when recording started, not a transition
                    for (let j = Math.max(1, d.rec.firstAfter(te - setup)); j < d.rec.times.length && d.rec.times[j] < te + hold; j++) {
                        const t = d.rec.times[j];
                        const kind = t <= te ? "setup" : "hold";
                        found.push({ tick: te, kind, elm: f.elm,
                                     text: kind + ": " + this.name(f.elm) + "." + d.pin + " changed " + this.ticksText(Math.abs(te - t)) + (t <= te ? " before" : " after") + " clock edge" });
                    }
            }
        }
        if (minPulse > 0)
            for (const r of this.watched) {
                const from = this.glitchChecked.get(r) ?? 1;
                for (let k = Math.max(1, from); k + 1 < r.times.length; k++)
                    if (r.times[k + 1] - r.times[k] < minPulse)
                        found.push({ tick: r.times[k], kind: "glitch", elm: r.signal.elm,
                                     text: "glitch: " + this.ticksText(r.times[k + 1] - r.times[k]) + " pulse on " + r.name });
                this.glitchChecked.set(r, Math.max(1, r.times.length - 1));
            }

        if (found.length === 0) return;
        for (const v of found) {
            TimingAnalysis.marks.set(v.elm, "#f00");
            const line = document.createElement("div");
            line.textContent = "t=" + CircuitElm.getTimeText(v.tick * sim.maxTimeStep) + "  " + v.text;
            line.style.cursor = "pointer";
            line.onclick = () => { TimingAnalysis.marks.clear(); TimingAnalysis.marks.set(v.elm, "#f00"); this.app.repaint(); };
            this.list.prepend(line);
        }
        while (this.list.childElementCount > 200) this.list.lastElementChild!.remove();
        this.app.repaint();
    }
}
