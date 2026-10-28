// Shared wiring for the fixed-pinout 74xx chip tests (Decoder138Elm, Encoder148Elm,
// Comparator85Elm, ShiftRegister595Elm): every input post gets its own manually-driven source,
// every output post its own probe, and the graph is built and seeded the same way
// SimulationManager.initDigitalCircuit() does. Elements are built through their real
// constructors (not Object.create(), as the older chip tests do), so a field-initializer
// clobbering setupPins()'s work would show up here.
import { CircuitElm } from "../CircuitElm";
import { customChipStart } from "./chip_desc";
import { buildDigitalCircuit, digitalOutputChip, isOutputPin, seedInitialDigitalState, setCurrentDigitalGraph } from "./DigitalGraphBuilder";
import type { Chip } from "./chip";
import { connect } from "./testWiring";

// ChipElm's constructor asks the app for the grid size; that's all the UI it touches.
(CircuitElm as any).app ??= { menus: { smallGridCheckItem: { getState: () => false } } };

/** Same shape as Counter193Elm.test.ts's manualSource(): a CUSTOM_CHIP source whose value a test
 * flips directly. */
function manualSource(initial: number) {
    const src = {
        nodes: [] as any[],
        value: initial,
        chip: null as Chip | null,
        digitalSynthesis: () => ({
            desc: [customChipStart((chip: Chip) => {
                if (src.value !== chip.output) chip.pendingEvent = chip.circuit.queuePush(chip, 0);
            }).outputPin(1)],
            pinMap: new Map([[0, 1]]),
        }),
        set(v: number) {
            src.value = v;
            if (src.chip && v !== src.chip.output) src.chip.pendingEvent = src.chip.circuit.queuePush(src.chip, 0);
        },
    };
    return src;
}

function probe() {
    return {
        digitalSynthesis: () => ({ desc: [customChipStart(() => { }).inputPins(1)], pinMap: new Map([[0, 1]]) }),
        nodes: [] as any[],
    };
}

/** Wires `elm` up on its own and runs it until settled. `init` gives input posts' starting
 * values (default 0); `set()` changes inputs and settles again; `get()` reads an output post. */
export function wireChip(elm: any, init: Record<number, number> = {}) {
    // allocNodes() put the shared ground node on every post - see Counter193Elm.test.ts's
    // buildHarness() for why connect() needs them empty instead
    elm.nodes = new Array(elm.getPostCount()).fill(null);
    const { pinMap, desc } = elm.digitalSynthesis();
    const sources = new Map<number, ReturnType<typeof manualSource>>();
    const elms: any[] = [elm];
    for (let post = 0; post < elm.getPostCount(); post++) {
        if (isOutputPin(desc, pinMap.get(post))) {
            const sink = probe();
            connect({ elm, num: post }, { elm: sink, num: 0 });
            elms.push(sink);
        } else {
            const src = manualSource(init[post] ?? 0);
            connect({ elm: src, num: 0 }, { elm, num: post });
            sources.set(post, src);
            elms.push(src);
        }
    }

    const graph = buildDigitalCircuit(elms);
    for (const src of sources.values()) src.chip = graph.chipsByElm.get(src)![0];
    setCurrentDigitalGraph(graph);
    graph.circuit.drainZeroDelayEvents();
    seedInitialDigitalState(elms, graph.chipsByElm);
    graph.circuit.run(20);

    const set = (values: Record<number, number>) => {
        for (const [post, v] of Object.entries(values)) sources.get(Number(post))!.set(v);
        graph.circuit.run(20);
    };
    const get = (post: number) => digitalOutputChip(elm, post, graph.chipsByElm)!.currentValue();
    return { graph, set, get };
}
