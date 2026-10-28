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
import { CircuitElm } from "./CircuitElm";
import { Font } from "./Font";
import { Graphics } from "./Graphics";
import { CircuitXMLSerializer } from "./CircuitXMLSerializer";
import { CircuitXMLDeserializer } from "./CircuitXMLDeserializer";
import { customChipStart } from "./digital/chip_desc";
import type { Chip } from "./digital/chip";
import type { Circuit } from "./digital/circuit";
import { getCurrentDigitalGraph } from "./digital/DigitalGraphBuilder";
import type { DigitalInitialState, DigitalSynthesis } from "./digital/DigitalGraphBuilder";

// Post layout: 0-7 D0-D7, 8 CLK - module constants for the same reason as Decoder138Elm's.
const CLK = 8, POSTS = 9;
const COLS = 20, ROWS = 12;

/** Splits text into display rows of at most `cols` characters. */
export function wrapRows(text: string, cols: number): string[] {
    return text.split("\n").flatMap(l => l.match(new RegExp(`.{1,${cols}}`, "gu")) ?? [""]);
}

/** Draws `lines` in monospace, centered in the chip's body. */
export function drawTextBlock(g: Graphics, elm: ChipElm, lines: string[], cols: number): void {
    const lh = 10 * elm.csize;
    const xs = elm.rectPointsX, ys = elm.rectPointsY;
    g.save();
    g.setFont(new Font("monospace", 0, 7 * elm.csize));
    g.setColor(CircuitElm.whiteColor);
    g.context.textBaseline = "top";
    const x = (xs[0] + xs[1] - g.context.measureText("M".repeat(cols)).width) / 2;
    const y = (ys[0] + ys[2] - lh * lines.length) / 2;
    lines.forEach((l, i) => g.drawString(l, x, y + i * lh));
    g.restore();
}

/** Prints the byte on D0-D7 on every CLK rising edge, decoding UTF-8 (so plain ASCII just
 * works). 8 = backspace, 10 or 13 = newline, 12 (form feed) = clear screen, other control codes
 * are ignored. Logisim's TTY, minus its separate clear/write-enable pins. */
export class TerminalElm extends ChipElm implements DigitalInitialState {
    text = "";
    private decoder = new TextDecoder();
    // Only edges on this circuit count; see digitalInitialState().
    private armedCircuit: Circuit | null = null;

    getChipName(): string { return "terminal"; }

    setupPins(): void {
        this.sizeX = 8;
        this.sizeY = 9;
        this.pins = new Array(POSTS);
        this.makeBitPins(8, 0, ChipElm.SIDE_W, 0, "D", false, false, false);
        this.pins[CLK] = new Pin(this, 8, ChipElm.SIDE_W, "");
        this.pins[CLK].clock = true;
        this.allocNodes();
    }

    getPostCount(): number { return POSTS; }
    getVoltageSourceCount(): number { return 0; }

    /** One CUSTOM_CHIP reading every input, same shape as StopTriggerElm's detect cell: bit k
     * of chip.inputs is Dk, bit 8 is CLK. */
    digitalSynthesis(): DigitalSynthesis {
        const pinMap = new Map<number, number>();
        for (let i = 0; i < POSTS; i++) pinMap.set(i, i + 1);
        const update = (chip: Chip, mask: number): void => {
            if (mask === 0) return;
            chip.inputs ^= mask;
            if ((mask & (1 << CLK)) !== 0 && (chip.inputs & (1 << CLK)) !== 0 && chip.circuit === this.armedCircuit)
                this.put(chip.inputs & 0xff);
        };
        return { desc: [customChipStart(update).inputPins(1, 2, 3, 4, 5, 6, 7, 8, 9)], pinMap };
    }

    /** Arms the graph being seeded, after Circuit.drainZeroDelayEvents() has already run: a
     * LogicInputElm wired straight to CLK settles to "high" with a real edge during that drain
     * on every rebuild, which would otherwise reprint the last character on every edit. Also
     * leaves a TruthTableDialog scratch copy unarmed (it never becomes the current graph), so
     * that can't print here either. */
    digitalInitialState(): null {
        this.armedCircuit = getCurrentDigitalGraph()?.circuit ?? null;
        return null;
    }

    put(b: number): void {
        if (b === 8) this.text = this.text.slice(0, -1);
        else if (b === 12) this.text = "";
        else if (b === 10 || b === 13) this.text += "\n";
        else if (b >= 32) this.text += this.decoder.decode(Uint8Array.of(b), { stream: true });
        // ponytail: keeps the last 4k chars, plenty for a 20x12 screen
        if (this.text.length > 4096) this.text = this.text.slice(-4096);
    }

    draw(g: Graphics): void {
        this.drawChip(g);
        const rows = wrapRows(this.text + "_", COLS).slice(-ROWS);
        drawTextBlock(g, this, rows, COLS);
    }

    reset(): void {
        super.reset();
        this.text = "";
        this.decoder = new TextDecoder();
    }

    getInfo(arr: string[]): void {
        arr[0] = "terminal";
        arr[1] = this.text.length + " chars";
    }

    dumpXmlState(doc: Document, elem: Element): void {
        super.dumpXmlState(doc, elem);
        if (this.text !== "")
            CircuitXMLSerializer.dumpAttr(elem, "tx", this.text);
    }

    undumpXml(xml: CircuitXMLDeserializer): void {
        super.undumpXml(xml);
        this.text = xml.parseStringAttr("tx", "") ?? "";
    }

    getDumpType(): number { return 446; }
    getXmlDumpType(): string { return "term"; }
}
