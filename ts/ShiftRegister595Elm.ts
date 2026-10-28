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

import { ChipElm, Pin } from "./ChipElm";
import { StringTokenizer } from "./StringTokenizer";
import { CircuitXMLSerializer } from "./CircuitXMLSerializer";
import { CircuitXMLDeserializer } from "./CircuitXMLDeserializer";
import { parseIntStrict } from "./NumberParse";
import { chipStart, POS_EDGE_PIN as posEdge, i1, i8 } from "./digital/chip_desc";
import type { ChipDesc, ChipLogic } from "./digital/chip_desc";
import type { Chip } from "./digital/chip";
import { getCurrentDigitalGraph } from "./digital/DigitalGraphBuilder";
import type { DigitalInitialState, DigitalSynthesis, DigitalTriStateDriver } from "./digital/DigitalGraphBuilder";

// Post layout: 0-7 QA-QH, 8 QH', 9 SER, 10 SRCLK, 11 /SRCLR, 12 RCLK, 13 /OE - module constants
// for the same reason as Decoder138Elm's (a field set in setupPins() gets reset by its own
// initializer).
const QH_SERIAL = 8, SER = 9, SRCLK = 10, SRCLR = 11, RCLK = 12, OE = 13, POSTS = 14;

/** Pin number of shift-register stage k (0 = A, nearest SER): stage H is QH' itself, the rest
 * are internal. Storage-register stage k is always internal, at i8 + k. */
const stagePin = (k: number) => k === 7 ? QH_SERIAL + 1 : i1 + k;
const storePin = (k: number) => i8 + k;

/** Models a real SN74HC595 "8-Bit Shift Register With 3-State Output Registers": SRCLK's rising
 * edge shifts SER into stage A and every stage one place toward H (QH' always shows stage H, for
 * daisy-chaining); /SRCLR low asynchronously clears the shift register only; RCLK's rising edge
 * copies the shift register into the storage register, which drives QA-QH whenever /OE is low.
 * QA-QH are tri-state outputs (see isTriStateOutput()), so /OE high reads as 0 here - the engine
 * has no high-Z value - and several 595s (or TriStateElms) can share a bus.
 *
 * Both registers are hidden state that no output post fully exposes, so unlike Counter193Elm
 * (whose Q posts ARE its state, kept fresh by syncDigitalToNodesNew()) they're read back from
 * the live chips (captureState()) whenever they're needed: on save, and across a rebuild. */
export class ShiftRegister595Elm extends ChipElm implements DigitalInitialState, DigitalTriStateDriver {
    // bit k = stage k (QA/stage A = bit 0); only current as of the last captureState()
    shiftReg: number = 0;
    storeReg: number = 0;
    // this element's chips from the most recent digital build (see digitalInitialState())
    private liveChips: Chip[] | null = null;

    constructor(xx: number, yy: number);
    constructor(xa: number, ya: number, xb: number, yb: number, f: number, st: StringTokenizer);
    constructor(xa: number, ya: number, xb?: number, yb?: number, f?: number, st?: StringTokenizer) {
        super(xa, ya, xb, yb, f, st);
        if (st !== undefined && st.hasMoreTokens()) {
            this.shiftReg = parseIntStrict(st.nextToken());
            this.storeReg = parseIntStrict(st.nextToken());
        }
    }

    getChipName(): string { return "Shift Register w/ Output Latch (74595)"; }

    setupPins(): void {
        this.sizeX = 2;
        this.sizeY = 9;
        this.pins = new Array(POSTS);
        for (let k = 0; k < 8; k++) {
            this.pins[k] = new Pin(this, k, ChipElm.SIDE_E, "Q" + "ABCDEFGH"[k]);
            this.pins[k].output = true;
        }
        this.pins[QH_SERIAL] = new Pin(this, 8, ChipElm.SIDE_E, "QH'");
        this.pins[QH_SERIAL].output = true;
        this.pins[SER] = new Pin(this, 0, ChipElm.SIDE_W, "SER");
        this.pins[SRCLK] = new Pin(this, 2, ChipElm.SIDE_W, "SRCLK");
        this.pins[SRCLK].clock = true;
        this.pins[SRCLR] = new Pin(this, 3, ChipElm.SIDE_W, "SRCLR");
        this.pins[SRCLR].bubble = true;
        this.pins[RCLK] = new Pin(this, 5, ChipElm.SIDE_W, "RCLK");
        this.pins[RCLK].clock = true;
        this.pins[OE] = new Pin(this, 7, ChipElm.SIDE_W, "OE");
        this.pins[OE].bubble = true;
        this.allocNodes();
    }

    getPostCount(): number { return POSTS; }
    getVoltageSourceCount(): number { return 9; }

