//! The swap app's program `config` (Open Exchange, shruggr/open-exchange#1; skein-amm's amm-config
//! 0.22.0 moved here and CHANGED, shruggr/skein#164): root's decisions recorded as facts under the
//! app's own heads and emitted as events the Open Exchange host reacts to. Nothing is asked of
//! anyone and nothing answers back: no instance manager, no creating/failed states. The decisions
//! are tokens.zig's and discovery.zig's; this file wires them to the VM.
//!
//! **Stepped** (mailbox routes):
//!
//!   box `amm/admin` (kernel.beef; its route's function `configure` gated by the role admin, granted
//!   as `amm.admin` — root passes anything, so the host's key can too; 0.5.0):
//!     {fn: "enable", args: {tokenId, beef?}}   the BEEF (the door checked it and handed the
//!                       envelope; the wire read back, chain.record.wireOf) must be the token id's
//!                       deploy (tokens.zig `deployOf`); `beef` may be left out for a token already
//!                       on the list (its kept `deploy`). The row `enabled` (since now, the BEEF kept
//!                       as `deploy`) and the event `{event: "token-enabled", tokenId, beef, terms?,
//!                       market?}` (the defaults at this step). An enabled token enabled again: the
//!                       same fact again (the host's reaction is idempotent).
//!     {fn: "disable", args: {tokenId}}   a token on the list: the row `disabled`, the event
//!                       `{event: "token-disabled", tokenId}`.
//!     {fn: "terms", args: {tokenId, terms}}   a token on the list (enabled or disabled); `terms`
//!                       `{lpFeeBps, validatorFeeBps, commissionBps, minLegSats?}` (checked as the defaults' are)
//!                       or null (market only): the event `{event: "token-terms", tokenId, terms}`
//!                       (the host sends it to the token instance as root's `terms`); nothing kept
//!                       here: the token instance's `amm/terms` is the record (0.12.0).
//!     {fn: "defaults", args: {terms?, market?}}   the head `amm/defaults` (tokens.zig `withDefaults`).
//!     {fn: "discovery", args: {on}}   the head `amm/discovery` `{on, since}` and the event
//!                       `discovery-on` / `discovery-off` (discovery.zig).
//!     {fn: "price", args: {sats | null}}   (0.15.0) the price to enable a token: the head
//!                       `amm/enable-price` and the event `{event: "enable-price", sats}` (the host, as
//!                       owner, sets the `/enable` route's `price`; null: off) (paid.zig).
//!     {fn: "withdraw"}   (0.15.2; no args) every coin of the instance's wallet paid to the sender
//!                       (BRC-29, a payee key derived for it), by launching the genesis program
//!                       `wallet`: `list`, then ONE noSend `createAction` (the total less the
//!                       builder's fee: no change); kept under `amm/withdrawals` and answered with the
//!                       payment `{n, txid, sats, at, outputIndex, derivationPrefix, derivationSuffix,
//!                       senderIdentityKey, tx}`; nothing to withdraw: refused (paid.zig).
//!   box `amm/claim` (kernel.beef; its function `claim` gated by no role: any sender; claim.zig):
//!     {fn: "claim"}   the first: the head `amm/claim` `{claimant: <the sender>, since}` and the
//!                       event `{event: "claimed", claimant: <hex>}` (the host grants it amm.admin);
//!                       answered `{fn: "claim", result: {claimant: <hex>}}`. A later one: refused
//!                       (`claimed`), nothing written, no event.
//!     Each answered to the sender in that box: `{fn, request, replyTo, result | error}`. A body
//!     that is itself an answer (`request` / `replyTo` in it: this program's answer looped back
//!     when root's key is the instance's own, a one-key host) is not a request: nothing runs.
//!
//! **Called** (read routes; their filters: anyone, nothing logged):
//!
//!   tokens    `/tokens`: the enable list, newest first (tokens.zig `tokensJson`)
//!   defaults  `/defaults`: the defaults, `{terms?, market?, enablePriceSats}` (tokens.zig `defaultsJson`)
//!   discovery `/discovery`: `{on, since}`, or `{on: false}` (discovery.zig `json`)
//!   admin     `/admin`: `{claimant, since}`, or `{}` unclaimed (claim.zig `json`)
//!   serve     `/` (prefix): the Swap pages, www/ of the app's own tree (skein-sdk `files.serve`)
//!
//! **The paid enable** (0.15.0; paid.zig): `POST /enable?tokenId=<txid>_<vout>`, the body the deploy's
//! Atomic BEEF; filters kernel.brc104, kernel.beef, then this app's `enable-check` (fn `enableCheck`:
//! refuses an unpriced route, a token on the list, a BEEF that is not the token's deploy — before
//! kernel.pay asks for money), then kernel.pay; the handler `enablePaid` does what the admin's enable
//! does and keeps `{paidBy, paymentTxid, satoshisPaid}` on the row.
const std = @import("std");
const w = @import("chain");
const vm = @import("overlay_sk");
const tokens = @import("tokens.zig");
const discovery = @import("discovery.zig");
const claim = @import("claim.zig");
const paid = @import("paid.zig");
const wl = @import("wallet");
const ssk = @import("sk");
const app = @import("app");
const files = @import("files");
const scbor = @import("sdk_cbor");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const app_name = "amm";
const app_head = "amm/app";

