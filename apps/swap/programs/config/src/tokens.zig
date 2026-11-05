//! The swap instance's state and decisions (Open Exchange, shruggr/open-exchange#1; moved from
//! skein-amm's amm-config 0.22.0), pure: over values and a store (main.zig wires the VM).
//!
//! - **The enable list**, the root of the head `amm/tokens`:
//!
//!     {kind: "amm-tokens", tokens: [<row>, …]}
//!     row {tokenId, topic, sym, dec, status, since, deploy}
//!
//!   `status` `enabled` or `disabled`: root's last decision, a fact (shruggr/skein#164: nothing
//!   answers back; the host materializes it). `since` the decision's time (ms). `deploy` the
//!   enable's BEEF as the door handed it (its envelope, or the bytes), kept so an enable of a
//!   disabled token needs no BEEF; never in the read.
//! - **The defaults**, the root of the head `amm/defaults`: `{kind: "amm-defaults", terms?:
//!   {lpFeeBps, validatorFeeBps, commissionBps}, market?: {minCommissionBps}}` — carried in the
//!   `token-enabled` event; the host sends them to a NEW token instance as root's messages.
//! - **A deploy** (`deployOf`): the enable's BEEF names the token id's transaction as its subject,
//!   and that transaction's output `<vout>` is a deploy (skein-1color's rules: a BRC-162 binary
//!   deploy at output 0, a BRC-161 inscription at any): its display fields, as the 1Color token
//!   list gives them (sym, dec); its icon is not kept (0.11.0): the `/tokens` read names the
//!   discovery instance's icon route instead, `iconUrl` = `/@discovery/1color/<tokenId>/icon`.
const std = @import("std");
const w = @import("chain");
const deploy = @import("deploy");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const tokens_head = "amm/tokens";
pub const tokens_kind = "amm-tokens";
pub const defaults_head = "amm/defaults";
pub const defaults_kind = "amm-defaults";
/// Root's box: `amm/admin` (the manifest's mailbox route `admin`).
pub const admin_box = "amm/admin";
/// The AMM lookup's service name for a token, `ls_amm_<assetId>` (src/deploy.zig, 0.22.0: shared
/// with amm-setup).
pub const ammLookupName = deploy.ammLookupName;

pub const Status = enum { enabled, disabled };

// ---------------------------------------------------------------- token ids and deploys

// The deploy read from a BEEF: src/deploy.zig (0.22.0: moved there, shared with amm-setup's deploy
// event; unchanged).
pub const Deploy = deploy.Deploy;
pub const DeployCheck = deploy.DeployCheck;
pub const canonicalId = deploy.canonicalId;
pub const deployOf = deploy.deployOf;

fn map(a: Allocator, es: []const cbor.Entry) !Value {
    return .{ .map = try a.dupe(cbor.Entry, es) };
}

// ---------------------------------------------------------------- the enable list

/// The rows of the list record (none: no record yet).
pub fn rowsOf(rec: ?Value) []const Value {
    const r = rec orelse return &.{};
    if (!eql(u8, r.getText("kind") orelse "", tokens_kind)) return &.{};
    return r.getArray("tokens") orelse &.{};
}

/// The row for `token_id`, or null.
pub fn find(rows: []const Value, token_id: []const u8) ?Value {
    for (rows) |r| if (eql(u8, r.getText("tokenId") orelse "", token_id)) return r;
    return null;
}

/// The list record with `row` in place of the token's row (or added).
pub fn withRow(a: Allocator, rows: []const Value, row: Value) !Value {
    const id = row.getText("tokenId").?;
    var out: std.ArrayList(Value) = .empty;
    var replaced = false;
    for (rows) |r| {
        if (eql(u8, r.getText("tokenId") orelse "", id)) {
            try out.append(a, row);
            replaced = true;
        } else try out.append(a, r);
    }
    if (!replaced) try out.append(a, row);
    return map(a, &.{
        .{ .key = "kind", .value = .{ .text = tokens_kind } },
        .{ .key = "tokens", .value = .{ .array = out.items } },
    });
}

/// The row for an enable: the deploy's fields, `enabled`, since `at`, the BEEF as given (`deploy`).
pub fn enabledRow(a: Allocator, d: Deploy, at: u64, deploy_value: Value) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "tokenId", .value = .{ .text = d.token_id } },
        .{ .key = "topic", .value = .{ .text = d.topic } },
        .{ .key = "sym", .value = .{ .text = d.sym } },
        .{ .key = "dec", .value = .{ .uint = d.dec } },
    });
    try es.appendSlice(a, &.{
        .{ .key = "status", .value = .{ .text = @tagName(Status.enabled) } },
        .{ .key = "since", .value = .{ .uint = at } },
        .{ .key = "deploy", .value = deploy_value },
    });
    return .{ .map = es.items };
}

