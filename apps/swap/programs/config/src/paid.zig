//! The paid enable and the admin's wallet decisions (Open Exchange 0.15.0), pure: main.zig wires the VM.
//!
//! - **The price**, the root of the head `amm/enable-price`: `{kind: "amm-enable-price", sats}` — the
//!   admin's `price {sats | null}` (null, or no record: the paid route is off). `GET /defaults` shows it
//!   as `enablePriceSats`; `enable-check` reads it (0.15.3: no event, no route price).
//! - **The paid enable** (0.15.3: a BEEF submission, not a payment filter), `POST /amm/enable?tokenId=&paymentTxid=
//!   &paymentVout=&derivationPrefix=&derivationSuffix=`, the body ONE BEEF holding the token's deploy and the
//!   payment, each with its ancestry (filters kernel.brc104, kernel.beef, `enable-check`). `enable-check`
//!   (`check`) refuses, in order: no price (the record below), no token id, the token on the list (enabled, or
//!   disabled by the admin: only the admin re-enables it), no deploy of the token in the BEEF, no payment named
//!   or not in it (402), under the price (402), the payment already in the wallet (409). The handler checks the
//!   output pays the BRC-29 key derived for the sender, hands the payment to the wallet (a loopback message to
//!   the box `amm/pay`), and does what the admin's enable does, keeping `{paidBy, paymentTxid, satoshisPaid}`.
//! - **The withdraw**, the admin's `withdraw` (no arguments): a standard BRC-29 payment to the message's
//!   signed sender. A derivation prefix and suffix drawn as the wallet program's `payHost` draws them;
//!   the payee key from the signer (protocol `[2, "3241645161d8"]`, key id `"<prefix> <suffix>"`,
//!   counterparty the admin); the instance's own wallet (the genesis program `wallet`, launched): its
//!   coins (`list`), then ONE `createAction` with `options.noSend` of every spendable coin to that
//!   P2PKH, the output the total less the fee the builder charges (`feeFor`), so that it makes no
//!   change. Nothing goes to the chain app: the admin's wallet takes the payment in, which puts it on
//!   the network. Kept under the head `amm/withdrawals`: `{kind: "amm-withdrawals", withdrawals: [{n,
//!   txid, sats, at, outputIndex: 0, derivationPrefix, derivationSuffix, senderIdentityKey, beef}]}`
//!   (n from 1; `beef` the action's Atomic BEEF).
const std = @import("std");
const w = @import("chain");
const tokens = @import("tokens.zig");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const price_head = "amm/enable-price";
pub const price_kind = "amm-enable-price";
/// 0.15.3: the box the paid enable's payment goes to, from this instance itself (a loopback message), for the wallet.
pub const pay_box = "amm/pay";

fn map(a: Allocator, es: []const cbor.Entry) !Value {
    return .{ .map = try a.dupe(cbor.Entry, es) };
}

// ---------------------------------------------------------------- the price

pub const PriceArg = union(enum) { ok: ?u64, bad: []const u8 };

/// The admin's `price` args → the sats, or null (off).
pub fn priceArg(args: ?Value) PriceArg {
    const want = "want args {sats: <an integer, 1 or more> | null}";
    const x = args orelse return .{ .bad = want };
    if (x != .map) return .{ .bad = want };
    for (x.map) |e| if (!eql(u8, e.key, "sats")) return .{ .bad = want };
    const v = x.get("sats") orelse return .{ .bad = want };
    if (v == .null) return .{ .ok = null };
    if (v != .uint or v.uint == 0) return .{ .bad = want };
    return .{ .ok = v.uint };
}

/// The record: `{kind, sats}` (sats null: off).
pub fn priceRecord(a: Allocator, sats: ?u64) !Value {
    return map(a, &.{
        .{ .key = "kind", .value = .{ .text = price_kind } },
        .{ .key = "sats", .value = if (sats) |n| .{ .uint = n } else .null },
    });
}

/// The price a record names, or null (none, or off).
pub fn priceOf(rec: ?Value) ?u64 {
    const r = rec orelse return null;
    if (!eql(u8, r.getText("kind") orelse "", price_kind)) return null;
    return r.getUint("sats");
}

// ---------------------------------------------------------------- the withdraw

/// The admin's `withdraw` args: none (absent, null or `{}`); else why not.
pub fn withdrawArgsProblem(args: ?Value) ?[]const u8 {
    const x = args orelse return null;
    if (x == .null) return null;
    if (x == .map and x.map.len == 0) return null;
    return "withdraw takes no args: the payment goes to the message's sender";
}

pub const withdrawals_head = "amm/withdrawals";
pub const withdrawals_kind = "amm-withdrawals";

