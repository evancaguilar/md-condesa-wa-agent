// Placeholder port implementations so src/index.ts wires and typechecks today.
// Workstreams B (brain), C (slack), D (airtable) replace these with real ones
// at integration; the pipeline depends only on the port interfaces in types.ts.

import type {
  AirtablePort,
  BrainPort,
  BrainResult,
  ConvoContext,
  PendingApproval,
  SlackPort,
} from "./types.js";

export const stubBrain: BrainPort = {
  async respond(ctx: ConvoContext): Promise<BrainResult> {
    return {
      action: "draft",
      message: "stub",
      language: ctx.contact.lang,
      confidence: "low",
      reason: "brain not implemented (workstream B)",
    };
  },
};

export const stubSlack: SlackPort = {
  async postDraft(a: PendingApproval & { contextText: string }): Promise<string> {
    console.log(`[slack stub] draft #${a.id} for ${a.phone}: ${a.draft}`);
    return `stub-${a.id}`;
  },
  async postNote(text: string): Promise<void> {
    console.log(`[slack stub] note: ${text}`);
  },
};

export const stubAirtable: AirtablePort = {
  async bookTrial(): Promise<string> {
    throw new Error("airtable.bookTrial not implemented (workstream D)");
  },
};