pub fn main() u8 {
    return vm.main("config", run);
}

fn run(a: Allocator) anyerror!void {
    const in = try vm.input(a);
    if (eql(u8, in.getText("kind") orelse "", "call")) return call(a, in);
    return step(a, in);
}

// ---------------------------------------------------------------- reads

fn isFilter(in: Value) bool {
    const f = in.get("filter") orelse return false;
    return f == .boolean and f.boolean;
}

fn asFilterAnswer(a: Allocator, http: Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "answer", .value = http }}) };
}

fn httpJson(a: Allocator, status: u16, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}

fn headRecord(a: Allocator, name: []const u8) !?Value {
    const c = (try vm.head(a, name)) orelse return null;
    return try vm.store().getValue(a, c);
}

fn call(a: Allocator, in: Value) !void {
    const func = in.getText("fn") orelse return error.BadInput;
    const arg = try vm.callArg(a, in);
    const ans: Value = if (eql(u8, func, "tokens"))
        try httpJson(a, 200, try tokens.tokensJson(a, tokens.rowsOf(try headRecord(a, tokens.tokens_head))))
    else if (eql(u8, func, "defaults"))
        try httpJson(a, 200, try tokens.defaultsJson(a, try headRecord(a, tokens.defaults_head), paid.priceOf(try headRecord(a, paid.price_head))))
    else if (eql(u8, func, "discovery"))
        try httpJson(a, 200, try discovery.json(a, try headRecord(a, discovery.head)))
    else if (eql(u8, func, "admin"))
        try httpJson(a, 200, try claim.json(a, try headRecord(a, claim.head)))
    else if (eql(u8, func, "serve"))
        try servePages(a, arg)
    else if (eql(u8, func, "enableCheck"))
        return vm.answer(a, try enableCheck(a, arg))
    else if (eql(u8, func, "enablePaid"))
        return vm.answer(a, try enablePaid(a, in, arg))
    else
        return error.UnknownFunction;
    return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, ans) else ans);
}

/// The request body's BEEF as the door handed it (its envelope: the wire bytes back), or null: no BEEF.
fn bodyWire(a: Allocator, arg: Value) ?[]const u8 {
    const env = arg.get("body") orelse return null;
    if (env != .map) return null;
    return w.record.wireOf(a, vm.store(), env) catch null;
}

/// The filter `enable-check` (0.15.0): before kernel.pay, the paid enable's refusals (paid.zig `check`).
fn enableCheck(a: Allocator, arg: Value) !Value {
    const price: u64 = if (arg.get("match")) |m| m.getUint("price") orelse 0 else 0;
    const id = try paid.queryTokenId(a, arg.getText("query") orelse "");
    return switch (try paid.check(a, price, tokens.rowsOf(try headRecord(a, tokens.tokens_head)), id, bodyWire(a, arg))) {
        .refused => |r| try paid.rejectAnswer(a, r),
        .ok => try paid.passAnswer(a),
    };
}