/// The kept withdrawals (none: no record).
pub fn withdrawalsOf(rec: ?Value) []const Value {
    const r = rec orelse return &.{};
    if (!eql(u8, r.getText("kind") orelse "", withdrawals_kind)) return &.{};
    return r.getArray("withdrawals") orelse &.{};
}

/// A withdrawal: what the record keeps of it (and the answer, without `beef`).
pub const Withdrawal = struct {
    txid: []const u8,
    sats: u64,
    at: u64,
    prefix: []const u8,
    suffix: []const u8,
    /// This instance's identity key (hex): the payment's sender, the recipient's counterparty.
    sender: []const u8,
    beef: []const u8,
};

/// The withdrawal's fields as kept, `n` its number; with `beef` (the record) or `tx` (the answer) as the BEEF's key.
pub fn withdrawalValue(a: Allocator, n: u64, x: Withdrawal, beef_key: []const u8) !Value {
    return map(a, &.{
        .{ .key = "n", .value = .{ .uint = n } },
        .{ .key = "txid", .value = .{ .text = x.txid } },
        .{ .key = "sats", .value = .{ .uint = x.sats } },
        .{ .key = "at", .value = .{ .uint = x.at } },
        .{ .key = "outputIndex", .value = .{ .uint = 0 } },
        .{ .key = "derivationPrefix", .value = .{ .text = x.prefix } },
        .{ .key = "derivationSuffix", .value = .{ .text = x.suffix } },
        .{ .key = "senderIdentityKey", .value = .{ .text = x.sender } },
        .{ .key = beef_key, .value = .{ .bytes = x.beef } },
    });
}

/// The record with one more withdrawal, n = the count so far + 1.
pub fn withWithdrawal(a: Allocator, prev: []const Value, x: Withdrawal) !Value {
    const all = try a.alloc(Value, prev.len + 1);
    @memcpy(all[0..prev.len], prev);
    all[prev.len] = try withdrawalValue(a, prev.len + 1, x, "beef");
    return map(a, &.{
        .{ .key = "kind", .value = .{ .text = withdrawals_kind } },
        .{ .key = "withdrawals", .value = .{ .array = all } },
    });
}

fn varintLen(n: u64) u64 {
    return if (n < 0xfd) 1 else if (n <= 0xffff) 3 else if (n <= 0xffff_ffff) 5 else 9;
}

/// The fee the wallet's builder charges for `n` of its own coins (P2PKH, each unlock estimated at 106
/// bytes) and one output of `script_len` bytes, a 25-byte change output included in the size
/// (skein-sdk wallet/src/builder.zig `estimateFeeFor`; bsvz SatoshisPerKilobyte: ceil(size × rate / 1000)).
/// With the output at the total less this fee, the change comes to zero and the builder drops it.
pub fn feeFor(n: u64, script_len: u64, sats_per_kb: u64) u64 {
    var size: u64 = 4 + varintLen(n);
    size += n * (40 + varintLen(106) + 106);
    size += varintLen(2);
    size += 8 + varintLen(script_len) + script_len;
    size += 8 + varintLen(25) + 25;
    size += 4;
    return (size * sats_per_kb + 999) / 1000;
}

// ---------------------------------------------------------------- the paid enable

/// A query parameter's value, percent-decoded (`%XX`; `+` kept as is), or null.
pub fn queryParam(a: Allocator, query: []const u8, name: []const u8) !?[]const u8 {
    const q = if (std.mem.startsWith(u8, query, "?")) query[1..] else query;
    var it = std.mem.splitScalar(u8, q, '&');
    while (it.next()) |kv| {
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        if (!eql(u8, kv[0..eq], name)) continue;
        const v = kv[eq + 1 ..];
        var out: std.ArrayList(u8) = .empty;
        var k: usize = 0;
        while (k < v.len) : (k += 1) {
            if (v[k] == '%' and k + 2 < v.len) {
                const b = std.fmt.parseInt(u8, v[k + 1 .. k + 3], 16) catch return null;
                try out.append(a, b);
                k += 2;
            } else try out.append(a, v[k]);
        }
        return out.items;
    }
    return null;
}

/// The token id in the request's query (`?tokenId=<txid>_<vout>`, any id form `canonicalId` takes), or null.
pub fn queryTokenId(a: Allocator, query: []const u8) !?[]const u8 {
    return tokens.canonicalId(a, (try queryParam(a, query, "tokenId")) orelse return null);
}

/// The payment the query names (0.15.3): `paymentTxid`, `paymentVout`, `derivationPrefix`, `derivationSuffix`; null when any is missing or malformed.
pub const Named = struct { txid: [32]u8, txid_hex: []const u8, vout: u32, prefix: []const u8, suffix: []const u8 };

