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

// Post layout: 0-7 /Y0-/Y7, 8-10 A/B/C (A = LSB), 11 G1, 12 /G2A, 13 /G2B. Module constants
// rather than fields set in setupPins(): ChipElm's constructor calls setupPins() before a
// subclass's own field initializers run, which would then reset any such field to its default.
const SEL = 8, G1 = 11, G2A = 12, G2B = 13, POSTS = 14;

/** Models a real SN74LS138 "3-Line To 8-Line Decoder/Demultiplexer": while enabled (G1 high AND
 * /G2A, /G2B both low) exactly the output selected by C:B:A goes low; otherwise every output
 * stays high. Purely combinational, so no state to save. */
export class Decoder138Elm extends ChipElm {
    getChipName(): string { return "3-to-8 Decoder (74138)"; }

    setupPins(): void {
        this.sizeX = 2;
        this.sizeY = 8;
        this.pins = new Array(POSTS);
        for (let i = 0; i < 8; i++) {
            this.pins[i] = new Pin(this, i, ChipElm.SIDE_E, "Y" + i);
            this.pins[i].output = true;
            this.pins[i].bubble = true;
        }
        ["A", "B", "C"].forEach((name, i) => this.pins[SEL + i] = new Pin(this, i, ChipElm.SIDE_W, name));
        this.pins[G1] = new Pin(this, 5, ChipElm.SIDE_W, "G1");
        this.pins[G2A] = new Pin(this, 6, ChipElm.SIDE_W, "G2A");
        this.pins[G2A].bubble = true;
        this.pins[G2B] = new Pin(this, 7, ChipElm.SIDE_W, "G2B");
        this.pins[G2B].bubble = true;
        this.allocNodes();
    }

    getPostCount(): number { return POSTS; }
    getVoltageSourceCount(): number { return 8; }

    /** One cell per output, each a direct translation of the datasheet's function table. */
    digitalSynthesis(): DigitalSynthesis {
        const pinMap = new Map<number, number>();
        for (let i = 0; i < POSTS; i++) pinMap.set(i, i + 1);

        const a = SEL + 1, b = SEL + 2, c = SEL + 3, g1 = G1 + 1, g2a = G2A + 1, g2b = G2B + 1;
        const desc: ChipDesc[] = [];
        for (let n = 0; n < 8; n++) {
            const out = n + 1;
            const logic: ChipLogic = (pin) => {
                const sel = (pin[c] << 2) | (pin[b] << 1) | pin[a];
                pin[out] = (pin[g1] & (pin[g2a] ^ 1) & (pin[g2b] ^ 1)) && sel === n ? 0 : 1;
            };
            // LS138 datasheet max select-to-output delays (3 levels of logic)
            desc.push(chipStart(logic).inputPins(a, b, c, g1, g2a, g2b).outputPin(out).outputDelayNs(27.0, 39.0));
        }
        return { desc, pinMap };
    }

    getDumpType(): number { return 440; }
    getXmlDumpType(): string { return "dec138"; }
}
