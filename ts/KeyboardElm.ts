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
import { Graphics } from "./Graphics";
import { EditInfo } from "./EditInfo";
import { CircuitXMLSerializer } from "./CircuitXMLSerializer";
import { CircuitXMLDeserializer } from "./CircuitXMLDeserializer";
import { customChipStart } from "./digital/chip_desc";
import type { ChipDesc } from "./digital/chip_desc";
import type { Chip } from "./digital/chip";
import type { Circuit } from "./digital/circuit";
import { getCurrentDigitalGraph } from "./digital/DigitalGraphBuilder";
import type { DigitalInitialState, DigitalSynthesis } from "./digital/DigitalGraphBuilder";
import { pushBit } from "./NumberInputElm";
import { drawTextBlock, wrapRows } from "./TerminalElm";

// Post layout: 0-7 D0-D7, 8 AV, 9 CLK - module constants for the same reason as Decoder138Elm's.
const AV = 8, CLK = 9, POSTS = 10;
const COLS = 8, ROWS = 7;

/** Typed-in text read out one byte at a time, as UTF-8 (so plain ASCII just works): D0-D7 show
 * the next unread byte (0 once everything's read), AV is high while anything is left, and each
 * CLK rising edge moves on to the next byte. Type into it from the edit dialog, or by hovering
 * over it and typing. Reset rewinds to the start. Logisim's Keyboard, minus its read-enable. */
export class KeyboardElm extends ChipElm implements DigitalInitialState {
    text = "";
    pos = 0; // bytes already read
    private bytes = new Uint8Array(0);
    // Only edges on this circuit count; see TerminalElm.digitalInitialState().
    private armedCircuit: Circuit | null = null;

    getChipName(): string { return "keyboard"; }

    setupPins(): void {
        this.sizeX = 5;
        this.sizeY = 9;
        this.pins = new Array(POSTS);
        this.makeBitPins(8, 0, ChipElm.SIDE_E, 0, "D", true, false, false);
        this.pins[AV] = new Pin(this, 8, ChipElm.SIDE_E, "AV");
        this.pins[AV].output = true;
        this.pins[CLK] = new Pin(this, 8, ChipElm.SIDE_W, "");
        this.pins[CLK].clock = true;
        this.allocNodes();
    }

    getPostCount(): number { return POSTS; }
    getVoltageSourceCount(): number { return 9; }

    setText(s: string): void {
        this.text = s;
        this.bytes = new TextEncoder().encode(s);
        this.pos = Math.min(this.pos, this.bytes.length);
    }

    private nextByte(): number { return this.pos < this.bytes.length ? this.bytes[this.pos] : 0; }

    /** Nine zero-input source cells (D0-D7, AV) re-pushed by refresh(), plus one CLK cell. */
    digitalSynthesis(): DigitalSynthesis {
        const pinMap = new Map<number, number>();
        for (let i = 0; i < POSTS; i++) pinMap.set(i, i + 1);
        const desc: ChipDesc[] = [];
        for (let k = 0; k < 8; k++)
            desc.push(customChipStart((chip) => pushBit(chip, ((this.nextByte() >> k) & 1) === 1)).outputPin(k + 1));
        desc.push(customChipStart((chip) => pushBit(chip, this.pos < this.bytes.length)).outputPin(AV + 1));
        const clk = (chip: Chip, mask: number): void => {
            if (mask === 0) return;
            chip.inputs ^= mask;
            if ((chip.inputs & 1) !== 0 && chip.circuit === this.armedCircuit && this.pos < this.bytes.length) {
                this.pos++;
                this.refresh();
            }
        };
        desc.push(customChipStart(clk).inputPins(CLK + 1));
        return { desc, pinMap };
    }

    digitalInitialState(): null {
        this.armedCircuit = getCurrentDigitalGraph()?.circuit ?? null;
        return null;
    }

    /** Re-pushes every output cell of the live graph (the CLK cell ignores mask 0). */
    private refresh(): void {
        for (const c of getCurrentDigitalGraph()?.chipsByElm.get(this) ?? []) c.customUpdate!(c, 0);
    }

    /** Called by UIManager for a key press while hovering: true if it was used. */
    typeKey(e: KeyboardEvent): boolean {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (e.key === "Backspace") this.setText([...this.text].slice(0, -1).join(""));
        else if (e.key === "Enter") this.setText(this.text + "\n");
        else if ([...e.key].length === 1) this.setText(this.text + e.key);
        else return false;
        this.refresh();
        return true;
    }

    draw(g: Graphics): void {
        this.drawChip(g);
        const unread = new TextDecoder().decode(this.bytes.subarray(this.pos)).replace(/\n/g, "↵");
        drawTextBlock(g, this, wrapRows(unread, COLS).slice(0, ROWS), COLS);
    }

    reset(): void {
        super.reset();
        this.pos = 0;
    }

    getInfo(arr: string[]): void {
        arr[0] = "keyboard";
        arr[1] = (this.bytes.length - this.pos) + " of " + this.bytes.length + " bytes left";
        arr[2] = "hover and type to add text";
    }

    dumpXml(doc: Document, elem: Element): void {
        super.dumpXml(doc, elem);
        if (this.text !== "")
            CircuitXMLSerializer.dumpAttr(elem, "tx", this.text);
    }

    dumpXmlState(doc: Document, elem: Element): void {
        super.dumpXmlState(doc, elem);
        if (this.pos !== 0)
            CircuitXMLSerializer.dumpAttr(elem, "ps", this.pos);
    }

    undumpXml(xml: CircuitXMLDeserializer): void {
        super.undumpXml(xml);
        this.pos = xml.parseIntAttr("ps", 0);
        this.setText(xml.parseStringAttr("tx", this.text) ?? this.text);
    }

    getChipEditInfo(n: number): EditInfo | null {
        if (n === 0) {
            const ei = new EditInfo("Text", 0, -1, -1);
            ei.textArea = { value: this.text };
            return ei;
        }
        return null;
    }

    setChipEditValue(n: number, ei: EditInfo): void {
        if (n === 0) {
            const s = (ei.textArea.element as HTMLTextAreaElement).value;
            if (!s.startsWith(this.text)) this.pos = 0; // appending keeps the read position
            this.setText(s);
        }
    }

    getDumpType(): number { return 445; }
    getXmlDumpType(): string { return "kbd"; }
}
