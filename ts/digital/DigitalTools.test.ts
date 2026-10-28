// Truth table / minimization / expression parsing, critical path and analyzer bus grouping,
// run against real gate elements wired with the same fake node list the other digital tests use.
import { describe, it, expect } from "vitest";
import { AndGateElm } from "../AndGateElm";
import { XorGateElm } from "../XorGateElm";
import { InverterElm } from "../InverterElm";
import { LogicInputElm } from "../LogicInputElm";
import { LogicOutputElm } from "../LogicOutputElm";
import { buildDigitalCircuit } from "./DigitalGraphBuilder";
import { connect } from "./testWiring";
import { computeTruthTable, findPorts, minimizeSOP, parseExpr, evalAst, astVars, runTestBench } from "../TruthTableDialog";
import { TimingAnalysis } from "../TimingAnalysis";
import { groupBuses, rowValueAt, toVCD } from "../LogicAnalyzer";
import { Counter193Elm } from "../Counter193Elm";
import { Counter74177Elm } from "../Counter74177Elm";
import "./chipTestHarness"; // CircuitElm.app stub so real constructors run

function elm<T extends object>(proto: { prototype: T }, x: number, y: number, fields: Record<string, any> = {}): T {
    return Object.assign(Object.create(proto.prototype), { nodes: [], flags: 0, x, y, ...fields });
}
const gate = <T extends object>(cls: { prototype: T }, x: number) =>
    elm(cls, x, 0, { inputCount: 2, propagationDelayLH: 0, propagationDelayHL: 0 });

// A, B -> XOR -> Y,  A, B -> AND -> Z
function halfAdder() {
    const a = elm(LogicInputElm, 0, 0, { position: 0 }), b = elm(LogicInputElm, 0, 10, { position: 0 });
    const x = gate(XorGateElm, 50), n = gate(AndGateElm, 60);
    const y = elm(LogicOutputElm, 100, 0), z = elm(LogicOutputElm, 100, 10);
    connect({ elm: a, num: 0 }, { elm: x, num: 0 }, { elm: n, num: 0 });
    connect({ elm: b, num: 0 }, { elm: x, num: 1 }, { elm: n, num: 1 });
    connect({ elm: x, num: 2 }, { elm: y, num: 0 });
    connect({ elm: n, num: 2 }, { elm: z, num: 0 });
    return { list: [a, b, x, n, y, z] as any[], a, b };
}

describe("truth table on a scratch copy of the circuit", () => {
    it("tabulates every input combination and leaves the inputs as they were", () => {
        const { list, a } = halfAdder();
        a.position = 1;
        const ports = findPorts(list);
        expect(ports.inputs.map(p => p.name)).toEqual(["A", "B"]);
        const t = computeTruthTable(list, ports.inputs, ports.outputs);
        expect(t.rows).toEqual([[0, 0], [1, 0], [1, 0], [0, 1]]);
        expect(a.position).toBe(1);
    });

    it("test bench reports the failing row", () => {
        const { list } = halfAdder();
        const r = runTestBench(list, findPorts(list), "# A B | Y1 Y2\n0 0 | 0 0\n1 1 | 1 x\n0 1 | 1 0\n");
        expect(r.map(x => x.ok)).toEqual([true, false, true]);
    });
});

describe("minimizeSOP", () => {
    it("matches the function it was given, for random 4-input functions", () => {
        const vars = ["A", "B", "C", "D"];
        for (let trial = 0; trial < 200; trial++) {
            const ones = Array.from({ length: 16 }, (_, m) => m).filter(() => Math.random() < 0.5);
            const e = minimizeSOP(vars, ones);
            if (e === "0" || e === "1") { expect(ones.length === 0 || ones.length === 16).toBe(true); continue; }
            const ast = parseExpr(e);
            for (let m = 0; m < 16; m++) {
                const env = new Map(vars.map((v, i) => [v, (m >> (3 - i)) & 1]));
                expect(evalAst(ast, env)).toBe(ones.includes(m) ? 1 : 0);
            }
        }
    });

    it("finds the three-term majority function", () => {
        expect(minimizeSOP(["A", "B", "C"], [3, 5, 6, 7]).split(" + ").length).toBe(3);
    });
});

