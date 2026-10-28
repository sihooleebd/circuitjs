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

// Truth table, Karnaugh maps and minimized expressions for the circuit's logic inputs/outputs,
// a test bench that checks the circuit against expected vectors, and a builder that turns
// boolean expressions into gates. Everything runs on a private copy of the digital graph, so
// the live simulation is never disturbed.

import { Dialog } from "./Dialog";
import { CirSim } from "./CirSim";
import { CircuitElm } from "./CircuitElm";
import { Locale } from "./Locale";
import { labelForPost, isClockElm } from "./SignalRecorder";
import { Chip } from "./digital/chip";
import { buildDigitalCircuit, seedInitialDigitalState } from "./digital/DigitalGraphBuilder";
import type { DigitalGraph } from "./digital/DigitalGraphBuilder";

// ---------------------------------------------------------------- evaluation

// A throwaway copy of the circuit's digital graph that inputs can be forced on.
export class ScratchCircuit {
    private graph: DigitalGraph;
    private clocks = new Set<Chip>();
    private saved = new Map<any, number>();

    constructor(elmArr: any[]) {
        this.graph = buildDigitalCircuit(elmArr);
        for (const c of this.graph.circuit.chips) c.optimizationDisabled = true;
        this.graph.circuit.drainZeroDelayEvents();
        seedInitialDigitalState(elmArr, this.graph.chipsByElm);
        for (const [elm, chips] of this.graph.chipsByElm)
            if (isClockElm(elm)) chips.forEach(c => this.clocks.add(c));
    }

    // LogicInputElm reads its own `position` when its chip updates, so set that (restored by
    // restore()) and schedule the chip like LogicInputElm.toggle() does
    setInput(elm: any, high: boolean): void {
        if (!this.saved.has(elm)) this.saved.set(elm, elm.position);
        elm.position = high ? 1 : 0;
        const chip = this.graph.chipsByElm.get(elm)?.[0];
        if (chip && chip.output !== (high ? 1 : 0)) chip.pendingEvent = chip.circuit.queuePush(chip, 0);
    }

    // run until nothing is pending except clock edges; false if it never settled (oscillation)
    settle(): boolean {
        const c = this.graph.circuit;
        // ponytail: 100k event instants, raise if a huge circuit legitimately needs more
        for (let n = 0; n < 100000; n++) {
            const ev = c.peekLiveEvent();
            if (ev == null || this.clocks.has(ev.chip)) return true;
            c.stepToNextInstant();
        }
        return false;
    }

    read(elm: any, post = 0): number | null {
        const node = elm.nodes?.[post];
        const chip = node == null ? null : this.graph.triStateChipByNode.get(node);
        return chip ? chip.currentValue() : null;
    }

    restore(): void {
        for (const [elm, pos] of this.saved) elm.position = pos;
        this.saved.clear();
    }
}

export interface Port { elm: CircuitElm; name: string; }

const byPosition = (a: CircuitElm, b: CircuitElm) => (a.y - b.y) || (a.x - b.x);

