import { z } from "zod";

const text = z.string().max(64 * 1024);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._:-]*$/).refine(s => !s.includes(".."));
const ts = z.string().min(1).max(128);
const amount = z.union([z.number(), z.string().min(1).max(256)]);
const height = z.number().int().nonnegative();
const candidate = z.strictObject({ txid: id, confidence: z.enum(["high","medium","low"]), matched: z.array(z.string().max(128)).max(32), status: z.string().max(128) });
const schemas = {
  intent: z.strictObject({
    network: z.enum(["testnet","mainnet"]).optional(), call_id:id, ts, amount_zec:amount,
    amount_zats:z.string().regex(/^(0|[1-9][0-9]{0,30})$/), recipient:text.min(1), memo:text.optional(),
    allowlist_hit:z.boolean(), cap_zec:amount, view_key_fingerprint:z.string().max(128).nullable(),
    idempotency_key:id.optional(), params_sha256:z.string().min(1).max(128).optional(),
    operation_id:z.string().regex(/^op_[0-9a-f]{32}$/).optional(), chain_tip:height.optional(), wallet_height:height.optional(),
    imported:z.boolean().optional(), two_step:z.boolean().optional(), transmit_tracked:z.boolean().optional(),
  }),
  event: z.strictObject({
    ts, call_id:id, state:z.enum(["pending","unknown","not_sent","expired","sent","failed","mined"]),
    txid:id.optional(), staged_txid:id.optional(), block_height:height.optional(), code:text.optional(), error:text.optional(),
    possible_sends:z.array(candidate).max(128).optional(), note:text.optional(), transmit_authorized:z.boolean().optional(),
    calculated_fee_zats:z.string().regex(/^[0-9]{1,31}$/).optional(), by:z.enum(["send","recovery","status","import"]),
  }),
  binding:z.strictObject({key:id,call_id:id,params_sha256:z.string().min(1).max(128),ts}),
  index:z.strictObject({call_id:id}),
  meta:z.strictObject({version:z.literal(1),created:ts,note:text}),
  tip:z.strictObject({height,ts}),
};
export function invalidPaymentState(): never {
  throw Object.assign(new Error("Invalid persisted payment record; stop and inspect a coordinated snapshot."), {code:"STATE_READ_FAILED"});
}
/** Unknown fields/versions require an explicit migration, never best-effort interpretation. */
export function validatePaymentState(kind: keyof typeof schemas, value: unknown): void {
  if (!schemas[kind].safeParse(value).success) invalidPaymentState();
}
