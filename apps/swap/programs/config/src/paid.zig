//! The paid enable and the admin's wallet decisions (Open Exchange 0.15.0), pure: main.zig wires the VM.
//!
//! - **The price**, the root of the head `amm/enable-price`: `{kind: "amm-enable-price", sats}` — the
//!   admin's `price {sats | null}` (null, or no record: the paid route is off). Each `price` emits
//!   `{event: "enable-price", sats: <n> | null}`; the host, as owner, sets the `/enable` route row's
//!   `price` from it (kernel.pay charges the row's price). `GET /defaults` shows it as `enablePriceSats`.
//! - **The paid enable**, `POST /amm/enable?tokenId=<txid>_<vout>`, the body the deploy's Atomic BEEF
//!   (filters kernel.brc104, kernel.beef, `enable-check`, kernel.pay). `enable-check` (`check`) refuses
//!   before the payment filter runs: the route has no price ("paid enable is off"), the token already
//!   has a row (enabled, or disabled by the admin: only the admin re-enables it), or the BEEF is not
//!   that token's deploy (tokens.zig `deployOf`, the admin enable's check). The handler then does what
//!   the admin's enable does (the row, the event `token-enabled` with the defaults) and keeps
//!   `{paidBy, paymentTxid, satoshisPaid}` on the row.
//! - **The withdraw**, the admin's `withdraw {lockingScript}` (hex), run by this program against the
//!   instance's own wallet (the genesis program `wallet`, launched: docs/WALLET.md "Its coins move on
//!   the messages its threads take — … a program's that launches or calls it"): its coins (`list`),
//!   then ONE `createAction` of every spendable coin to the script, the output the total less the fee
//!   the wallet's builder charges (`feeFor`), so that it makes no change; the wallet broadcasts it
//!   through the chain app. Its thread rests when the chain app reports it proven (or rejected); then
//!   the withdrawal is kept under the head `amm/withdrawals`: `{kind: "amm-withdrawals", withdrawals:
//!   [{n, txid, sats, at, beef}]}` (n from 1; `beef` the action's Atomic BEEF).
const std = @import("std");
const w = @import("chain");
const tokens = @import("tokens.zig");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const price_head = "amm/enable-price";
pub const price_kind = "amm-enable-price";

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

/// `{event: "enable-price", sats: <n> | null}`.
pub fn priceEvent(a: Allocator, sats: ?u64) !Value {
    return map(a, &.{
        .{ .key = "event", .value = .{ .text = "enable-price" } },
        .{ .key = "sats", .value = if (sats) |n| .{ .uint = n } else .null },
    });
}

// ---------------------------------------------------------------- the withdraw

pub const WithdrawArg = union(enum) { ok: []const u8, bad: []const u8 };

/// The admin's `withdraw` args → the locking script (hex, lower case).
pub fn withdrawArg(a: Allocator, args: ?Value) !WithdrawArg {
    const want = "want args {lockingScript: <hex>}";
    const x = args orelse return .{ .bad = want };
    if (x != .map) return .{ .bad = want };
    for (x.map) |e| if (!eql(u8, e.key, "lockingScript")) return .{ .bad = want };
    const s = x.getText("lockingScript") orelse return .{ .bad = want };
    if (s.len == 0 or s.len % 2 != 0) return .{ .bad = want };
    const out = try a.alloc(u8, s.len);
    for (s, out) |c, *o| {
        if (!std.ascii.isHex(c)) return .{ .bad = want };
        o.* = std.ascii.toLower(c);
    }
    return .{ .ok = out };
}

pub const withdrawals_head = "amm/withdrawals";
pub const withdrawals_kind = "amm-withdrawals";

/// The kept withdrawals (none: no record).
pub fn withdrawalsOf(rec: ?Value) []const Value {
    const r = rec orelse return &.{};
    if (!eql(u8, r.getText("kind") orelse "", withdrawals_kind)) return &.{};
    return r.getArray("withdrawals") orelse &.{};
}

/// The record with one more withdrawal `{n, txid, sats, at, beef}`, n = the count so far + 1.
pub fn withWithdrawal(a: Allocator, prev: []const Value, txid: []const u8, sats: u64, at: u64, beef: []const u8) !Value {
    const all = try a.alloc(Value, prev.len + 1);
    @memcpy(all[0..prev.len], prev);
    all[prev.len] = try map(a, &.{
        .{ .key = "n", .value = .{ .uint = prev.len + 1 } },
        .{ .key = "txid", .value = .{ .text = txid } },
        .{ .key = "sats", .value = .{ .uint = sats } },
        .{ .key = "at", .value = .{ .uint = at } },
        .{ .key = "beef", .value = .{ .bytes = beef } },
    });
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

/// A refusal of `enable-check`: the status, a code, why.
pub const Refusal = struct { status: u16, code: []const u8, reason: []const u8 };

/// The token id in the request's query (`?tokenId=<txid>_<vout>`, any id form `canonicalId` takes), or null.
pub fn queryTokenId(a: Allocator, query: []const u8) !?[]const u8 {
    const q = if (std.mem.startsWith(u8, query, "?")) query[1..] else query;
    var it = std.mem.splitScalar(u8, q, '&');
    while (it.next()) |kv| {
        const eq = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        if (!eql(u8, kv[0..eq], "tokenId")) continue;
        return tokens.canonicalId(a, kv[eq + 1 ..]);
    }
    return null;
}

pub const Check = union(enum) { ok: tokens.Deploy, refused: Refusal };

/// `enable-check` over the route's price, the enable list, the token id and the body's BEEF (its wire
/// bytes, or null: the body is no BEEF the door read).
pub fn check(a: Allocator, price: u64, rows: []const Value, id: ?[]const u8, wire: ?[]const u8) !Check {
    if (price == 0) return .{ .refused = .{ .status = 403, .code = "ERR_PAID_ENABLE_OFF", .reason = "paid enable is off: this exchange sets no price to enable a token" } };
    const tid = id orelse return .{ .refused = .{ .status = 400, .code = "ERR_BAD_REQUEST", .reason = "want ?tokenId=<txid>_<vout>" } };
    if (tokens.find(rows, tid)) |row| {
        const disabled = tokens.statusOf(row) == .disabled;
        return .{ .refused = .{ .status = 409, .code = if (disabled) "ERR_TOKEN_DISABLED" else "ERR_TOKEN_ENABLED", .reason = if (disabled)
            try std.fmt.allocPrint(a, "{s} was disabled by the admin: only the admin enables it again", .{tid})
        else
            try std.fmt.allocPrint(a, "{s} is enabled already", .{tid}) } };
    }
    const b = wire orelse return .{ .refused = .{ .status = 400, .code = "ERR_BAD_DEPLOY", .reason = "want the body: the deploy's Atomic BEEF (application/octet-stream)" } };
    return switch (try tokens.deployOf(a, tid, b)) {
        .refused => |why| .{ .refused = .{ .status = 400, .code = "ERR_BAD_DEPLOY", .reason = why } },
        .ok => |d| .{ .ok = d },
    };
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

/// A filter's rejection: `{reject: {status, code, reason}}`.
pub fn rejectAnswer(a: Allocator, r: Refusal) !Value {
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
