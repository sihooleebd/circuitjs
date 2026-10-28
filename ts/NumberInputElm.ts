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

import { ChipElm } from "./ChipElm";
import { CircuitElm } from "./CircuitElm";
import { Font } from "./Font";
import { Graphics } from "./Graphics";
import { EditInfo } from "./EditInfo";
import { CircuitXMLSerializer } from "./CircuitXMLSerializer";
import { CircuitXMLDeserializer } from "./CircuitXMLDeserializer";
import { customChipStart } from "./digital/chip_desc";
import type { ChipDesc } from "./digital/chip_desc";
import type { Chip } from "./digital/chip";
import type { DigitalSynthesis } from "./digital/DigitalGraphBuilder";

/** Drives a zero-input CUSTOM_CHIP source cell to `high` - LogicInputElm.pushDigitalValue()'s
 * one-shot self-correcting event, shared by every multi-bit source here. */
export function pushBit(chip: Chip, high: boolean): void {
    if ((high ? 1 : 0) !== chip.output) chip.pendingEvent = chip.circuit.queuePush(chip, 0);
}

/** A typed-in number driven onto `bits` output pins (D0 = LSB) - the input-side counterpart of
 * DecimalDisplayElm. Accepts decimal, 0x hex, 0b binary or 0o octal; a negative number is
 * stored as its two's complement. Editing rebuilds the digital graph (EditDialog.apply()'s
 * needAnalyze()), so the cells only ever need to settle to `value` at build time. */
export class NumberInputElm extends ChipElm {
    value = 0;

    getChipName(): string { return "number input"; }
    needsBits(): boolean { return true; }
    defaultBitCount(): number { return 8; }

    setupPins(): void {
        this.sizeX = 4;
        this.sizeY = this.bits;
        this.pins = new Array(this.bits);
        this.makeBitPins(this.bits, 0, ChipElm.SIDE_E, 0, "D", true, false, false);
        this.allocNodes();
    }

    getPostCount(): number { return this.bits; }
    getVoltageSourceCount(): number { return this.bits; }

    digitalSynthesis(): DigitalSynthesis {
        const desc: ChipDesc[] = [];
        const pinMap = new Map<number, number>();
        for (let k = 0; k < this.bits; k++) {
            desc.push(customChipStart((chip) => pushBit(chip, ((this.value >> k) & 1) === 1)).outputPin(k + 1));
            pinMap.set(k, k + 1);
        }
        return { desc, pinMap };
    }

    draw(g: Graphics): void {
        this.drawChip(g);
        g.save();
        g.setFont(new Font("SansSerif", 0, 8 * this.csize));
        g.setColor(CircuitElm.whiteColor);
        g.context.textBaseline = "middle";
        g.context.textAlign = "center";
        const xs = this.rectPointsX, ys = this.rectPointsY;
        g.drawString(String(this.value), (xs[0] + xs[1]) / 2, (ys[0] + ys[2]) / 2);
        g.restore();
    }

    getInfo(arr: string[]): void {
        arr[0] = "number input";
        arr[1] = "value = " + this.value;
        arr[2] = "0x" + this.value.toString(16).toUpperCase() + " = 0b" + this.value.toString(2).padStart(this.bits, "0");
    }

    dumpXml(doc: Document, elem: Element): void {
        super.dumpXml(doc, elem);
        CircuitXMLSerializer.dumpAttr(elem, "va", this.value);
    }

    undumpXml(xml: CircuitXMLDeserializer): void {
        super.undumpXml(xml);
        this.value = xml.parseIntAttr("va", 0);
    }

    getChipEditInfo(n: number): EditInfo | null {
        if (n === 0)
            return new EditInfo("# of Bits", this.bits, 1, 16).setDimensionless();
        if (n === 1)
            return new EditInfo("Value (e.g. 42, 0x2A, 0b101010)", String(this.value));
        return null;
    }

    setChipEditValue(n: number, ei: EditInfo): void {
        if (n === 0) {
            if (ei.value >= 1 && ei.value <= 16) {
                this.bits = Math.trunc(ei.value);
                this.value &= (1 << this.bits) - 1;
                this.setupPins();
                this.setPoints();
            } else
                ei.setError("must be between 1 and 16");
        }
        if (n === 1) {
            const v = Number(ei.textf!.value.trim());
            if (Number.isInteger(v) && ei.textf!.value.trim() !== "")
                this.value = v & ((1 << this.bits) - 1);
            else
                ei.setError("not a whole number");
        }
    }

    getDumpType(): number { return 444; }
    getXmlDumpType(): string { return "numin"; }
}