/// The handler `enablePaid` (0.15.0): the admin's enable — the row, the event token-enabled with the
/// defaults — and the payment on the row; answered `{fn: "enable", result: <the row>}`.
fn enablePaid(a: Allocator, in: Value, arg: Value) !Value {
    const id = (try paid.queryTokenId(a, arg.getText("query") orelse "")) orelse return httpJson(a, 400, "{\"status\":\"error\",\"code\":\"ERR_BAD_REQUEST\",\"description\":\"want ?tokenId=<txid>_<vout>\"}");
    const pay = arg.get("payment") orelse return httpJson(a, 400, "{\"status\":\"error\",\"code\":\"ERR_PAYMENT_REQUIRED\",\"description\":\"no payment\"}");
    const wire = bodyWire(a, arg) orelse return httpJson(a, 400, "{\"status\":\"error\",\"code\":\"ERR_BAD_DEPLOY\",\"description\":\"want the body: the deploy's Atomic BEEF\"}");
    const d = switch (try tokens.deployOf(a, id, wire)) {
        .refused => |why| return httpJson(a, 400, try std.fmt.allocPrint(a, "{{\"status\":\"error\",\"code\":\"ERR_BAD_DEPLOY\",\"description\":{f}}}", .{std.json.fmt(why, .{})})),
        .ok => |x| x,
    };
    const by = pay.getBytes("sender") orelse arg.getBytes("caller") orelse "";
    if (by.len != 33) return httpJson(a, 400, "{\"status\":\"error\",\"code\":\"ERR_PAYMENT_REQUIRED\",\"description\":\"the payment names no sender\"}");
    const row = try paid.paidRow(a, try tokens.enabledRow(a, d, now(in), arg.get("body").?), by, pay.getText("txid") orelse "", pay.getUint("satoshisPaid") orelse 0);
    try saveRow(a, row);
    _ = try vm.emitEvent(a, try tokens.enabledEvent(a, d.token_id, wire, try headRecord(a, tokens.defaults_head)));
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("fn");
    try jw.write("enable");
    try jw.objectField("result");
    try tokens.writeJson(&jw, try tokens.shown(a, row));
    try jw.endObject();
    return httpJson(a, 200, out.written());
}

fn toSdk(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}

fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}

/// The read `/`: the pages from the app's own tree (the installed app record's `tree`).
fn servePages(a: Allocator, arg: Value) !Value {
    const req = try toSdk(a, arg);
    const m = try app.manifestOf(a, app_name);
    return fromSdk(a, try files.serve(a, req, scbor.Value.cidOf(m.get("tree")), files.rowOptions(req)));
}

// ---------------------------------------------------------------- steps

fn resultRecord(a: Allocator, op: []const u8, fields: []const cbor.Entry) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-config-result" } },
        .{ .key = "op", .value = .{ .text = op } },
    });
    try es.appendSlice(a, fields);
    return .{ .map = es.items };
}

fn step(a: Allocator, in: Value) !void {
    const s = vm.store();
    const args = in.get("args") orelse return error.BadInput;
    const box = args.getText("box") orelse "";
    const body = try s.getValue(a, args.getCid("body") orelse return error.BadInput);
    const is_claim = eql(u8, box, claim.box);
    if (!is_claim and !eql(u8, box, tokens.admin_box)) return error.BadInput;
    if (tokens.isAnswer(body)) {
        _ = try vm.finish(a, s, try resultRecord(a, "answer", &.{}));
        return;
    }
    const func = body.getText("fn") orelse "";
    if (is_claim) {
        if (eql(u8, func, "claim")) return claimSet(a, in, args);
        return answerRoot(a, args, func, try tokens.refusal(a, func, args.getCid("message"), "unknown-fn", "amm/claim takes claim"));
    }
    if (eql(u8, func, "enable")) return enable(a, in, args, body);
    if (eql(u8, func, "disable")) return disable(a, in, args, body);
    if (eql(u8, func, "terms")) return termsSet(a, args, body);
    if (eql(u8, func, "defaults")) return defaults(a, args, body);
    if (eql(u8, func, "discovery")) return discoverySet(a, in, args, body);
    if (eql(u8, func, "price")) return priceSet(a, args, body);
    if (eql(u8, func, "withdraw")) return withdraw(a, in, args, body);
    return answerRoot(a, args, func, try tokens.refusal(a, func, args.getCid("message"), "unknown-fn", "amm/admin takes enable, disable, terms, defaults, discovery, price and withdraw"));
}

