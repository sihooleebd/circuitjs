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

// Records every transition of one circuit node off the digital engine's Chip.history, the
// same way ScopePlot.fillFromDigitalHistory() does, so nothing narrower than a frame is
// missed. Used by the logic analyzer, VCD export and timing checks.

import { CircuitElm } from "./CircuitElm";
import { SimulationManager } from "./SimulationManager";
import { Chip, ChipState } from "./digital/chip";
import type { HistoryWatcher } from "./digital/chip";
import type { DigitalGraph } from "./digital/DigitalGraphBuilder";

// A node is named by (element, post) rather than by CircuitNode, since every circuit edit
// rebuilds the node list (and the digital graph) but keeps the elements.
// `auto`: the name was made up (IN1, OUT2...) rather than taken from a label, so its number says
// nothing about bit significance.
export interface Signal { elm: CircuitElm; post: number; name: string; auto?: boolean; }

// Chip that determines a node's value in `graph`, or null if nothing digital drives it.
export function nodeChip(graph: DigitalGraph, elm: CircuitElm, post: number): Chip | null {
    const node = elm.nodes?.[post];
    return node == null ? null : graph.triStateChipByNode.get(node) ?? null;
}

export function isClockElm(elm: any): boolean {
    return typeof elm.isDigitalClock === "function" && elm.isDigitalClock();
}

// Text of a labeled node sharing this post's node, if any.
export function labelForPost(elm: CircuitElm, post: number): string | null {
    if (elm.getClassName() === "LabeledNodeElm") return (elm as any).text;
    for (const link of elm.nodes?.[post]?.links ?? [])
        if (link.elm.getClassName() === "LabeledNodeElm") return (link.elm as any).text;
    return null;
}

const byPosition = (a: CircuitElm, b: CircuitElm) => (a.y - b.y) || (a.x - b.x);

// The circuit's interesting signals: clocks, logic inputs, labeled nodes and logic outputs, one
// per node, named by label where there is one.
export function defaultSignals(elmList: CircuitElm[]): Signal[] {
    const kinds: [string, (e: CircuitElm) => boolean][] = [
        ["CLK", isClockElm],
        ["IN", e => e.getClassName() === "LogicInputElm"],
        ["", e => e.getClassName() === "LabeledNodeElm"],
        ["OUT", e => e.getClassName() === "LogicOutputElm"],
    ];
    const seen = new Set<any>();
    const out: Signal[] = [];
    for (const [prefix, test] of kinds) {
        let n = 0;
        for (const elm of elmList.filter(test).sort(byPosition)) {
            n++;
            const node = elm.nodes?.[0];
            if (node == null || seen.has(node)) continue;
            seen.add(node);
            const label = labelForPost(elm, 0);
            out.push({ elm, post: 0, name: label ?? prefix + n, auto: label == null });
        }
    }
    return out;
}

export class SignalRecorder implements HistoryWatcher {
    static readonly MAX_TRANSITIONS = 50000;

    // transitions, in absolute ticks (see SimulationManager.digitalTickEpoch)
    times: number[] = [];
    values: number[] = [];
    private graph: DigitalGraph | null = null;
    private chip: Chip | null = null;
    private readTo = -1; // chip-local time `history` has been copied through

    constructor(public signal: Signal) { }

    get name(): string { return this.signal.name; }
    get driven(): boolean { return this.chip != null; }

    historyFloor(): number { return this.readTo; }

    // index of the first transition after tick t
    firstAfter(t: number): number {
        let lo = 0, hi = this.times.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.times[mid] <= t) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    valueAt(t: number): number | null {
        const i = this.firstAfter(t);
        return i === 0 ? null : this.values[i - 1];
    }

    clear(): void { this.times = []; this.values = []; }

    detach(): void {
        this.chip?.removeHistoryWatcher(this);
        this.chip = null;
        this.graph = null;
    }

    // Pull in whatever happened since the last call. Call once per frame (and after a step).
    harvest(sim: SimulationManager): void {
        const graph = sim.digitalGraph;
        if (graph == null) return;
        const epoch = sim.digitalTickEpoch;
        if (graph !== this.graph) {
            this.detach();
            this.graph = graph;
            this.chip = nodeChip(graph, this.signal.elm, this.signal.post);
            if (this.chip == null) return;
            const now = this.chip.circuit.globalTime;
            this.chip.skipBackfillTo(now);
            this.chip.addHistoryWatcher(this);
            this.readTo = now;
            this.push(epoch + now, this.chip.currentValue());
            return;
        }
        const chip = this.chip;
        if (chip == null) return;
        const globalTime = chip.circuit.globalTime;
        const now = chip.state === ChipState.ASLEEP ? Math.min(chip.backfillHistory(globalTime), globalTime) : globalTime;
        for (const h of chip.history)
            if (h.time > this.readTo && h.time <= now)
                this.push(epoch + h.time, h.value);
        this.readTo = now;
    }

    private push(t: number, v: number): void {
        const n = this.values.length;
        if (n > 0 && this.values[n - 1] === v) return;
        this.times.push(t);
        this.values.push(v);
        if (n > SignalRecorder.MAX_TRANSITIONS) {
            this.times.splice(0, n / 5);
            this.values.splice(0, n / 5);
        }
    }
}