// Logic inputs/outputs to tabulate: the selected ones if any are selected, else all of them.
export function findPorts(elmList: CircuitElm[]): { inputs: Port[]; outputs: Port[] } {
    const sel = elmList.filter(e => e.isSelected());
    const pick = (cls: string, prefix: string[]) => {
        let list = elmList.filter(e => e.getClassName() === cls);
        if (sel.some(e => e.getClassName() === cls)) list = list.filter(e => e.isSelected());
        return list.sort(byPosition).map((elm, i) => ({ elm, name: labelForPost(elm, 0) ?? prefix[i] ?? prefix[0] + i }));
    };
    return {
        inputs: pick("LogicInputElm", "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
        outputs: pick("LogicOutputElm", Array.from({ length: 26 }, (_, i) => "Y" + (i + 1))),
    };
}

export interface TruthTable { inputs: string[]; outputs: string[]; rows: (number | null)[][]; oscillated: boolean; }

export function computeTruthTable(elmArr: any[], inputs: Port[], outputs: Port[]): TruthTable {
    const sc = new ScratchCircuit(elmArr);
    const rows: (number | null)[][] = [];
    let oscillated = false;
    try {
        for (let m = 0; m < (1 << inputs.length); m++) {
            inputs.forEach((p, i) => sc.setInput(p.elm, ((m >> (inputs.length - 1 - i)) & 1) === 1));
            if (!sc.settle()) oscillated = true;
            rows.push(outputs.map(p => sc.read(p.elm)));
        }
    } finally {
        sc.restore();
    }
    return { inputs: inputs.map(p => p.name), outputs: outputs.map(p => p.name), rows, oscillated };
}

// ---------------------------------------------------------------- minimization

// Minimal sum of products (Quine-McCluskey prime implicants, essential ones first, then greedy).
// Variables are MSB-first: vars[0] is bit n-1 of the minterm index.
export function minimizeSOP(vars: string[], ones: number[]): string {
    const n = vars.length, full = (1 << n) - 1;
    if (ones.length === 0) return "0";
    if (ones.length === 1 << n) return "1";
    // implicant = (value, mask of don't-care bits)
    let groups = new Map<string, { v: number; m: number }>();
    for (const o of ones) groups.set(o + "/0", { v: o, m: 0 });
    const primes: { v: number; m: number }[] = [];
    while (groups.size) {
        const next = new Map<string, { v: number; m: number }>();
        const used = new Set<string>();
        const list = [...groups.entries()];
        for (let i = 0; i < list.length; i++)
            for (let j = i + 1; j < list.length; j++) {
                const [ka, a] = list[i], [kb, b] = list[j];
                const diff = a.v ^ b.v;
                if (a.m !== b.m || (diff & (diff - 1)) !== 0 || diff === 0) continue;
                const c = { v: a.v & ~diff, m: a.m | diff };
                next.set(c.v + "/" + c.m, c);
                used.add(ka); used.add(kb);
            }
        for (const [k, imp] of list) if (!used.has(k)) primes.push(imp);
        groups = next;
    }
    const covers = (p: { v: number; m: number }, o: number) => (o & ~p.m & full) === p.v;
    const chosen: { v: number; m: number }[] = [];
    let left = new Set(ones);
    for (const o of ones) {
        const ps = primes.filter(p => covers(p, o));
        if (ps.length === 1 && !chosen.includes(ps[0])) chosen.push(ps[0]);
    }
    for (const p of chosen) for (const o of ones) if (covers(p, o)) left.delete(o);
    while (left.size) {
        let best = primes[0], bestN = -1;
        for (const p of primes) {
            const k = [...left].filter(o => covers(p, o)).length;
            if (k > bestN) { best = p; bestN = k; }
        }
        chosen.push(best);
        left = new Set([...left].filter(o => !covers(best, o)));
    }
    return chosen.map(p => {
        const lits: string[] = [];
        for (let i = 0; i < n; i++) {
            const bit = 1 << (n - 1 - i);
            if (p.m & bit) continue;
            lits.push(vars[i] + (p.v & bit ? "" : "'"));
        }
        return lits.join("·");
    }).join(" + ");
}

// ---------------------------------------------------------------- expressions

export type Ast = { op: "var"; name: string } | { op: "not"; a: Ast } | { op: "and" | "or" | "xor"; args: Ast[] };

// Parses A·B' + C, A&!B | C, ~(A^B), A*B+C ... (' is postfix NOT; AND binds tighter than XOR, XOR tighter than OR).
export function parseExpr(src: string): Ast {
    const toks = src.match(/[A-Za-z_][A-Za-z0-9_]*|[()!~'&*·|+^⊕]|\S/g) ?? [];
    let i = 0;
    const peek = () => toks[i];
    const fail = (msg: string): never => { throw new Error(msg + (peek() ? " near '" + peek() + "'" : " at end")); };
    const nary = (op: "and" | "or" | "xor", ops: string[], sub: () => Ast, implicit = false): Ast => {
        const args = [sub()];
        while (ops.includes(peek()) || (implicit && peek() != null && /^[A-Za-z_(!~]/.test(peek()))) {
            if (ops.includes(peek())) i++;
            args.push(sub());
        }
        return args.length === 1 ? args[0] : { op, args };
    };
    const primary = (): Ast => {
        const t = toks[i++];
        if (t === "(") { const e = or(); if (toks[i++] !== ")") fail("expected )"); return e; }
        if (t != null && /^[A-Za-z_]/.test(t)) return { op: "var", name: t };
        i--;
        return fail("expected a variable");
    };
    const unary = (): Ast => {
        if (peek() === "!" || peek() === "~") { i++; return { op: "not", a: unary() }; }
        let e = primary();
        while (peek() === "'") { i++; e = { op: "not", a: e }; }
        return e;
    };
    const and = () => nary("and", ["&", "*", "·"], unary, true);
    const xor = () => nary("xor", ["^", "⊕"], and);
    const or = (): Ast => nary("or", ["|", "+"], xor);
    const e = or();
    if (i < toks.length) fail("unexpected");
    return e;
}

export function evalAst(e: Ast, env: Map<string, number>): number {
    switch (e.op) {
    case "var": return env.get(e.name) ?? 0;
    case "not": return 1 - evalAst(e.a, env);
    case "and": return e.args.every(a => evalAst(a, env)) ? 1 : 0;
    case "or": return e.args.some(a => evalAst(a, env)) ? 1 : 0;
    case "xor": return e.args.reduce((s, a) => s ^ evalAst(a, env), 0);
    }
}

export function astVars(e: Ast, out: string[] = []): string[] {
    if (e.op === "var") { if (!out.includes(e.name)) out.push(e.name); }
    else if (e.op === "not") astVars(e.a, out);
    else e.args.forEach(a => astVars(a, out));
    return out;
}

// ---------------------------------------------------------------- circuit builder

const G = 16;
const snap = (v: number) => Math.round(v / G) * G;

// Builds gates for "Name = expr" lines to the right of the existing circuit. Inputs are logic
// inputs feeding labeled nodes; every use of a variable is a labeled node of the same name, so
// no fan-out wiring is needed. Returns the new elements.
export function buildFromExpressions(app: CirSim, lines: string[]): CircuitElm[] {
    const outs = lines.map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(l);
        if (m == null) throw new Error("expected 'Name = expression': " + l);
        return { name: m[1], ast: parseExpr(m[2]) };
    });
    if (outs.length === 0) throw new Error("no expressions");
    const made: CircuitElm[] = [];
    const mk = (cls: string, x1: number, y1: number, x2: number, y2: number, setup?: (e: any) => void): any => {
        const e = app.constructElement(cls, x1, y1);
        setup?.(e);
        e.x2 = x2; e.y2 = y2;
        e.setPoints();
        made.push(e);
        return e;
    };
    const wire = (x1: number, y1: number, x2: number, y2: number) => { if (x1 !== x2 || y1 !== y2) mk("WireElm", x1, y1, x2, y2); };
    const label = (name: string, x: number, y: number, dx: number, dy: number) => mk("LabeledNodeElm", x, y, x + dx, y + dy, e => { e.text = name; });

    // NOT folds into NAND/NOR/XNOR; nested same-op nodes flatten into one wider gate
    const gateFor = (e: Ast): { cls: string; args: Ast[] } | null => {
        if (e.op === "var") return null;
        if (e.op === "not") {
            const a = e.a;
            if (a.op === "not") return gateFor(a.a) ?? { cls: "", args: [a.a] };
            if (a.op === "var") return { cls: "InverterElm", args: [a] };
            return { cls: { and: "NandGateElm", or: "NorGateElm", xor: "XnorGateElm" }[a.op], args: flat(a) };
        }
        return { cls: { and: "AndGateElm", or: "OrGateElm", xor: "XorGateElm" }[e.op], args: flat(e) };
    };
    const flat = (e: Ast): Ast[] => e.op === "var" || e.op === "not" ? [e] : e.args.flatMap(a => a.op === e.op ? flat(a) : [a]);
    const strip = (e: Ast): Ast => { const g = gateFor(e); return g != null && g.cls === "" ? strip(g.args[0]) : e; };
    const isVar = (e: Ast) => strip(e).op === "var";
    const varName = (e: Ast) => (strip(e) as { name: string }).name;
    const GL = 64; // gate length
    // children that are gates (variables are just labels on the gate's own pins)
    const subGates = (e: Ast) => gateFor(strip(e))?.args.filter(a => !isVar(a)) ?? [];
    const height = (e: Ast): number => {
        const g = gateFor(strip(e));
        if (g == null) return 2 * G;
        return Math.max(subGates(e).reduce((s, a) => s + height(a), 0), (g.args.length + 2) * G); // + room for the gate body
    };
    const width = (e: Ast): number => {
        const subs = subGates(e);
        if (gateFor(strip(e)) == null) return 3 * G;
        return GL + 3 * G + (subs.length ? G * subs.length + Math.max(...subs.map(width)) : 0);
    };
    // place subtree with its output at x = right, inside the band starting at y = top; returns output point
    const place = (e0: Ast, right: number, top: number): { x: number; y: number } => {
        const e = strip(e0), g = gateFor(e);
        const y = snap(top + height(e) / 2);
        if (g == null) {
            label(varName(e), right, y, -2 * G, 0);
            return { x: right, y };
        }
        const k = g.args.length, subs = subGates(e);
        const gate = mk(g.cls, right - GL, y, right, y, el => { if (g.cls !== "InverterElm") { el.inputCount = k; el.allocNodes(); } });
        const inX = Math.min(...g.args.map((_, i) => gate.getPost(i).x));
        let childTop = top + (height(e) - subs.reduce((s, a) => s + height(a), 0)) / 2;
        g.args.forEach((a, i) => {
            const pin = gate.getPost(i);
            if (isVar(a)) { label(varName(a), pin.x, pin.y, -2 * G, 0); return; }
            const j = subs.indexOf(a);
            const out = place(a, inX - 2 * G - G * (subs.length + 1), snap(childTop));
            childTop += height(a);
            // jogs sit left of the pin labels, one column per routed child
            const jog = inX - 2 * G - G * (j + 1);
            wire(out.x, out.y, jog, out.y);
            wire(jog, out.y, jog, pin.y);
            wire(jog, pin.y, pin.x, pin.y);
        });
        const o = gate.getPost(k);
        return { x: o.x, y: o.y };
    };

    const bounds = app.getCircuitBounds();
    const ox = snap(bounds ? bounds.x + bounds.width + 6 * G : 0);
    let oy = snap(bounds ? bounds.y : 0);
    const vars = [...new Set(outs.flatMap(o => astVars(o.ast)))];
    vars.forEach((v, i) => {
        const y = oy + i * 3 * G;
        mk("LogicInputElm", ox, y, ox - 2 * G, y);
        wire(ox, y, ox + 3 * G, y);
        label(v, ox + 3 * G, y, 2 * G, 0);
    });
    const treeRight = ox + 10 * G + Math.max(...outs.map(o => width(o.ast)));
    for (const o of outs) {
        const out = place(o.ast, treeRight, oy);
        const lx = snap(out.x + 3 * G);
        wire(out.x, out.y, lx, out.y);
        label(o.name, lx, out.y, 0, -2 * G);
        wire(lx, out.y, lx + 2 * G, out.y);
        mk("LogicOutputElm", lx + 2 * G, out.y, lx + 4 * G, out.y);
        oy += Math.max(height(o.ast), 3 * G) + 2 * G;
    }
    return made;
}

// ---------------------------------------------------------------- test bench

export interface TestResult { line: number; ok: boolean; text: string; }

// Vectors: a header "A B C | Y Z" then rows "0 1 1 | 1 x" (x = don't care). Rows are applied in
// order on one scratch circuit, so state carries over and a logic input can act as a clock.
export function runTestBench(elmArr: any[], ports: { inputs: Port[]; outputs: Port[] }, text: string): TestResult[] {
    const lines = text.split("\n");
    const hi = lines.findIndex(l => l.includes("|"));
    if (hi < 0) throw new Error("expected a header line like 'A B | Y'");
    const [inNames, outNames] = lines[hi].replace(/^#/, "").split("|").map(s => s.trim().split(/\s+/).filter(Boolean));
    const find = (list: Port[], name: string) => list.find(p => p.name === name) ?? (() => { throw new Error("no logic input/output named " + name); })();
    const ins = inNames.map(n => find(ports.inputs, n)), outs = outNames.map(n => find(ports.outputs, n));
    const sc = new ScratchCircuit(elmArr);
    const results: TestResult[] = [];
    try {
        for (let li = hi + 1; li < lines.length; li++) {
            const l = lines[li].trim();
            if (!l || l.startsWith("#")) continue;
            const [a, b] = l.split("|").map(s => s.trim().split(/\s+/).filter(Boolean));
            if (a?.length !== ins.length || b?.length !== outs.length) throw new Error("line " + (li + 1) + ": wrong number of values");
            ins.forEach((p, i) => sc.setInput(p.elm, a[i] === "1"));
            sc.settle();
            const got = outs.map(p => sc.read(p.elm));
            const ok = got.every((v, i) => b[i].toLowerCase() === "x" || String(v) === b[i]);
            results.push({ line: li + 1, ok, text: a.join(" ") + " | expected " + b.join(" ") + ", got " + got.map(v => v ?? "Z").join(" ") });
        }
    } finally {
        sc.restore();
    }
    return results;
}

// ---------------------------------------------------------------- dialog

export class TruthTableDialog extends Dialog {
    private app: CirSim;

    constructor(app: CirSim) {
        super();
        this.app = app;
        this.closeOnEnter = false;
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", parent: HTMLElement = this.dialogEl) => {
            const e = document.createElement(tag);
            e.textContent = text;
            parent.appendChild(e);
            return e;
        };
        el("h3", Locale.LS("Truth Table")).style.margin = "0 0 6px 0";
        this.dialogEl.style.maxWidth = "760px";

        app.sim.ensureDigitalGraph();
        const ports = findPorts(app.elmList);
        const MAX_IN = 10;
        let table: TruthTable | null = null;
        if (ports.inputs.length === 0 || ports.outputs.length === 0)
            el("div", Locale.LS("Add Logic Inputs and Logic Outputs (or select some) to get a truth table."));
        else if (ports.inputs.length > MAX_IN)
            el("div", Locale.LS("Too many inputs") + " (" + ports.inputs.length + " > " + MAX_IN + "). " + Locale.LS("Select the ones you want."));
        else {
            table = computeTruthTable(app.sim.elmArr, ports.inputs, ports.outputs);
            if (app.elmList.some(isClockElm) || table.oscillated)
                el("div", Locale.LS("Note: values are settled without advancing clocks; sequential parts keep their current state.")).style.color = "#a60";
            const wrap = el("div");
            wrap.style.maxHeight = "260px";
            wrap.style.overflow = "auto";
            const t = el("table", "", wrap);
            t.style.borderCollapse = "collapse";
            t.style.fontFamily = "monospace";
            const tr = el("tr", "", t);
            [...table.inputs, "│", ...table.outputs].forEach(h => { const th = el("th", h, tr); th.style.padding = "0 6px"; });
            table.rows.forEach((r, m) => {
                const row = el("tr", "", t);
                table!.inputs.forEach((_, i) => el("td", String((m >> (table!.inputs.length - 1 - i)) & 1), row).style.textAlign = "center");
                el("td", "│", row);
                r.forEach(v => el("td", v == null ? "Z" : String(v), row).style.textAlign = "center");
            });

            // K-maps (2-4 inputs) and minimized expressions (up to 8)
            const exprs: string[] = [];
            const maps = el("div");
            maps.style.display = "flex";
            maps.style.flexWrap = "wrap";
            maps.style.gap = "12px";
            maps.style.marginTop = "8px";
            table.outputs.forEach((name, oi) => {
                const ones = table!.rows.map((r, m) => r[oi] === 1 ? m : -1).filter(m => m >= 0);
                if (table!.inputs.length <= 8) exprs.push(name + " = " + minimizeSOP(table!.inputs, ones));
                if (table!.inputs.length >= 2 && table!.inputs.length <= 4) maps.appendChild(this.kmap(name, table!, oi));
            });
            const ex = el("pre", exprs.join("\n"));
            ex.style.margin = "8px 0";
            this.exprBoxDefault = exprs.join("\n");
        }

        el("h4", Locale.LS("Test Bench")).style.margin = "10px 0 4px 0";
        el("div", Locale.LS("One row per step: input values | expected outputs (x = don't care). Rows run in order, so a logic input can be used as a clock."));
        const tb = el("textarea") as HTMLTextAreaElement;
        tb.style.width = "100%"; tb.style.height = "110px"; tb.style.fontFamily = "monospace";
        if (table) tb.value = "# " + table.inputs.join(" ") + " | " + table.outputs.join(" ") + "\n" +
            table.rows.map((r, m) => table!.inputs.map((_, i) => (m >> (table!.inputs.length - 1 - i)) & 1).join(" ") + " | " + r.map(v => v ?? "x").join(" ")).join("\n");
        const res = el("pre");
        res.style.maxHeight = "120px"; res.style.overflow = "auto"; res.style.margin = "4px 0";
        const runBtn = el("button", Locale.LS("Run Test")) as HTMLButtonElement;
        runBtn.onclick = () => {
            try {
                const r = runTestBench(app.sim.elmArr, ports, tb.value);
                const failed = r.filter(x => !x.ok);
                res.textContent = (failed.length ? "FAIL: " : "PASS: ") + (r.length - failed.length) + "/" + r.length + " " + Locale.LS("rows passed") + "\n"
                    + failed.map(x => "line " + x.line + ": " + x.text).join("\n");
                res.style.color = failed.length ? "#c00" : "#080";
            } catch (e: any) { res.textContent = e.message; res.style.color = "#c00"; }
        };

        el("h4", Locale.LS("Build Circuit from Expressions")).style.margin = "10px 0 4px 0";
        el("div", Locale.LS("One output per line, e.g.  Y = A·B' + C   or   S = A ^ B ^ Cin   (' ! ~ = NOT, · & * = AND, ^ = XOR, + | = OR)."));
        const eb = el("textarea") as HTMLTextAreaElement;
        eb.style.width = "100%"; eb.style.height = "70px"; eb.style.fontFamily = "monospace";
        eb.value = this.exprBoxDefault || "Y = A·B' + C";
        const msg = el("div");
        const buildBtn = el("button", Locale.LS("Build")) as HTMLButtonElement;
        buildBtn.onclick = () => {
            try {
                app.undoManager?.pushUndo();
                const made = buildFromExpressions(app, eb.value.split("\n"));
                for (const e of app.elmList) e.setSelected(false);
                for (const e of made) { app.elmList.push(e); e.setSelected(true); }
                app.needAnalyze();
                this.closeDialog();
            } catch (e: any) { msg.textContent = e.message; msg.style.color = "#c00"; }
        };
        const close = el("button", Locale.LS("Close")) as HTMLButtonElement;
        close.style.marginLeft = "8px";
        close.onclick = () => this.closeDialog();
    }

    private exprBoxDefault = "";

    // Karnaugh map, rows/columns in Gray code; first half of the variables on rows
    private kmap(name: string, t: TruthTable, oi: number): HTMLElement {
        const n = t.inputs.length, rb = n >> 1, cb = n - rb;
        const gray = (b: number) => Array.from({ length: 1 << b }, (_, i) => i ^ (i >> 1));
        const bits = (v: number, b: number) => v.toString(2).padStart(b, "0");
        const tbl = document.createElement("table");
        tbl.style.borderCollapse = "collapse";
        tbl.style.fontFamily = "monospace";
        const cell = (row: HTMLElement, s: string, border = false) => {
            const td = document.createElement("td");
            td.textContent = s;
            td.style.padding = "2px 6px";
            td.style.textAlign = "center";
            if (border) td.style.border = "1px solid #888";
            row.appendChild(td);
            return td;
        };
        const head = document.createElement("tr");
        cell(head, name + ": " + t.inputs.slice(0, rb).join("") + "\\" + t.inputs.slice(rb).join(""));
        gray(cb).forEach(c => cell(head, bits(c, cb)));
        tbl.appendChild(head);
        for (const r of gray(rb)) {
            const tr = document.createElement("tr");
            cell(tr, bits(r, rb));
            for (const c of gray(cb)) {
                const v = t.rows[(r << cb) | c][oi];
                const td = cell(tr, v == null ? "Z" : String(v), true);
                if (v === 1) td.style.background = "#cfc";
            }
            tbl.appendChild(tr);
        }
        return tbl;
    }
}