/// Answer the message's sender in the box it wrote to; the thread ends.
fn answerRoot(a: Allocator, args: Value, op: []const u8, answer: Value) !void {
    if (answer.get("error")) |e| std.log.err("{s}: refused: {s}", .{ op, e.getText("message") orelse "" });
    if (args.getBytes("sender")) |sender| {
        _ = vm.send(a, sender, args.getText("box") orelse tokens.admin_box, answer) catch |e| std.log.err("{s}: the answer is not sent: {s}", .{ op, @errorName(e) });
    }
    _ = try vm.finish(a, vm.store(), try resultRecord(a, op, &.{.{ .key = "answer", .value = answer }}));
}

fn saveRow(a: Allocator, row: Value) !void {
    const s = vm.store();
    const rec = try tokens.withRow(a, tokens.rowsOf(try headRecord(a, tokens.tokens_head)), row);
    try vm.advance(tokens.tokens_head, try s.putValue(a, rec));
}

fn tokenIdArg(a: Allocator, body: Value) !?[]const u8 {
    const fargs = body.get("args") orelse return null;
    return tokens.canonicalId(a, fargs.getText("tokenId") orelse return null);
}

fn now(in: Value) u64 {
    return in.getUint("at") orelse in.getUint("now") orelse 0;
}

/// `enable {tokenId, beef?}`.
fn enable(a: Allocator, in: Value, args: Value, body: Value) !void {
    const s = vm.store();
    const message = args.getCid("message");
    const id = (try tokenIdArg(a, body)) orelse return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", "want args {tokenId: <txid>_<vout>, beef}"));
    const prev = tokens.find(tokens.rowsOf(try headRecord(a, tokens.tokens_head)), id);
    const fargs = body.get("args").?;
    // The BEEF given, else the one kept on the token's row.
    const env: Value = fargs.get("beef") orelse (if (prev) |p| p.get("deploy") else null) orelse return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", "want args {tokenId, beef}: the deploy's Atomic BEEF"));
    // The door's envelope (shruggr/skein#146: its exact wire bytes back through `wireOf`), or the bytes.
    const wire: []const u8 = switch (env) {
        .bytes => |b| b,
        .map => w.record.wireOf(a, s, env) catch |e| return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", try std.fmt.allocPrint(a, "beef: not a BEEF the door read ({s})", .{@errorName(e)}))),
        else => return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", "beef: want the deploy's Atomic BEEF (bytes)")),
    };
    const d = switch (try tokens.deployOf(a, id, wire)) {
        .refused => |why| return answerRoot(a, args, "enable", try tokens.refusal(a, "enable", message, "bad-args", why)),
        .ok => |x| x,
    };
    const row = try tokens.enabledRow(a, d, now(in), env);
    try saveRow(a, row);
    _ = try vm.emitEvent(a, try tokens.enabledEvent(a, d.token_id, wire, try headRecord(a, tokens.defaults_head)));
    return answerRoot(a, args, "enable", try tokens.answer(a, "enable", message, try tokens.shown(a, row)));
}

/// `disable {tokenId}`.
fn disable(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message");
    const id = (try tokenIdArg(a, body)) orelse return answerRoot(a, args, "disable", try tokens.refusal(a, "disable", message, "bad-args", "want args {tokenId: <txid>_<vout>}"));
    const prev = tokens.find(tokens.rowsOf(try headRecord(a, tokens.tokens_head)), id) orelse return answerRoot(a, args, "disable", try tokens.refusal(a, "disable", message, "bad-args", try std.fmt.allocPrint(a, "{s} is not on the list", .{id})));
    const row = try tokens.updated(a, prev, .disabled, &.{.{ .key = "since", .value = .{ .uint = now(in) } }}, &.{});
    try saveRow(a, row);
    _ = try vm.emitEvent(a, try tokens.disabledEvent(a, id));
    return answerRoot(a, args, "disable", try tokens.answer(a, "disable", message, try tokens.shown(a, row)));
}

