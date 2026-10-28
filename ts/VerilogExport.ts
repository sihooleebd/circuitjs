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

// Structural Verilog netlist of the digital circuit: gates as primitives (with their LH/HL
// delays), D/JK/T flip-flops as small behavioral modules, every other chip as an empty
// black-box module with the right ports.

import { labelForPost, isClockElm } from "./SignalRecorder";
import type { DigitalGraph } from "./digital/DigitalGraphBuilder";

const PRIMITIVES: Record<string, string> = {
    AndGateElm: "and", NandGateElm: "nand", OrGateElm: "or", NorGateElm: "nor",
    XorGateElm: "xor", XnorGateElm: "xnor", InverterElm: "not", DelayBufferElm: "buf",
};
const ident = (s: string) => /^[A-Za-z_]/.test(s) ? s.replace(/\W/g, "_") : "_" + s.replace(/\W/g, "_");

interface PortInfo { name: string; out: boolean; clock: boolean; inv: boolean; base: string; }

function chipPorts(pins: any[]): PortInfo[] {
    const used = new Set<string>();
    return pins.map((p, i) => {
        const base = ident(p.text || (p.clock ? "CLK" : "P" + i));
        const inv = !!(p.lineOver || p.bubble);
        let name = base + (inv ? "_n" : "");
        while (used.has(name)) name += "_" + i;
        used.add(name);
        return { name, out: !!p.output, clock: !!p.clock, inv, base: base.toUpperCase() };
    });
}

// behavioral body for the flip-flops; null for anything else (left as a black box)
function flipFlopBody(cls: string, ports: PortInfo[]): string | null {
    const next: Record<string, string> = {
        DFlipFlopElm: "q <= D;",
        TFlipFlopElm: "if (T) q <= ~q;",
        JKFlipFlopElm: "case ({J, K}) 2'b01: q <= 1'b0; 2'b10: q <= 1'b1; 2'b11: q <= ~q; default: ; endcase",
    };
    const clk = ports.find(p => p.clock);
    if (!(cls in next) || clk == null) return null;
    const edge = (p: PortInfo) => (p.inv ? "negedge " : "posedge ") + p.name;
    const active = (p: PortInfo) => (p.inv ? "!" : "") + p.name;
    const r = ports.find(p => !p.out && p.base === "R"), s = ports.find(p => !p.out && p.base === "S");
    const sens = [clk, r, s].filter((p): p is PortInfo => p != null).map(edge).join(" or ");
    let body = "    reg q;\n";
    for (const p of ports.filter(p => p.out)) body += "    assign " + p.name + " = " + (p.inv ? "~q" : "q") + ";\n";
    body += "    always @(" + sens + ")\n        ";
    if (r) body += "if (" + active(r) + ") q <= 1'b0;\n        else ";
    if (s) body += "if (" + active(s) + ") q <= 1'b1;\n        else ";
    return body + next[cls] + "\n";
}

export function toVerilog(elmArr: any[], graph: DigitalGraph, moduleName = "circuit"): string {
    const netName = new Map<any, string>();
    const taken = new Set<string>();
    const name = (elm: any, post: number, fallback: string): string => {
        const node = elm.nodes?.[post];
        if (node == null) return "1'bz";
        let n = netName.get(node);
        if (n == null) {
            const label = labelForPost(elm, post);
            n = ident(label ?? fallback + (node.index ?? netName.size));
            while (taken.has(n)) n += "_";
            taken.add(n);
            netName.set(node, n);
        }
        return n;
    };
    const kind = (cls: string) => cls.replace(/Elm$/, "");

    const inputs: string[] = [], outputs: string[] = [], body: string[] = [], modules = new Map<string, string>();
    for (const elm of elmArr) {
        if (elm.getClassName() === "LogicInputElm" || isClockElm(elm)) inputs.push(name(elm, 0, isClockElm(elm) ? "clk" : "in"));
        if (elm.getClassName() === "LogicOutputElm") outputs.push(name(elm, 0, "out"));
    }
    let inst = 0;
    for (const elm of elmArr) {
        const cls: string = elm.getClassName();
        const chip = graph.chipsByElm.get(elm)?.[0];
        if (cls === "LogicInputElm" || isClockElm(elm) || cls === "LogicOutputElm") continue;
        if (chip != null && (chip === graph.circuit.chips[0] || chip === graph.circuit.chips[1]) && elm.getPostCount() === 1) {
            body.push("    assign " + name(elm, 0, "n") + " = 1'b" + (chip === graph.circuit.chips[0] ? 1 : 0) + ";");
            continue;
        }
        const prim = PRIMITIVES[cls];
        if (prim != null) {
            const n = elm.getPostCount() - 1;
            const ins = Array.from({ length: n }, (_, i) => name(elm, i, "n"));
            const delay = elm.propagationDelayLH != null
                ? " #(" + +(elm.propagationDelayLH * 1e9).toFixed(3) + ", " + +(elm.propagationDelayHL * 1e9).toFixed(3) + ")" : "";
            body.push("    " + prim + delay + " g" + (++inst) + " (" + [name(elm, n, "n"), ...ins].join(", ") + ");");
            continue;
        }
        if (cls === "TriStateElm") {
            const bw = elm.busWidth ?? 1;
            for (let i = 0; i < bw; i++)
                body.push("    bufif1 g" + (++inst) + " (" + name(elm, bw + i, "n") + ", " + name(elm, i, "n") + ", " + name(elm, 2 * bw, "n") + "); // enable assumed active-high");
            continue;
        }
        if (Array.isArray(elm.pins) && elm.pins.length > 0 && graph.chipsByElm.has(elm)) {
            const ports = chipPorts(elm.pins);
            const mod = kind(cls) + "_" + ports.length;
            if (!modules.has(mod)) {
                const decl = ports.map(p => (p.out ? "output " : "input ") + p.name).join(", ");
                modules.set(mod, "module " + mod + "(" + decl + ");\n" +
                    (flipFlopBody(cls, ports) ?? "    // " + cls + ": behavior not exported (black box)\n") + "endmodule\n");
            }
            body.push("    " + mod + " u" + (++inst) + " (" + ports.map((p, i) => "." + p.name + "(" + name(elm, i, "n") + ")").join(", ") + ");");
        }
    }
    const ports = new Set([...inputs, ...outputs]);
    const wires = [...netName.values()].filter(n => !ports.has(n));
    return "// Exported from CircuitJS1\n`timescale 1ns / 1ps\n\n" +
        "module " + moduleName + "(" + [...inputs.map(n => "input " + n), ...outputs.map(n => "output " + n)].join(", ") + ");\n" +
        (wires.length ? "    wire " + wires.join(", ") + ";\n" : "") + body.join("\n") + "\nendmodule\n\n" +
        [...modules.values()].join("\n");
}
