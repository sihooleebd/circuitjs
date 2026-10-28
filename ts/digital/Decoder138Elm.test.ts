// Decoder138Elm.digitalSynthesis() against the SN74LS138 function table: every select code while
// enabled, and each of the three enables disabling it on its own.
import { describe, it, expect } from "vitest";
import { Decoder138Elm } from "../Decoder138Elm";
import { wireChip } from "./chipTestHarness";

// posts: 0-7 /Y0-/Y7, 8 A, 9 B, 10 C, 11 G1, 12 /G2A, 13 /G2B
const outputs = (get: (post: number) => number) => Array.from({ length: 8 }, (_, i) => get(i));

describe("Decoder138Elm", () => {
    it("pulls exactly the selected output low while enabled", () => {
        const { set, get } = wireChip(new Decoder138Elm(0, 0), { 11: 1 });
        for (let n = 0; n < 8; n++) {
            set({ 8: n & 1, 9: (n >> 1) & 1, 10: (n >> 2) & 1 });
            expect(outputs(get), `C:B:A = ${n}`).toEqual(Array.from({ length: 8 }, (_, i) => i === n ? 0 : 1));
        }
    });

    it("holds every output high unless G1 is high and /G2A, /G2B are both low", () => {
        const { set, get } = wireChip(new Decoder138Elm(0, 0), { 8: 1, 10: 1, 11: 1 }); // selects /Y5
        expect(get(5)).toBe(0);
        const disables: [string, Record<number, number>][] = [["G1 low", { 11: 0 }], ["/G2A high", { 12: 1 }], ["/G2B high", { 13: 1 }]];
        for (const [what, change] of disables) {
            set(change);
            expect(outputs(get), what).toEqual(Array(8).fill(1));
            set({ 11: 1, 12: 0, 13: 0 });
            expect(get(5), `re-enabled after ${what}`).toBe(0);
        }
    });
});
