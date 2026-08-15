# System Prompt Builder — Design Directions

## Approach 1: Signal Ledger

**Very Brief Intro:** A high-trust operator console inspired by editorial data terminals, using a warm paper field, dense typographic hierarchy, and decisive red/blue proof marks. It makes prompt quality feel auditable rather than mystical.

**Probability:** 0.07

## Approach 2: Quiet Instrument

**Very Brief Intro:** A restrained laboratory interface with stone neutrals, field-note annotation, and functional accent colors. The experience feels like using a precision instrument for language design.

**Probability:** 0.03

## Approach 3: Foundry Workbench

**Very Brief Intro:** A dark-but-not-neon workshop for shaping instructions, with graphite panels, copper markers, and tactile process cards. It emphasizes craft, iteration, and visible validation.

**Probability:** 0.09

## Chosen Direction: Signal Ledger

### Design Movement

**Swiss editorial systems combined with early information-design terminals.** The interface should communicate evidence, sequence, and inspection—not sci-fi automation.

### Core Principles

1. Make pipeline state legible at a glance through strong hierarchy and persistent traceability.
2. Use asymmetry: a narrow ledger rail, a generous working canvas, and an inspectable output drawer.
3. Treat verification as a visual language using purposeful proof marks, rule lines, and clearly encoded status colors.
4. Use restraint: no generic gradients, no decorative glow, and no rounded-card overload.

### Color Philosophy

Warm off-white paper and ink-black text establish seriousness and reading comfort. Signal blue denotes active computation and provenance; vermilion is reserved for rejected or unsafe states; moss indicates accepted verification. The signature blue is intentionally used sparingly so it retains the meaning of a live editorial mark.

### Layout Paradigm

Use a three-part **editorial spread** rather than a centralized dashboard: a vertical control ledger on the left, a wide working document in the center, and a proof/output column on the right. On smaller screens, collapse the outer columns into anchored drawers without losing stage order.

### Signature Elements

1. An inset blue **signal rule** marking the active stage and selected output.
2. Compact **proof stamps** for lint, critic, and security state.
3. Fine **ledger lines** and numbered stage markers that make every transition inspectable.

### Interaction Philosophy

Interactions should feel editorial and deliberate. Each run, reset, and export action presents a clear state change; keyboard navigation works across all stages; errors explain next actions rather than merely signaling failure.

### Animation

Use brief 140–220ms opacity/transform transitions for stage activation, output replacement, and dialogs. Active pipeline markers may sweep a one-pixel blue rule, but the interface must respect `prefers-reduced-motion` and never animate typing, keyboard actions, or validation results excessively.

### Typography System

Use **DM Mono** for stage metadata, prompts, status stamps, and numeric traces. Use **Source Serif 4** for section titles and explanatory material. Establish hierarchy through serif display scale, monospaced metadata, and compact all-caps labels—never use Inter.

### Brand Essence

**An evidence-minded workbench for people who need system prompts to be deliberate, inspectable, and ready to operate.**

**Personality:** exacting, calm, lucid.

### Brand Voice

Headlines are precise and declarative; CTAs name the action and expected result; microcopy identifies the next useful decision.

Examples: “Compile an instruction set you can inspect.”

“Verify this revision before it enters the vault.”

### Wordmark & Logo

The mark is an abstract **signal folio**: three vertical blue rules intersected by a concise black bracket, representing structured instruction moving through review gates. It contains no text and works as a square favicon or a larger editorial seal.

### Signature Brand Color

**Ledger Blue — `#175CFF`**

## Style Decisions

- Prefer editorial columns, thin rules, and proof stamps over floating rounded cards.
- Keep displayed prompt content readable on an off-white document surface; use slate ink and accessible contrast.
- Hosted provider controls must clearly distinguish secure adapter configuration from unavailable static-only modes.
