// Encoder148Elm.digitalSynthesis() against the SN74LS148 function table (every pin active low):
// /EI disabling, the no-input row, and priority (higher inputs win over every lower one).
import { describe, it, expect } from "vitest";
import { Encoder148Elm } from "../Encoder148Elm";
import { wireChip } from "./chipTestHarness";

// posts: 0-7 /I0-/I7, 8 /EI, 9-11 /A0-/A2, 12 /GS, 13 /EO
const read = (get: (post: number) => number) => ({ a: get(9) | (get(10) << 1) | (get(11) << 2), gs: get(12), eo: get(13) });
const inputs = (low: (i: number) => boolean) => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, low(i) ? 0 : 1]));

describe("Encoder148Elm", () => {
    it("/EI high forces every output high, even with inputs active", () => {
        const { get } = wireChip(new Encoder148Elm(0, 0), { ...inputs(() => true), 8: 1 });
        expect(read(get)).toEqual({ a: 7, gs: 1, eo: 1 });
    });

    it("with no input low: /A2-/A0 and /GS high, /EO low", () => {
        const { get } = wireChip(new Encoder148Elm(0, 0), inputs(() => false));
        expect(read(get)).toEqual({ a: 7, gs: 1, eo: 0 });
    });

    it("puts the highest-numbered low input on /A2-/A0 (inverted), ignoring every lower one", () => {
        const { set, get } = wireChip(new Encoder148Elm(0, 0), inputs(() => false));
        for (let n = 0; n < 8; n++) {
            set(inputs(i => i <= n));
            expect(read(get), `/I0-/I${n} low`).toEqual({ a: ~n & 7, gs: 0, eo: 1 });
        }
        set(inputs(i => i === 3));
        expect(read(get), "/I3 alone").toEqual({ a: 4, gs: 0, eo: 1 });
    });
});