/// `row` with `status` and the given fields set (each replacing its own), and `drop`'s keys removed.
pub fn updated(a: Allocator, row: Value, status: Status, set: []const cbor.Entry, drop: []const []const u8) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    outer: for (row.map) |e| {
        if (eql(u8, e.key, "status")) continue;
        for (set) |x| if (eql(u8, x.key, e.key)) continue :outer;
        for (drop) |k| if (eql(u8, k, e.key)) continue :outer;
        try es.append(a, e);
    }
    try es.append(a, .{ .key = "status", .value = .{ .text = @tagName(status) } });
    try es.appendSlice(a, set);
    return .{ .map = es.items };
}

pub fn statusOf(row: Value) ?Status {
    return std.meta.stringToEnum(Status, row.getText("status") orelse return null);
}

/// The discovery instance's icon route for a token, origin-relative (skein-1color 0.14.0, P15).
pub fn iconUrlOf(a: Allocator, token_id: []const u8) ![]const u8 {
    return std.fmt.allocPrint(a, "/@discovery/1color/{s}/icon", .{token_id});
}

/// The `/tokens` answer's JSON: the rows newest first (by `since`, then token id), each without its
/// `deploy`, with `iconUrl` (the discovery icon route; a row stored before 0.11.0 drops its data-URL
/// `icon`).
pub fn tokensJson(a: Allocator, rows: []const Value) ![]const u8 {
    const sorted = try a.dupe(Value, rows);
    std.mem.sort(Value, sorted, {}, struct {
        fn f(_: void, x: Value, y: Value) bool {
            const sx = x.getUint("since") orelse 0;
            const sy = y.getUint("since") orelse 0;
            if (sx != sy) return sx > sy;
            return std.mem.order(u8, x.getText("tokenId") orelse "", y.getText("tokenId") orelse "") == .lt;
        }
    }.f);
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginArray();
    for (sorted) |r| {
        try jw.beginObject();
        for (r.map) |e| {
            if (eql(u8, e.key, "deploy")) continue; // the BEEF is the host's (the event), not the read's
            if (eql(u8, e.key, "icon")) continue; // a pre-0.11.0 row's data URL
            try jw.objectField(e.key);
            try writeJson(&jw, e.value);
        }
        if (r.getText("tokenId")) |id| {
            try jw.objectField("iconUrl");
            try jw.write(try iconUrlOf(a, id));
        }
        try jw.endObject();
    }
    try jw.endArray();
    return out.written();
}

/// A value as JSON (maps, lists, text, numbers, booleans; bytes as hex).
pub fn writeJson(jw: *std.json.Stringify, v: Value) !void {
    switch (v) {
        .map => |es| {
            try jw.beginObject();
            for (es) |e| {
                try jw.objectField(e.key);
                try writeJson(jw, e.value);
            }
            try jw.endObject();
        },
        .array => |xs| {
            try jw.beginArray();
            for (xs) |x| try writeJson(jw, x);
            try jw.endArray();
        },
        .text => |t| try jw.write(t),
        .boolean => |b| try jw.write(b),
        .uint => |n| try jw.write(n),
        .nint => |n| try jw.write(-1 - @as(i128, n)),
        .null => try jw.write(null),
        .bytes => |b| {
            var out: std.ArrayList(u8) = .empty;
            defer out.deinit(std.heap.page_allocator);
            for (b) |x| out.appendSlice(std.heap.page_allocator, &std.fmt.bytesToHex([1]u8{x}, .lower)) catch return error.WriteFailed;
            try jw.write(out.items);
        },
        else => try jw.write(null),
    }
}

// ---------------------------------------------------------------- the defaults

pub const DefaultsChange = union(enum) { ok: Value, bad: []const u8 };

const terms_fields = [_][]const u8{ "lpFeeBps", "validatorFeeBps", "commissionBps" };

fn bps(v: Value) bool {
    return v == .uint and v.uint <= 10_000;
}

fn checkTerms(t: Value) ?[]const u8 {
    if (t != .map) return "terms: want {lpFeeBps, validatorFeeBps, commissionBps} (integers, 0 to 10000), or null";
    for (t.map) |e| {
        const known = for (terms_fields) |f| {
            if (eql(u8, f, e.key)) break true;
        } else false;
        if (!known) return "terms: want {lpFeeBps, validatorFeeBps, commissionBps} only";
    }
    for (terms_fields) |f| if (!bps(t.get(f) orelse return "terms: want {lpFeeBps, validatorFeeBps, commissionBps} (integers, 0 to 10000), or null")) return "terms: each fee is an integer, 0 to 10000 basis points";
    return null;
}

