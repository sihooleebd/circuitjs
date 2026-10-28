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
import { chipStart } from "./digital/chip_desc";
import type { ChipDesc, ChipLogic } from "./digital/chip_desc";
import type { DigitalSynthesis } from "./digital/DigitalGraphBuilder";

// Post layout: 0-3 A0-A3, 4-7 B0-B3, 8-10 cascade inputs (A<B, A=B, A>B), 11-13 outputs (A<B,
// A=B, A>B) - module constants for the same reason as Decoder138Elm's.
const B0 = 4, IN = 8, OUT = 11, POSTS = 14;

/** Models a real SN74LS85 "4-Bit Magnitude Comparator". When A and B differ, A<B/A>B says which
 * is larger regardless of the cascade inputs; when they're equal the result comes from the
 * cascade inputs (fed from the next less-significant stage), per the datasheet's function table:
 * A=B out follows A=B in, and A<B out / A>B out are high only while A=B in and the opposite
 * cascade input are both low - so a lone chip (or the least-significant one) needs A=B in tied
 * high, and the table's "all cascade inputs low -> A<B and A>B both high" rows fall out as-is.
 * Purely combinational, so no state to save. */
export class Comparator85Elm extends ChipElm {
    getChipName(): string { return "Magnitude Comparator (7485)"; }

    setupPins(): void {
        this.sizeX = 2;
        this.sizeY = 11;
        this.pins = new Array(POSTS);
        this.makeBitPins(4, 0, ChipElm.SIDE_W, 0, "A", false, false, false);
        this.makeBitPins(4, 4, ChipElm.SIDE_W, B0, "B", false, false, false);
        ["<", "=", ">"].forEach((op, k) => {
            this.pins[IN + k] = new Pin(this, 8 + k, ChipElm.SIDE_W, op);
            this.pins[OUT + k] = new Pin(this, 8 + k, ChipElm.SIDE_E, "A" + op + "B");
            this.pins[OUT + k].output = true;
        });
        this.allocNodes();
    }

    getPostCount(): number { return POSTS; }
    getVoltageSourceCount(): number { return 3; }

    /** One cell per output (A<B, A=B, A>B = bits 0-2 of `row` below), each re-deriving the whole
     * function table from all eleven inputs. */
    digitalSynthesis(): DigitalSynthesis {
        const pinMap = new Map<number, number>();
        for (let i = 0; i < POSTS; i++) pinMap.set(i, i + 1);

        const inPins = Array.from({ length: OUT }, (_, i) => i + 1);
        const desc: ChipDesc[] = [];
        for (let k = 0; k < 3; k++) {
            const out = OUT + k + 1;
            const logic: ChipLogic = (pin) => {
                let a = 0, b = 0;
                for (let i = 0; i < 4; i++) {
                    a |= pin[i + 1] << i;
                    b |= pin[B0 + i + 1] << i;
                }
                const lt = pin[IN + 1], eq = pin[IN + 2], gt = pin[IN + 3];
                const row = a < b ? 0b001 : a > b ? 0b100
                    : ((eq | gt) ^ 1) | (eq << 1) | (((eq | lt) ^ 1) << 2);
                pin[out] = (row >> k) & 1;
            };
            // LS85 datasheet max data-to-A<B/A>B delays
            desc.push(chipStart(logic).inputPins(...inPins).outputPin(out).outputDelayNs(36.0, 30.0));
        }
        return { desc, pinMap };
    }

    getDumpType(): number { return 442; }
    getXmlDumpType(): string { return "cmp85"; }
}
