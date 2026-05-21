# 2026-05-15 — Neo local history compaction

## Context

A long-running local Neo session in `deep` mode hit provider `context_length_exceeded` because connector-local Neo preserved and sent full `LocalThreadActor.history` on every turn.

## Current implementation

Reworked the first deterministic snippet-compactor into a pi CLI-style compactor:

- token threshold is `contextWindow - reserveTokens`;
- recent suffix target defaults to `keepRecentTokens = 20000`;
- cut points are `user`/`assistant` messages, never tool results;
- older context is summarized by a local LLM into pi's structured checkpoint format;
- split turns get a separate turn-prefix summary;
- repeated compaction updates the prior summary;
- compacted local history is persisted separately from the full visible Neo message transcript.

## Testing

Updated `tests/neo-local-runtime.test.ts` for the pi-style summary/suffix behavior and tool-call adjacency invariant.