fn checkMarket(m: Value) ?[]const u8 {
    if (m != .map) return "market: want {minCommissionBps} (an integer, 0 to 10000), or null";
    for (m.map) |e| if (!eql(u8, e.key, "minCommissionBps")) return "market: want {minCommissionBps} only";
    if (!bps(m.get("minCommissionBps") orelse return "market: want {minCommissionBps}")) return "market: minCommissionBps is an integer, 0 to 10000 basis points";
    return null;
}

/// Root's `defaults {terms?, market?}` over the record `prev`: each named key set (a map, checked
/// as root's `terms` / `market` messages check theirs) or cleared (`null`); a key not named kept.
pub fn withDefaults(a: Allocator, prev: ?Value, args: ?Value) !DefaultsChange {
    const x = args orelse return .{ .bad = "want args {terms?, market?}" };
    if (x != .map) return .{ .bad = "want args {terms?, market?}" };
    for (x.map) |e| if (!eql(u8, e.key, "terms") and !eql(u8, e.key, "market")) return .{ .bad = "want args {terms?, market?} only" };
    if (x.get("terms")) |t| if (t != .null) if (checkTerms(t)) |why| return .{ .bad = why };
    if (x.get("market")) |m| if (m != .null) if (checkMarket(m)) |why| return .{ .bad = why };
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.append(a, .{ .key = "kind", .value = .{ .text = defaults_kind } });
    for ([_][]const u8{ "terms", "market" }) |k| {
        const v: ?Value = if (x.get(k)) |n| (if (n == .null) null else n) else if (prev) |p| p.get(k) else null;
        if (v) |vv| try es.append(a, .{ .key = k, .value = vv });
    }
    return .{ .ok = .{ .map = es.items } };
}

/// The `/defaults` answer's JSON: `{terms?, market?}` (`{}` when none is set).
pub fn defaultsJson(a: Allocator, rec: ?Value) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    if (rec) |r| for ([_][]const u8{ "terms", "market" }) |k| if (r.get(k)) |v| {
        try jw.objectField(k);
        try writeJson(&jw, v);
    };
    try jw.endObject();
    return out.written();
}

// ---------------------------------------------------------------- the events

/// `{event: "token-enabled", tokenId, beef, terms?, market?}` (shruggr/skein#164): root's enable as
/// a fact for the host — the deploy's Atomic BEEF (the door's wire bytes) and the defaults at this
/// step (`terms`, `market` when set).
pub fn enabledEvent(a: Allocator, token_id: []const u8, beef_wire: []const u8, defaults: ?Value) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "event", .value = .{ .text = "token-enabled" } },
        .{ .key = "tokenId", .value = .{ .text = token_id } },
        .{ .key = "beef", .value = .{ .bytes = beef_wire } },
    });
    if (defaults) |df| for ([_][]const u8{ "terms", "market" }) |k| if (df.get(k)) |v| if (v == .map) try es.append(a, .{ .key = k, .value = v });
    return .{ .map = es.items };
}

/// `{event: "token-disabled", tokenId}`.
pub fn disabledEvent(a: Allocator, token_id: []const u8) !Value {
    return map(a, &.{
        .{ .key = "event", .value = .{ .text = "token-disabled" } },
        .{ .key = "tokenId", .value = .{ .text = token_id } },
    });
}

/// The row as root's answer shows it: without its `deploy`.
pub fn shown(a: Allocator, row: Value) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    for (row.map) |e| if (!eql(u8, e.key, "deploy")) try es.append(a, e);
    return .{ .map = es.items };
}

// ---------------------------------------------------------------- answers

/// Root's answer: `{fn, request, replyTo, result}`.
pub fn answer(a: Allocator, func: []const u8, message: ?[]const u8, result: Value) !Value {
    return map(a, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = if (message) |m| .{ .cid = m } else .null },
        .{ .key = "replyTo", .value = if (message) |m| .{ .cid = m } else .null },
        .{ .key = "result", .value = result },
    });
}

/// Root's refusal: `{fn, request, replyTo, error: {code, message}}`.
pub fn refusal(a: Allocator, func: []const u8, message: ?[]const u8, code: []const u8, text: []const u8) !Value {
    return map(a, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = if (message) |m| .{ .cid = m } else .null },
        .{ .key = "replyTo", .value = if (message) |m| .{ .cid = m } else .null },
        .{ .key = "error", .value = try map(a, &.{
            .{ .key = "code", .value = .{ .text = code } },
            .{ .key = "message", .value = .{ .text = text } },
        }) },
    });
}

/// A message body that answers a request (`request` or `replyTo` in it): this program's own answer
/// to root, looped back when root's key is the instance's own (a one-key host) — not a request.
pub fn isAnswer(body: Value) bool {
    return body.get("request") != null or body.get("replyTo") != null;
}
