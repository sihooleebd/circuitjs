// ShiftRegister595Elm.digitalSynthesis() against the SN74HC595 datasheet: shift-vs-latch timing,
// QH', /SRCLR, /OE, tied clocks, and the hidden registers surviving save/load and rebuilds.
import { describe, it, expect } from "vitest";
import { ShiftRegister595Elm } from "../ShiftRegister595Elm";
import { StringTokenizer } from "../StringTokenizer";
import { wireChip } from "./chipTestHarness";

// posts: 0-7 QA-QH, 8 QH', 9 SER, 10 SRCLK, 11 /SRCLR, 12 RCLK, 13 /OE
const QHS = 8, SER = 9, SRCLK = 10, SRCLR = 11, RCLK = 12, OE = 13;

function wire595(elm = new ShiftRegister595Elm(0, 0)) {
    const { set, get } = wireChip(elm, { [SRCLR]: 1 });
    const q = () => { let v = 0; for (let k = 0; k < 8; k++) v |= get(k) << k; return v; }; // QA = bit 0
    const pulse = (post: number) => { set({ [post]: 1 }); set({ [post]: 0 }); };
    // bit 7 first, so it ends up in stage H and QA..QH read back as `v`
    const shiftByte = (v: number) => {
        for (let k = 7; k >= 0; k--) { set({ [SER]: (v >> k) & 1 }); pulse(SRCLK); }
    };
    return { elm, set, get, q, pulse, shiftByte };
}

describe("ShiftRegister595Elm", () => {
    it("shifts on SRCLK, but only shows it on QA-QH after RCLK; QH' follows stage H directly", () => {
        const { get, q, pulse, shiftByte, set } = wire595();
        shiftByte(0b10110010);
        expect(q(), "storage register untouched by shifting").toBe(0);
        expect(get(QHS), "QH' = stage H = first bit shifted in").toBe(1);
        pulse(RCLK);
        expect(q()).toBe(0b10110010);

        set({ [SER]: 0 });
        pulse(SRCLK);
        expect(q(), "outputs hold until the next RCLK").toBe(0b10110010);
        expect(get(QHS), "stage G moved into H").toBe(0);
        pulse(RCLK);
        expect(q()).toBe(0b01100100);
    });

    it("/SRCLR clears only the shift register, asynchronously, and blocks shifting while low", () => {
        const { get, q, pulse, shiftByte, set } = wire595();
        shiftByte(0xFF);
        pulse(RCLK);
        set({ [SRCLR]: 0 });
        expect(get(QHS), "cleared without a clock").toBe(0);
        expect(q(), "storage register keeps its value").toBe(0xFF);

        set({ [SER]: 1 });
        pulse(SRCLK);
        set({ [SRCLR]: 1 });
        pulse(RCLK);
        expect(q(), "nothing shifted in while cleared").toBe(0);
    });

    it("/OE high takes QA-QH off the bus (0 here) without touching the registers or QH'", () => {
        const { elm, get, q, pulse, shiftByte, set } = wire595();
        shiftByte(0xA5);
        pulse(RCLK);
        set({ [OE]: 1 });
        expect(q()).toBe(0);
        expect(get(QHS), "QH' isn't tri-state").toBe(1);
        set({ [OE]: 0 });
        expect(q()).toBe(0xA5);

        expect([...Array(9).keys()].map(p => elm.isTriStateOutput(p))).toEqual([...Array(8).fill(true), false]);
    });

    it("with SRCLK and RCLK tied together, the storage register stays one clock behind", () => {
        const { q, set } = wire595();
        set({ [SER]: 1 });
        const expected = [0b0, 0b1, 0b11, 0b111];
        for (const v of expected) {
            set({ [SRCLK]: 1, [RCLK]: 1 });
            set({ [SRCLK]: 0, [RCLK]: 0 });
            expect(q()).toBe(v);
        }
    });

    // shift register 0x3C, storage register 0x5A
    function loaded595() {
        const { elm, pulse, shiftByte } = wire595();
        shiftByte(0x5A);
        pulse(RCLK);
        shiftByte(0x3C);
        return elm;
    }

    function expectRestored(what: string, elm: ShiftRegister595Elm) {
        const { q, get, pulse } = wire595(elm);
        expect(q(), `${what}: storage register`).toBe(0x5A);
        expect(get(QHS), `${what}: stage H`).toBe(0);
        pulse(RCLK);
        expect(q(), `${what}: hidden shift stages`).toBe(0x3C);
    }

    it("keeps both registers across save/load, XML and text", () => {
        const attrs = new Map<string, string>();
        loaded595().dumpXmlState(null as any, { getAttribute: (n: string) => attrs.get(n) ?? null, setAttribute: (n: string, v: string) => attrs.set(n, v) } as any);
        const fromXml = new ShiftRegister595Elm(0, 0);
        const num = (parse: (s: string) => number) => (n: string, d: number) => attrs.has(n) ? parse(attrs.get(n)!) : d;
        fromXml.undumpXml({ parseStringAttr: (n: string, d: string) => attrs.get(n) ?? d, parseIntAttr: num(parseInt), parseDoubleAttr: num(parseFloat) } as any);
        expectRestored("XML", fromXml);

        const tok = loaded595().dump().split(" ");
        expectRestored("text", new ShiftRegister595Elm(+tok[1], +tok[2], +tok[3], +tok[4], +tok[5], new StringTokenizer(tok.slice(6).join(" "))));
    });

    it("keeps both registers across a rebuild (no save in between), and clears them on reset", () => {
        const elm = loaded595();
        expectRestored("rebuild", elm);

        elm.reset();
        const { q, pulse } = wire595(elm);
        pulse(RCLK);
        expect(q(), "reset clears both registers").toBe(0);
    });
});