pub fn queryPayment(a: Allocator, query: []const u8) !?Named {
    const t = (try queryParam(a, query, "paymentTxid")) orelse return null;
    const txid = w.header.fromHex(t) catch return null;
    const vtext = (try queryParam(a, query, "paymentVout")) orelse return null;
    const vout = std.fmt.parseInt(u32, vtext, 10) catch return null;
    const prefix = (try queryParam(a, query, "derivationPrefix")) orelse return null;
    const suffix = (try queryParam(a, query, "derivationSuffix")) orelse return null;
    if (prefix.len == 0 or suffix.len == 0) return null;
    return .{ .txid = txid, .txid_hex = try a.dupe(u8, &w.header.toHex(txid)), .vout = vout, .prefix = prefix, .suffix = suffix };
}

/// The BEEF with `txid` as its Atomic subject (0.15.3: the request's one BEEF holds the deploy and the payment, each
/// with its ancestry; the deploy check, the token instance's deploy event and the wallet's internalize each take an
/// Atomic BEEF of their own transaction, the other one beside it).
pub fn atomicFor(a: Allocator, wire: []const u8, txid: [32]u8) ![]u8 {
    var b = try w.beef.parse(a, wire);
    b.atomic = txid;
    b.form = null;
    b.vout = null;
    return w.beef.serialize(a, b);
}

/// The Atomic BEEF of `txid` alone, cut from the bundle (0.15.4): the transaction and its ancestry in the bundle back
/// to proven ones (a transaction with a BUMP needs no parents), the BUMPs those name (re-indexed), written parents
/// first (skein-sdk `beef.sorted`, as the relay writes). What the wallet's internalize takes (it refuses a BEEF that
/// is not parents first: `NotParentsFirst`, ovh 0.15.3).
pub fn cutFor(a: Allocator, wire: []const u8, txid: [32]u8) ![]u8 {
    const b = try w.beef.parse(a, wire);
    const keep = try a.alloc(bool, b.entries.len);
    @memset(keep, false);
    var todo: std.ArrayList([32]u8) = .empty;
    try todo.append(a, txid);
    while (todo.pop()) |t| {
        const i = b.indexOf(t) orelse continue;
        if (keep[i]) continue;
        keep[i] = true;
        const e = b.entries[i];
        if (e.bump != null) continue;
        if (e.tx) |tx| for (tx.inputs) |in| try todo.append(a, in.previous_outpoint.txid.bytes);
    }
    const bump_at = try a.alloc(?usize, b.bumps.len);
    @memset(bump_at, null);
    var bumps: std.ArrayList(w.bsvz.spv.MerklePath) = .empty;
    var entries: std.ArrayList(w.beef.Entry) = .empty;
    for (b.entries, keep) |e, k| {
        if (!k) continue;
        var x = e;
        if (e.bump) |j| {
            if (bump_at[j] == null) {
                bump_at[j] = bumps.items.len;
                try bumps.append(a, b.bumps[j]);
            }
            x.bump = bump_at[j];
        }
        try entries.append(a, x);
    }
    const cut = try w.beef.sorted(a, .{ .version = b.version, .atomic = txid, .bumps = bumps.items, .entries = entries.items });
    return w.beef.serialize(a, cut);
}

/// Output `vout` of the BEEF's transaction `txid`: its satoshis and locking script, or null (not in it, no raw, no such output).
pub fn outputIn(a: Allocator, wire: []const u8, txid: [32]u8, vout: u32) !?struct { satoshis: u64, script: []const u8 } {
    const b = w.beef.parse(a, wire) catch return null;
    const e = b.find(txid) orelse return null;
    const raw = e.raw orelse return null;
    const tx = w.bsvz.transaction.Transaction.parse(a, raw) catch return null;
    if (vout >= tx.outputs.len) return null;
    return .{ .satoshis = @intCast(tx.outputs[vout].satoshis), .script = tx.outputs[vout].locking_script.bytes };
}

/// A refusal of `enable-check`: the status, a code, why, and (402) the price.
pub const Refusal = struct { status: u16, code: []const u8, reason: []const u8, satoshis_required: ?u64 = null };

pub const Check = union(enum) { ok: struct { deploy: tokens.Deploy, payment: Named, deploy_beef: []const u8 }, refused: Refusal };

