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

// Post layout: 0-7 /I0-/I7, 8 /EI, 9-11 /A0-/A2, 12 /GS, 13 /EO - module constants for the same
// reason as Decoder138Elm's (a field set in setupPins() gets reset by its own initializer).
const EI = 8, OUT = 9, POSTS = 14;

/** Models a real SN74LS148 "8-Line To 3-Line Priority Encoder", every pin active low: with /EI
 * low, the highest-numbered low input /In puts n on /A2-/A0 (inverted, so /I7 gives LLL and /I0
 * HHH) and pulls /GS low; with no input low, /A2-/A0 and /GS stay high and /EO goes low instead
 * (wire it to the next lower-priority chip's /EI to cascade). /EI high forces every output high.
 * Purely combinational, so no state to save. */
export class Encoder148Elm extends ChipElm {
    getChipName(): string { return "Priority Encoder (74148)"; }

    setupPins(): void {
        this.sizeX = 2;
        this.sizeY = 9;
        this.pins = new Array(POSTS);
        for (let i = 0; i < 8; i++) {
            this.pins[i] = new Pin(this, i, ChipElm.SIDE_W, "I" + i);
            this.pins[i].bubble = true;
        }
        this.pins[EI] = new Pin(this, 8, ChipElm.SIDE_W, "EI");
        this.pins[EI].bubble = true;
        ["A0", "A1", "A2", "GS", "EO"].forEach((name, k) => {
            const p = this.pins[OUT + k] = new Pin(this, k < 3 ? k : k + 4, ChipElm.SIDE_E, name);
            p.output = true;
            p.bubble = true;
        });
        this.allocNodes();
    }

    getPostCount(): number { return POSTS; }
    getVoltageSourceCount(): number { return 5; }

    /** One cell per output (A0, A1, A2, GS, EO = bits 0-4 of the datasheet row below), each
     * re-deriving the whole function table from all nine inputs. */
    digitalSynthesis(): DigitalSynthesis {
        const pinMap = new Map<number, number>();
        for (let i = 0; i < POSTS; i++) pinMap.set(i, i + 1);

        const inPins = Array.from({ length: 9 }, (_, i) => i + 1); // /I0-/I7, /EI
        const desc: ChipDesc[] = [];
        for (let k = 0; k < 5; k++) {
            const out = OUT + k + 1;
            const logic: ChipLogic = (pin) => {
                let n = 7;
                while (n >= 0 && pin[n + 1]) n--; // highest active (low) input, -1 if none
                const row = pin[EI + 1] ? 0b11111 : n < 0 ? 0b01111 : 0b10000 | (~n & 7);
                pin[out] = (row >> k) & 1;
            };
            // LS148 datasheet max data-to-output delays
            desc.push(chipStart(logic).inputPins(...inPins).outputPin(out).outputDelayNs(22.0, 25.0));
        }
        return { desc, pinMap };
    }

    getDumpType(): number { return 441; }
    getXmlDumpType(): string { return "enc148"; }
}