/// `terms {tokenId, terms}`: the event only.
fn termsSet(a: Allocator, args: Value, body: Value) !void {
    const message = args.getCid("message");
    switch (try tokens.termsChange(a, tokens.rowsOf(try headRecord(a, tokens.tokens_head)), body.get("args"))) {
        .bad => |why| return answerRoot(a, args, "terms", try tokens.refusal(a, "terms", message, "bad-args", why)),
        .ok => |c| {
            const ev = try tokens.termsEvent(a, c.token_id, c.terms);
            _ = try vm.emitEvent(a, ev);
            return answerRoot(a, args, "terms", try tokens.answer(a, "terms", message, ev));
        },
    }
}

/// `defaults {terms?, market?}`.
fn defaults(a: Allocator, args: Value, body: Value) !void {
    const s = vm.store();
    const message = args.getCid("message");
    switch (try tokens.withDefaults(a, try headRecord(a, tokens.defaults_head), body.get("args"))) {
        .bad => |why| return answerRoot(a, args, "defaults", try tokens.refusal(a, "defaults", message, "bad-args", why)),
        .ok => |rec| {
            try vm.advance(tokens.defaults_head, try s.putValue(a, rec));
            return answerRoot(a, args, "defaults", try tokens.answer(a, "defaults", message, rec));
        },
    }
}

/// `discovery {on}`: the record and the event.
fn discoverySet(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message");
    const on = discovery.onArg(body.get("args")) orelse return answerRoot(a, args, "discovery", try tokens.refusal(a, "discovery", message, "bad-args", "want args {on: true | false}"));
    const rec = try discovery.record(a, on, now(in));
    try vm.advance(discovery.head, try vm.store().putValue(a, rec));
    _ = try vm.emitEvent(a, try discovery.event(a, on));
    return answerRoot(a, args, "discovery", try tokens.answer(a, "discovery", message, rec));
}

/// `price {sats | null}` (0.15.0): the record and the event enable-price.
fn priceSet(a: Allocator, args: Value, body: Value) !void {
    const message = args.getCid("message");
    const sats = switch (paid.priceArg(body.get("args"))) {
        .bad => |why| return answerRoot(a, args, "price", try tokens.refusal(a, "price", message, "bad-args", why)),
        .ok => |n| n,
    };
    const rec = try paid.priceRecord(a, sats);
    try vm.advance(paid.price_head, try vm.store().putValue(a, rec));
    _ = try vm.emitEvent(a, try paid.priceEvent(a, sats));
    return answerRoot(a, args, "price", try tokens.answer(a, "price", message, rec));
}

