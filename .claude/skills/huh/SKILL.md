---
name: huh
description: Reframe a comment, question, or passage to be succinct, lucid, and free of jargon — for when something the user or someone else has written is hard to follow. Also applies when the agent is asking the user for direction: the question must give enough context that an intelligent reader can actually respond, framed as a senior engineer seeking strategic guidance rather than a junior dev throwing tactical minutiae back. Explains or writes around project-specific terms so an outsider could understand. Triggered when the user types `/huh`, "huh?", "eh?", "what?", or similar confusion cues about a piece of text.
---

# Huh

The user has flagged a piece of writing — their own, yours, or someone else's — as hard to follow. Rewrite it so a thoughtful reader with no project context could understand it.

The same standard applies when **the agent is asking the user for direction**. A question that lands cold must carry enough context for the reader to answer it without first having to reconstruct what the agent is looking at. Too often agents fire off obscure, code-level, hyper-tactical questions that resemble an over-excited junior dev rather than a senior engineer asking for strategic guidance. This skill corrects that.

## What to rewrite

- **If the user quoted or pointed at specific text** (a message, a paragraph, a doc excerpt, a comment on a PR), rewrite that text.
- **If the user pointed at a question the agent itself just asked**, rewrite that question per the "Asking for direction" section below.
- **If the user pasted a prior exchange or conversation block** and said `/huh`, default to rewriting the agent's last substantive message in that block. That is almost always the target. Do not ask which passage unless the block genuinely contains multiple unrelated candidates.
- **If the user said `/huh` with no target at all** (no quote, no paste, no recent agent message to point at), ask which passage they want reframed. Do not guess.
- **If the target contains multiple distinct ideas**, rewrite each one; do not merge them into a single blurred sentence.

## Rewrite principles

1. **Succinct.** Cut every word that does not pull its weight. A good rewrite is usually shorter than the original — but not at the cost of clarity. Do not compress so hard the meaning breaks.

2. **Lucid.** One idea per sentence. Put the main point first. Prefer active voice and concrete subjects. If a sentence needs to be re-read to be understood, split it.

3. **Jargon-free where possible.** Replace jargon with plain words. When a technical term is load-bearing and has no good everyday substitute, keep it but define it in-line on first use — e.g. "the topo pass (the back-end's ordered walk through the graph)". Never keep a term that the reader has no way to decode.

4. **Contextual terms — explain or write around.** Project-specific names (subsystems, files, internal concepts, acronyms) must either be briefly explained in-line, or replaced with a description that conveys the same meaning without the name. Default to writing around the term unless it is the point of the sentence.

   **Opaque identifiers are the sharpest offenders and must go.** These include:
   - Letter/number codes invented for the conversation ("Track A", "D2", "I2", "phase 0")
   - Ticket or issue IDs ("doc 60", "#443", "PROJ-1234")
   - Fixture, file, or module names the reader has not seen ("synth-lat4", "cohort_forecast_v3", "fe is None branch")
   - Version tags without context ("v3", "the new runner")

   If the thing behind the identifier matters, describe what it *is* ("a test fixture where upstream nodes have strong delays"). If it doesn't matter, cut it. A rewrite that still contains the original's invented codes has failed.

5. **Lead with enough context to make sense of the rest.** Before any rewrite dives into detail, the reader needs to know what the passage is *about*: what kind of thing is being discussed, why it matters, and who did what. A rewrite that assumes the reader already shares the author's working memory is not a rewrite — it is the same wall of context-free text in shorter words. One opening sentence of framing is usually enough.

6. **Preserve the author's intent.** Do not soften a strong claim, hedge a direct question, or add qualifications the author did not make. The goal is clarity, not diplomacy.

## Asking for direction

This skill also governs how the agent itself should ask the user for input. The test is simple: **can an intelligent reader reasonably answer this question with the context provided?** If not, the question is broken.

Before asking, supply — in order:

1. **The decision in plain terms.** State what is being decided, in words the user can engage with. Not "should I use strategy A or B?" with no referents — but "we can either recompute on every edit (slower but always correct) or cache and invalidate on known triggers (faster but risks staleness)."

2. **Enough context to judge.** The user does not have your working memory. Briefly state the situation that makes this a question: what you were doing, what you found, why the obvious path does not work. One short paragraph, not a code tour.

3. **The options, with honest trade-offs.** At least two realistic options, each with the cost and the benefit. If one is clearly better, say so and ask for confirmation rather than pretending it is open. Avoid false choices.

4. **Your recommendation, if you have one.** A senior engineer says "I'd pick B because X, but flagging because Y is a real concern." A junior dev dumps the question in the user's lap.

5. **What you will do if the user does not reply.** This lets the user defer cheaply rather than feel forced to engage.

### Anti-patterns to avoid

- **Hyper-tactical minutiae.** "Should `fooBar.ts:243` return `null` or throw?" is almost never a question worth asking. Pick one, note the choice, move on. Ask only when the choice has real strategic consequences.
- **Jargon-dense framing.** If the question leans on project-specific names (subsystems, files, internal concepts) without explaining them, the user cannot answer without reconstructing context. Write around the names or define them in-line.
- **Binary false choices.** "Option A or Option B?" when a third option is obviously better, or when the real question is upstream of both.
- **Over-excitable cascades.** A single strategic question beats a rapid-fire list of ten tactical ones. If you are tempted to fire off many small questions, step back and find the one decision that gates the rest.
- **Asking just to offload risk.** If the answer is clear and the risk is low, decide and act. Reserve questions for genuine forks.

### Good shape for a question

A good ask reads like a senior engineer briefing a colleague: the situation, the fork in the road, the trade-offs, the recommendation, and an implicit invitation to redirect. It is short. It is answerable. It respects the reader's time.

## How to respond

- Lead with the rewrite. No preamble.
- If helpful, follow with a short note (one or two lines) calling out what you changed and why — e.g. "Dropped 'topo pass' and described it as the back-end's graph walk; split the compound sentence."
- If the original is ambiguous and you had to guess at the intended meaning, say so and offer the most likely reading, plus an alternative if there is one.
- If the original is already clear and succinct, say that plainly rather than rewriting for the sake of rewriting.

## Quality checks

Before sending the rewrite, run these checks — not as a vibe, as a list:

1. **Jargon sweep.** List every proper noun, invented code ("Track D", "D2", "I2"), ticket or doc reference, fixture name, file name, module name, and version tag in your rewrite. For each one, the rewrite must either (a) remove it, (b) replace it with a description of what it is, or (c) explain it in-line on first use. If any identifier survives unexplained, the rewrite has failed — redo it.
2. **Cold-reader test.** Imagine a smart engineer who has never seen this project reading only your rewrite. Could they tell what the passage is about, and engage with it, without asking a follow-up? If not, keep going.
3. **Read it aloud in your head.** If you stumble on a sentence, fix it.
4. **UK English** (colour, behaviour, organisation, analyse, etc.).
5. **No invented facts.** If the original omits something needed for clarity, flag the gap rather than guessing.

## Iteration

This skill is expected to evolve. If the user pushes back on a rewrite ("too terse", "you lost the nuance", "still jargon-heavy"), treat that as direction for future rewrites in this conversation, and — if the correction is general rather than one-off — offer to update this SKILL.md so the guidance sticks.
