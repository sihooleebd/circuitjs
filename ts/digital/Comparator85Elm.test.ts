// Comparator85Elm.digitalSynthesis() against the SN74LS85 function table: every A,B pair, then
// every cascade-input row for A = B, and the cascade inputs being ignored once A and B differ.
import { describe, it, expect } from "vitest";
import { Comparator85Elm } from "../Comparator85Elm";
import { wireChip } from "./chipTestHarness";

// posts: 0-3 A0-A3, 4-7 B0-B3, 8-10 cascade in (A<B, A=B, A>B), 11-13 out (A<B, A=B, A>B)
const nibble = (first: number, v: number) => Object.fromEntries([0, 1, 2, 3].map(i => [first + i, (v >> i) & 1]));
const read = (get: (post: number) => number) => [get(11), get(12), get(13)];

describe("Comparator85Elm", () => {
    it("compares every A,B pair (A=B cascade input high, as for a lone chip)", () => {
        const { set, get } = wireChip(new Comparator85Elm(0, 0), { 9: 1 });
        for (let a = 0; a < 16; a++)
            for (let b = 0; b < 16; b++) {
                set({ ...nibble(0, a), ...nibble(4, b) });
                expect(read(get), `${a} vs ${b}`).toEqual([+(a < b), +(a === b), +(a > b)]);
            }
    });

    it("decides A = B from the cascade inputs, and ignores them once A and B differ", () => {
        const { set, get } = wireChip(new Comparator85Elm(0, 0), { ...nibble(0, 9), ...nibble(4, 9) });
        // cascade in [A<B, A=B, A>B] -> out [A<B, A=B, A>B]
        const table: [number[], number[]][] = [
            [[0, 0, 1], [0, 0, 1]],
            [[1, 0, 0], [1, 0, 0]],
            [[0, 1, 0], [0, 1, 0]], [[1, 1, 0], [0, 1, 0]], [[0, 1, 1], [0, 1, 0]], [[1, 1, 1], [0, 1, 0]],
            [[1, 0, 1], [0, 0, 0]],
            [[0, 0, 0], [1, 0, 1]],
        ];
        for (const [[lt, eq, gt], expected] of table) {
            set({ 8: lt, 9: eq, 10: gt });
            expect(read(get), `cascade in ${lt}${eq}${gt}`).toEqual(expected);
        }
        set({ 8: 1, 9: 0, 10: 0, ...nibble(0, 10) });
        expect(read(get), "A=10 > B=9 despite A<B in").toEqual([0, 0, 1]);
    });
});