/// `withdraw` (0.15.2): a BRC-29 payment of every coin of the instance's wallet to the message's sender —
/// the wallet (the genesis program `wallet`) launched twice from this thread: `list`, then one noSend
/// `createAction`; its result (`{txid, tx}`) kept and answered at once.
fn withdraw(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message");
    if (paid.withdrawArgsProblem(body.get("args"))) |why| return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "bad-args", why));
    const sender = args.getBytes("sender") orelse return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "no-sender", "a withdraw is a signed message: its sender is paid"));
    if (sender.len != 33) return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "no-sender", "the sender is not an identity key"));
    const wallet = if (in.get("programs")) |ps| ps.getCid("wallet") else null;
    const prog = wallet orelse return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "no-wallet", "this instance's genesis has no wallet program"));
    const resolved = in.get("resolved") orelse return launchWallet(a, prog, &.{.{ .key = "op", .value = .{ .text = "list" } }}, null);
    const r = resolved.array[0];
    const rec = (try walletResult(a, r)) orelse {
        const why = if (r.get("error")) |e| e.getText("message") orelse "the wallet's step failed" else "the wallet's step failed";
        return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "wallet", why));
    };
    const op = rec.getText("op") orelse "";
    if (eql(u8, op, "list")) {
        var n: u64 = 0;
        for (rec.getArray("outputs") orelse &.{}) |o| if (o.get("spendable")) |sp| if (sp == .boolean and sp.boolean) {
            n += 1;
        };
        const total = rec.getUint("total") orelse 0;
        const rate_text = if (in.get("defaults")) |d| d.getText("walletFeeRate") orelse "100" else "100";
        const rate = std.fmt.parseInt(u64, rate_text, 10) catch 100;
        const fee = paid.feeFor(n, 25, rate);
        if (n == 0 or total <= fee) return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "nothing-to-withdraw", try std.fmt.allocPrint(a, "nothing to withdraw: {d} sats in {d} coins, the fee {d}", .{ total, n, fee })));
        // The payee key, as the wallet's payHost derives a payee's: a fresh prefix and suffix (12 bytes each,
        // base64, from the step's random), BRC-29's key id, counterparty the recipient, from the signer.
        var rnd: [24]u8 = undefined;
        ssk.io().randomSecure(&rnd) catch return error.RandomFailed;
        const enc = std.base64.standard.Encoder;
        const prefix = try a.alloc(u8, enc.calcSize(12));
        const suffix = try a.alloc(u8, enc.calcSize(12));
        _ = enc.encode(prefix, rnd[0..12]);
        _ = enc.encode(suffix, rnd[12..24]);
        const frame = try wl.wire.getPublicKeyFrameFor(a, wl.brc29.security_level, wl.brc29.protocol_name, try wl.brc29.keyId(a, prefix, suffix), .{ .other = sender[0..33].* }, false);
        const payee = try wl.wire.publicKeyResult(try ssk.result(a, ssk.raw.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) }));
        const script = try a.dupe(u8, &wl.brc29.p2pkh(payee));
        const out = Value{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "lockingScript", .value = .{ .bytes = script } },
            .{ .key = "satoshis", .value = .{ .uint = total - fee } },
            .{ .key = "outputDescription", .value = .{ .text = "Open Exchange withdraw" } },
        }) };
        const nth = paid.withdrawalsOf(try headRecord(a, paid.withdrawals_head)).len + 1;
        const opts = Value{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "noSend", .value = .{ .boolean = true } }}) };
        return launchWallet(a, prog, &.{
            .{ .key = "op", .value = .{ .text = "createAction" } },
            .{ .key = "description", .value = .{ .text = try std.fmt.allocPrint(a, "Open Exchange withdraw {d}", .{nth}) } },
            .{ .key = "outputs", .value = .{ .array = try a.dupe(Value, &.{out}) } },
            .{ .key = "options", .value = opts },
        }, .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "derivationPrefix", .value = .{ .text = prefix } },
            .{ .key = "derivationSuffix", .value = .{ .text = suffix } },
        }) });
    }
    if (!eql(u8, op, "createAction")) return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "wallet", try std.fmt.allocPrint(a, "the wallet answered {s}", .{op})));
    // The noSend createAction at rest: its {txid, tx}; the derivation from the launch's own args.
    const txid = rec.getText("txid") orelse "";
    const beef = rec.getBytes("tx") orelse return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "wallet", "the wallet's createAction gave no transaction"));
    const d = (try launchedDerivation(a, r)) orelse return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "wallet", "the withdrawal's derivation is not on its launch"));
    const sats = withdrawnSats(a, beef) orelse return answerRoot(a, args, "withdraw", try tokens.refusal(a, "withdraw", message, "wallet", "the withdrawal's BEEF names no output"));
    const me = vm.selfKey(in) orelse return error.BadInput;
    const x = paid.Withdrawal{ .txid = txid, .sats = sats, .at = now(in), .prefix = d.prefix, .suffix = d.suffix, .sender = try a.dupe(u8, &std.fmt.bytesToHex(me[0..33].*, .lower)), .beef = beef };
    const prev = paid.withdrawalsOf(try headRecord(a, paid.withdrawals_head));
    try vm.advance(paid.withdrawals_head, try vm.store().putValue(a, try paid.withWithdrawal(a, prev, x)));
    return answerRoot(a, args, "withdraw", try tokens.answer(a, "withdraw", message, try paid.withdrawalValue(a, prev.len + 1, x, "tx")));
}

