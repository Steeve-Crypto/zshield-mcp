import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { addNoteFacts, corroborate, extractJson, messageFacts, type TxFacts, type WalletFacts } from "../src/chain/corroborate.ts";
import type { TxSummary } from "../src/types.ts";

// The JSON shapes are those of zingo-cli's `notes all` and `messages` (zingolib's NoteSummary
// and ValueTransfer JSON), not the shapes the fake CLI happens to print.
const fixture = (n: string) => readFileSync(new URL(`./fixtures/zingo/${n}`, import.meta.url), "utf8");
const BOB_TX = "03".repeat(32);
const BOB = (JSON.parse(fixture("messages.json")) as { value_transfers: { recipient_address: string | null }[] }).value_transfers[1].recipient_address!;

function wallet(): WalletFacts {
  const byTxid = new Map<string, TxFacts>();
  addNoteFacts(extractJson("Launching save task...\n" + fixture("notes-all.json")), byTxid);
  return { byTxid, messages: messageFacts(extractJson(fixture("messages.json"))) };
}

const sent = (extra: Partial<TxSummary> = {}): TxSummary => ({
  txid: BOB_TX,
  status: "confirmed",
  blockHeight: 12,
  kind: "sent",
  valueZats: 810000n,
  outgoing: [{ recipient: BOB, valueZats: 800000n, memo: "hi Bob" }],
  ...extra,
});

describe("corroborating a listing entry with zingo-cli's JSON", () => {
  it("reads the real note and message shapes", () => {
    const w = wallet();
    assert.deepEqual([...w.byTxid.get("07".repeat(32))!.classes], ["calculated"]);
    assert.ok(w.byTxid.get("05".repeat(32))!.classes.has("confirmed"), "the spender named by spend_status");
    assert.equal(w.messages.get(BOB_TX)?.[0].kind, "sent");
    assert.equal(w.messages.get(BOB_TX)?.[0].value, 800000n);
  });

  it("vouches for a sent entry whose memo, recipient and amount the messages JSON repeats", () => {
    assert.equal(corroborate(sent(), wallet(), 1), true);
  });

  it("does not vouch when the amount differs from the messages JSON", () => {
    assert.equal(corroborate(sent({ outgoing: [{ recipient: BOB, valueZats: 1n, memo: "hi Bob" }] }), wallet(), 1), false);
  });

  it("does not vouch when the messages JSON has the memo on a received transfer", () => {
    const w = wallet();
    w.messages.get(BOB_TX)![0].kind = "received";
    assert.equal(corroborate(sent(), w, 1), false);
  });

  it("does not vouch for an entry at another height than the notes say", () => {
    assert.equal(corroborate(sent({ blockHeight: 13 }), wallet(), 1), false);
  });
});
