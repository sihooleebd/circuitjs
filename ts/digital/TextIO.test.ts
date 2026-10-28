// NumberInputElm, KeyboardElm and TerminalElm against the digital engine, via the same harness as
// the 74xx chip tests.
import { describe, it, expect } from "vitest";
import { NumberInputElm } from "../NumberInputElm";
import { KeyboardElm } from "../KeyboardElm";
import { TerminalElm } from "../TerminalElm";
import { wireChip } from "./chipTestHarness";

const byte = (get: (post: number) => number) => Array.from({ length: 8 }, (_, k) => get(k) << k).reduce((a, b) => a + b);

describe("NumberInputElm", () => {
    it("drives its value onto D0-Dn, LSB first", () => {
        const elm = new NumberInputElm(0, 0);
        elm.value = 0xA5;
        const { get } = wireChip(elm);
        expect(byte(get)).toBe(0xA5);
    });
});

describe("KeyboardElm", () => {
    // posts: 0-7 D0-D7, 8 AV, 9 CLK
    it("reads out one UTF-8 byte per CLK rising edge, then drops AV", () => {
        const kb = new KeyboardElm(0, 0);
        kb.setText("Hi한");
        const { set, get } = wireChip(kb);
        const read: number[] = [];
        while (get(8)) {
            read.push(byte(get));
            set({ 9: 1 });
            set({ 9: 0 });
        }
        expect(read).toEqual([...new TextEncoder().encode("Hi한")]);
        expect(byte(get)).toBe(0);
    });

    it("doesn't skip a byte when rebuilt with CLK already high", () => {
        const kb = new KeyboardElm(0, 0);
        kb.setText("AB");
        const { get } = wireChip(kb, { 9: 1 });
        expect(byte(get)).toBe(65);
    });

    it("picks up live typing without a rebuild", () => {
        const kb = new KeyboardElm(0, 0);
        const { graph, get } = wireChip(kb);
        expect(get(8)).toBe(0);
        kb.typeKey({ key: "x" } as KeyboardEvent);
        graph.circuit.run(20);
        expect([byte(get), get(8)]).toEqual([120, 1]);
    });
});

describe("TerminalElm", () => {
    // posts: 0-7 D0-D7, 8 CLK
    const send = (set: (v: Record<number, number>) => void, b: number) => {
        const d: Record<number, number> = {};
        for (let k = 0; k < 8; k++) d[k] = (b >> k) & 1;
        set(d);
        set({ 8: 1 });
        set({ 8: 0 });
    };

    it("prints UTF-8 bytes on CLK rising edges, with backspace and form feed", () => {
        const term = new TerminalElm(0, 0);
        const { set } = wireChip(term);
        for (const b of new TextEncoder().encode("Hey한")) send(set, b);
        send(set, 8);
        send(set, 10);
        send(set, "!".charCodeAt(0));
        expect(term.text).toBe("Hey\n!");
        send(set, 12);
        expect(term.text).toBe("");
    });

    it("doesn't print when rebuilt with CLK already high", () => {
        const term = new TerminalElm(0, 0);
        wireChip(term, { 0: 1, 6: 1, 8: 1 }); // 'A' on D, CLK high
        expect(term.text).toBe("");
    });
});