describe("parseExpr", () => {
    const ev = (s: string, env: Record<string, number>) => evalAst(parseExpr(s), new Map(Object.entries(env)));
    it("handles precedence, postfix and prefix NOT, implicit AND", () => {
        expect(ev("A + B·C'", { A: 0, B: 1, C: 0 })).toBe(1);
        expect(ev("A + B·C'", { A: 0, B: 1, C: 1 })).toBe(0);
        expect(ev("~(A ^ B)", { A: 1, B: 1 })).toBe(1);
        expect(ev("A(B | C)", { A: 1, B: 0, C: 1 })).toBe(1);
        expect(ev("!A & B", { A: 0, B: 1 })).toBe(1);
        expect(astVars(parseExpr("A^B^Cin"))).toEqual(["A", "B", "Cin"]);
    });
    it("rejects garbage", () => {
        expect(() => parseExpr("A + ")).toThrow();
        expect(() => parseExpr("(A")).toThrow();
    });
});

describe("critical path", () => {
    it("follows the longest chain of gates", () => {
        const a = elm(LogicInputElm, 0, 0, { position: 0 });
        const invs = [1, 2, 3].map(i => elm(InverterElm, i * 10, 0, { inputCount: 1 }));
        const y = elm(LogicOutputElm, 100, 0);
        connect({ elm: a, num: 0 }, { elm: invs[0], num: 0 });
        connect({ elm: invs[0], num: 1 }, { elm: invs[1], num: 0 });
        connect({ elm: invs[1], num: 1 }, { elm: invs[2], num: 0 });
        connect({ elm: invs[2], num: 1 }, { elm: y, num: 0 });
        const graph = buildDigitalCircuit([a, ...invs, y]);
        const r = TimingAnalysis.criticalPath(graph);
        expect(r.elms).toEqual([a, ...invs]);
        const chips = invs.map(i => graph.chipsByElm.get(i)![0]);
        expect(r.ticks).toBe(chips.reduce((s, c) => s + Math.max(...c.delay), 0));
        expect(r.regTicks).toBeNull();
    });
});

describe("logic analyzer rows", () => {
    const rec = (name: string, times: number[], values: number[]) => ({
        name, times, values,
        valueAt(t: number) { let v: number | null = null; times.forEach((tt, i) => { if (tt <= t) v = values[i]; }); return v; },
    }) as any;

    it("groups Q0..Q2 into a Q[2:0] bus, MSB first", () => {
        const rows = groupBuses([rec("Q0", [0], [1]), rec("X", [0], [0]), rec("Q2", [0], [1]), rec("Q1", [0], [0])]);
        expect(rows.map(r => r.name)).toEqual(["Q[2:0]", "X"]);
        expect(rowValueAt(rows[0], 5)).toBe(0b101);
    });

    it("writes a VCD with one change block per transition time", () => {
        const rows = groupBuses([rec("CLK", [0, 10, 20], [0, 1, 0])]);
        const vcd = toVCD(rows, 1e-9);
        expect(vcd).toContain("$var wire 1 ! CLK $end");
        expect(vcd).toContain("#10000\n1!");
        expect(vcd).toContain("#20000\n0!");
    });
});

describe("counters built through their real constructors", () => {
    // setupPins() runs inside ChipElm's constructor; field initializers used to reset its pin indexes to 0
    it("keep the pin indexes setupPins() assigned", () => {
        const c = new Counter193Elm(0, 0);
        expect([c.cpuPost, c.mrPost, c.tcdPost]).toEqual([2 * c.bits, 2 * c.bits + 2, 2 * c.bits + 5]);
        const d = new Counter74177Elm(0, 0);
        expect(d.outputBase).toBeGreaterThan(0);
        expect(d.pins[d.clk1Post].clock).toBe(true);
    });
});