    /** Three cells per bit, in this order (captureState() relies on it): shift stage k, storage
     * stage k, then the QA-QH driver AND(/OE low, storage k) - same tri-state shape as
     * TriStateElm.digitalSynthesis(). Each edge-triggered cell reads its source's PRE-edge value
     * (the source's own update lands at least a tick later), so the chain moves exactly one place
     * per SRCLK edge, and tying SRCLK to RCLK leaves the storage register one clock behind the
     * shift register - both as the datasheet describes. */
    digitalSynthesis(): DigitalSynthesis {
        const pinMap = new Map<number, number>();
        for (let i = 0; i < POSTS; i++) pinMap.set(i, i + 1);

        const ser = SER + 1, srclk = SRCLK + 1, srclr = SRCLR + 1, rclk = RCLK + 1, oe = OE + 1;
        const desc: ChipDesc[] = [];
        for (let k = 0; k < 8; k++) {
            const out = stagePin(k), src = k === 0 ? ser : stagePin(k - 1);
            const logic: ChipLogic = (pin, prevPin, eventPin) => {
                if (!pin[srclr]) pin[out] = 0;
                else pin[out] = posEdge(pin, eventPin, srclk) ? pin[src] : prevPin[out];
            };
            // HC595 datasheet SRCLK-to-QH' delay (4.5V)
            desc.push(chipStart(logic).inputPins(srclr, srclk, src).eventPins(srclk)
                .outputPin(out).prevOutputPin(out).outputDelayNs(20.0, 20.0));
        }
        for (let k = 0; k < 8; k++) {
            const out = storePin(k), src = stagePin(k);
            const logic: ChipLogic = (pin, prevPin, eventPin) => {
                pin[out] = posEdge(pin, eventPin, rclk) ? pin[src] : prevPin[out];
            };
            desc.push(chipStart(logic).inputPins(rclk, src).eventPins(rclk)
                .outputPin(out).prevOutputPin(out).outputDelayNs(10.0, 10.0));
        }
        for (let k = 0; k < 8; k++) {
            const out = k + 1, src = storePin(k);
            const logic: ChipLogic = (pin) => { pin[out] = pin[oe] ? 0 : pin[src]; };
            // storage cell + this one ~ the datasheet's RCLK-to-Q and /OE-to-Q delays (4.5V)
            desc.push(chipStart(logic).inputPins(oe, src).outputPin(out).outputDelayNs(15.0, 15.0));
        }
        return { desc, pinMap };
    }

    isTriStateOutput(postIndex: number): boolean { return postIndex < 8; }

    /** Seeds both registers from shiftReg/storeReg - after first refreshing them from the
     * previous build's chips, if any, so an edit mid-simulation doesn't lose the hidden stages.
     * Runs once per build, after setCurrentDigitalGraph() (see SimulationManager.
     * initDigitalCircuit()), which is how this picks up its new chips for next time. */
    digitalInitialState(): { pin: number, value: number }[] | null {
        this.captureState();
        this.liveChips = getCurrentDigitalGraph()?.chipsByElm.get(this) ?? null;
        const entries: { pin: number, value: number }[] = [];
        for (let k = 0; k < 8; k++) {
            entries.push({ pin: stagePin(k), value: (this.shiftReg >> k) & 1 });
            entries.push({ pin: storePin(k), value: (this.storeReg >> k) & 1 });
        }
        return entries;
    }

    private captureState(): void {
        const chips = this.liveChips;
        if (chips == null || chips.length < 16) return;
        this.shiftReg = this.storeReg = 0;
        for (let k = 0; k < 8; k++) {
            this.shiftReg |= chips[k].currentValue() << k;
            this.storeReg |= chips[8 + k].currentValue() << k;
        }
    }

    reset(): void {
        super.reset();
        this.shiftReg = this.storeReg = 0;
        this.liveChips = null;
    }

    dump(): string {
        this.captureState();
        return super.dump() + " " + this.shiftReg + " " + this.storeReg;
    }

    dumpXmlState(doc: Document, elem: Element): void {
        super.dumpXmlState(doc, elem);
        this.captureState();
        CircuitXMLSerializer.dumpAttr(elem, "sr", this.shiftReg);
        CircuitXMLSerializer.dumpAttr(elem, "lr", this.storeReg);
    }

    undumpXml(xml: CircuitXMLDeserializer): void {
        super.undumpXml(xml);
        this.shiftReg = xml.parseIntAttr("sr", this.shiftReg);
        this.storeReg = xml.parseIntAttr("lr", this.storeReg);
    }

    getDumpType(): number { return 443; }
    getXmlDumpType(): string { return "sr595"; }
}