/// The derivation the createAction's launch carried (its args' `withdrawal`), from the resolved thread's origin.
fn launchedDerivation(a: Allocator, resolved: Value) !?struct { prefix: []const u8, suffix: []const u8 } {
    const s = vm.store();
    const origin = try s.getValue(a, resolved.getCid("thread") orelse return null);
    // The kernel keeps a launched thread's args inline in its origin (scheduler.zig hLaunch).
    const largs = origin.get("args") orelse return null;
    const wd = largs.get("withdrawal") orelse return null;
    return .{ .prefix = wd.getText("derivationPrefix") orelse return null, .suffix = wd.getText("derivationSuffix") orelse return null };
}

/// Launch the wallet on `{op, …}` (args `{body: <that record>, withdrawal?}`: the wallet reads `body`; `withdrawal`
/// the payment's derivation, read back from the thread's origin when it rests); this thread waits on it.
fn launchWallet(a: Allocator, prog: []const u8, fields: []const cbor.Entry, withdrawal: ?Value) !void {
    const s = vm.store();
    const body = try s.putValue(a, .{ .map = try a.dupe(cbor.Entry, fields) });
    const args = try s.putValue(a, .{ .map = if (withdrawal) |wd| try a.dupe(cbor.Entry, &.{ .{ .key = "body", .value = .{ .cid = body } }, .{ .key = "withdrawal", .value = wd } }) else try a.dupe(cbor.Entry, &.{.{ .key = "body", .value = .{ .cid = body } }}) });
    _ = try vm.launch(a, prog, args);
}

/// The wallet thread's last result record (its stdout: the record's CID in hex), or null (errored).
fn walletResult(a: Allocator, resolved: Value) !?Value {
    if (!eql(u8, resolved.getText("state") orelse "", "finished")) return null;
    const res = resolved.get("result") orelse return null;
    const out = std.mem.trim(u8, res.getBytes("stdout") orelse return null, " \n");
    const cid = try a.alloc(u8, out.len / 2);
    _ = std.fmt.hexToBytes(cid, out) catch return null;
    return try vm.store().getValue(a, cid);
}

/// Output 0's satoshis of the Atomic BEEF's subject transaction (the withdrawal's one output).
fn withdrawnSats(a: Allocator, beef: []const u8) ?u64 {
    const b = w.beef.parse(a, beef) catch return null;
    const subject = b.atomic orelse return null;
    for (b.entries) |e| if (std.mem.eql(u8, &e.txid, &subject)) {
        const raw = e.raw orelse return null;
        const t = w.bsvz.transaction.Transaction.parse(a, raw) catch return null;
        if (t.outputs.len == 0) return null;
        return @intCast(t.outputs[0].satoshis);
    };
    return null;
}

/// `claim` (box amm/claim, any sender): the first claim recorded and emitted; a later one refused.
fn claimSet(a: Allocator, in: Value, args: Value) !void {
    const message = args.getCid("message");
    const sender = args.getBytes("sender") orelse return answerRoot(a, args, "claim", try tokens.refusal(a, "claim", message, "no-sender", "a claim is a signed message: its sender is the claimant"));
    if (claim.claimantOf(try headRecord(a, claim.head))) |held| {
        return answerRoot(a, args, "claim", try tokens.refusal(a, "claim", message, "claimed", try std.fmt.allocPrint(a, "this exchange is claimed: its admin is {s}", .{try claim.hex(a, held)})));
    }
    try vm.advance(claim.head, try vm.store().putValue(a, try claim.record(a, sender, now(in))));
    _ = try vm.emitEvent(a, try claim.event(a, sender));
    return answerRoot(a, args, "claim", try tokens.answer(a, "claim", message, try claim.result(a, sender)));
}