/// `enable-check` (0.15.3), in order: the price (the swap app's record), the token id, the list, the deploy in the
/// BEEF, the payment named and in it, its amount, the replay (`held`: the wallet holds the named payment's transaction).
pub fn check(a: Allocator, price: ?u64, rows: []const Value, query: []const u8, wire: ?[]const u8, held: bool) !Check {
    const p = price orelse return .{ .refused = .{ .status = 403, .code = "ERR_PAID_ENABLE_OFF", .reason = "paid enable is off: this exchange sets no price to enable a token" } };
    const tid = (try queryTokenId(a, query)) orelse return .{ .refused = .{ .status = 400, .code = "ERR_BAD_REQUEST", .reason = "want ?tokenId=<txid>_<vout>" } };
    if (tokens.find(rows, tid)) |row| {
        const disabled = tokens.statusOf(row) == .disabled;
        return .{ .refused = .{ .status = 409, .code = if (disabled) "ERR_TOKEN_DISABLED" else "ERR_TOKEN_ENABLED", .reason = if (disabled)
            try std.fmt.allocPrint(a, "{s} was disabled by the admin: only the admin enables it again", .{tid})
        else
            try std.fmt.allocPrint(a, "{s} is enabled already", .{tid}) } };
    }
    const b = wire orelse return .{ .refused = .{ .status = 400, .code = "ERR_BAD_DEPLOY", .reason = "want the body: one BEEF holding the token's deploy and the payment (application/octet-stream)" } };
    const nid = w.header.fromHex(tid[0..64]) catch return .{ .refused = .{ .status = 400, .code = "ERR_BAD_REQUEST", .reason = "want ?tokenId=<txid>_<vout>" } };
    const dbeef = atomicFor(a, b, nid) catch return .{ .refused = .{ .status = 400, .code = "ERR_BAD_DEPLOY", .reason = "the body is not a BEEF" } };
    const d = switch (try tokens.deployOf(a, tid, dbeef)) {
        .refused => |why| return .{ .refused = .{ .status = 400, .code = "ERR_BAD_DEPLOY", .reason = why } },
        .ok => |x| x,
    };
    const named = (try queryPayment(a, query)) orelse return .{ .refused = .{ .status = 402, .code = "ERR_PAYMENT_REQUIRED", .reason = "name the payment: paymentTxid, paymentVout, derivationPrefix, derivationSuffix", .satoshis_required = p } };
    const out = (try outputIn(a, b, named.txid, named.vout)) orelse return .{ .refused = .{ .status = 402, .code = "ERR_PAYMENT_REQUIRED", .reason = "the named payment output is not in the BEEF", .satoshis_required = p } };
    if (out.satoshis < p) return .{ .refused = .{ .status = 402, .code = "ERR_PAYMENT_TOO_SMALL", .reason = try std.fmt.allocPrint(a, "the payment output holds {d} sats; the price is {d}", .{ out.satoshis, p }), .satoshis_required = p } };
    if (held) return .{ .refused = .{ .status = 409, .code = "ERR_PAYMENT_REPLAYED", .reason = "this payment was already used" } };
    return .{ .ok = .{ .deploy = d, .payment = named, .deploy_beef = dbeef } };
}

/// The paid enable's row: the admin enable's row with `paidBy` (hex), `paymentTxid` and `satoshisPaid`.
pub fn paidRow(a: Allocator, row: Value, paid_by: []const u8, txid: []const u8, sats: u64) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, row.map);
    try es.appendSlice(a, &.{
        .{ .key = "paidBy", .value = .{ .text = try a.dupe(u8, &std.fmt.bytesToHex(paid_by[0..33].*, .lower)) } },
        .{ .key = "paymentTxid", .value = .{ .text = txid } },
        .{ .key = "satoshisPaid", .value = .{ .uint = sats } },
    });
    return .{ .map = es.items };
}

/// A filter's refusal: `{reject: {status, code, reason}}`; with the price (402), the answer itself:
/// `{status: "error", code, satoshisRequired, description}`.
pub fn rejectAnswer(a: Allocator, r: Refusal) !Value {
    if (r.satoshis_required) |n| {
        var out: std.Io.Writer.Allocating = .init(a);
        var jw: std.json.Stringify = .{ .writer = &out.writer };
        try jw.write(.{ .status = "error", .code = r.code, .satoshisRequired = n, .description = r.reason });
        return map(a, &.{.{ .key = "answer", .value = try map(a, &.{
            .{ .key = "status", .value = .{ .uint = r.status } },
            .{ .key = "type", .value = .{ .text = "application/json" } },
            .{ .key = "body", .value = .{ .bytes = out.written() } },
        }) }});
    }
    return map(a, &.{.{ .key = "reject", .value = try map(a, &.{
        .{ .key = "status", .value = .{ .uint = r.status } },
        .{ .key = "code", .value = .{ .text = r.code } },
        .{ .key = "reason", .value = .{ .text = r.reason } },
    }) }});
}

/// A filter's pass, untouched: `{pass: {}}`.
pub fn passAnswer(a: Allocator) !Value {
    return map(a, &.{.{ .key = "pass", .value = .{ .map = &.{} } }});
}
