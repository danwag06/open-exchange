//! The swap app's decisions, natively (shruggr/open-exchange#1): the deploy check, the enable list's
//! rows and its read, the events, the defaults, the discovery record, and the swap app's manifest.
const std = @import("std");
const w = @import("chain");
const tokens = @import("src/tokens.zig");
const discovery = @import("src/discovery.zig");
const claim = @import("src/claim.zig");
const vec = @import("vectors");
const dagjson = @import("dagjson");
const scbor = @import("sdk_cbor");
const config_manifest = @import("swap_manifest").json;

const testing = std.testing;
const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;

fn unhex(a: Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

/// An Atomic BEEF of one raw transaction (no proof: the door's business, not this check's).
fn atomic(a: Allocator, raw: []const u8) ![]u8 {
    const txid = w.beef.txidOf(raw);
    var entries = [_]w.beef.Entry{.{ .txid = txid, .format = .raw, .raw = raw }};
    return w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = txid, .bumps = &.{}, .entries = &entries });
}

fn displayHex(a: Allocator, txid: [32]u8) ![]const u8 {
    return a.dupe(u8, &w.header.toHex(txid));
}

test "the deploy check: the BEEF's subject is the token id's transaction and its output a deploy; else refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = unhex(a, vec.token_deploy);
    const txid = try displayHex(a, w.beef.txidOf(raw));
    const beef = try atomic(a, raw);
    const id = try std.fmt.allocPrint(a, "{s}_0", .{txid});
    const ok = try tokens.deployOf(a, id, beef);
    try testing.expect(ok == .ok);
    try testing.expectEqualStrings(id, ok.ok.token_id);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_color_{s}_0", .{txid}), ok.ok.topic);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "ls_color_{s}_0", .{txid}), ok.ok.lookup);
    // Any id form: the canonical text.
    try testing.expectEqualStrings(id, (try tokens.canonicalId(a, txid)).?);
    try testing.expectEqualStrings(id, (try tokens.canonicalId(a, try std.fmt.allocPrint(a, "{s}.0", .{txid}))).?);
    try testing.expect((try tokens.canonicalId(a, "abc")) == null);
    // Another transaction's id: refused.
    const other = try std.fmt.allocPrint(a, "{s}_0", .{"ab" ** 32});
    try testing.expect((try tokens.deployOf(a, other, beef)) == .refused);
    // No such output.
    try testing.expect((try tokens.deployOf(a, try std.fmt.allocPrint(a, "{s}_7", .{txid}), beef)) == .refused);
    // Not a deploy: the funding transaction's output.
    const fund = unhex(a, vec.fund);
    const fbeef = try atomic(a, fund);
    const fid = try std.fmt.allocPrint(a, "{s}_0", .{try displayHex(a, w.beef.txidOf(fund))});
    const nd = try tokens.deployOf(a, fid, fbeef);
    try testing.expect(nd == .refused);
    // Not a BEEF.
    try testing.expect((try tokens.deployOf(a, id, "junk")) == .refused);
    // A BRC-161 deploy at another output: legacy_deploy1's output 1? (its deploy is where the vectors put it)
    const l1 = unhex(a, vec.legacy_deploy0);
    const l1id = try std.fmt.allocPrint(a, "{s}_0", .{try displayHex(a, w.beef.txidOf(l1))});
    try testing.expect((try tokens.deployOf(a, l1id, try atomic(a, l1))) == .ok);
}

fn dagjsonValue(a: Allocator, text: []const u8) !Value {
    return cbor.decode(a, try scbor.encode(a, try dagjson.decode(a, text)));
}

test "the defaults: partial, null clears one, a bad shape refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const one = (try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"market\":{\"minCommissionBps\":3}}"))).ok;
    try testing.expect(one.get("terms") == null);
    const two = (try tokens.withDefaults(a, one, try dagjsonValue(a, "{\"terms\":{\"lpFeeBps\":30,\"validatorFeeBps\":5,\"commissionBps\":0}}"))).ok;
    try testing.expectEqual(@as(u64, 3), two.get("market").?.getUint("minCommissionBps").?);
    try testing.expectEqual(@as(u64, 30), two.get("terms").?.getUint("lpFeeBps").?);
    const dj = try tokens.defaultsJson(a, two);
    try testing.expect(std.mem.indexOf(u8, dj, "\"minCommissionBps\":3") != null and std.mem.indexOf(u8, dj, "\"lpFeeBps\":30") != null);
    try testing.expectEqualStrings("{}", try tokens.defaultsJson(a, null));
    const three = (try tokens.withDefaults(a, two, try dagjsonValue(a, "{\"market\":null}"))).ok;
    try testing.expect(three.get("market") == null and three.get("terms") != null);
    try testing.expect((try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"terms\":{\"lpFeeBps\":30}}"))) == .bad);
    try testing.expect((try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"terms\":{\"lpFeeBps\":30,\"validatorFeeBps\":5,\"commissionBps\":20000}}"))) == .bad);
    try testing.expect((try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"other\":1}"))) == .bad);
    try testing.expect((try tokens.withDefaults(a, null, null)) == .bad);
}

test "the enable list: enabled (the BEEF kept as deploy, never read out) or disabled; newest first" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const d1: tokens.Deploy = .{ .token_id = "aa_0", .topic = "tm_color_aa_0", .lookup = "ls_color_aa_0", .sym = "A", .dec = 2 };
    const d2: tokens.Deploy = .{ .token_id = "bb_0", .topic = "tm_color_bb_0", .lookup = "ls_color_bb_0", .icon = "data:image/png;base64,AA==" };
    var rec = try tokens.withRow(a, &.{}, try tokens.enabledRow(a, d1, 100, .{ .bytes = "BEEF1" }));
    rec = try tokens.withRow(a, tokens.rowsOf(rec), try tokens.enabledRow(a, d2, 200, .{ .bytes = "BEEF2" }));
    try testing.expectEqual(@as(usize, 2), tokens.rowsOf(rec).len);
    const r1 = tokens.find(tokens.rowsOf(rec), "aa_0").?;
    try testing.expectEqual(tokens.Status.enabled, tokens.statusOf(r1).?);
    try testing.expectEqualStrings("BEEF1", r1.getBytes("deploy").?);
    // Disabled: the status and since change, the deploy is kept (an enable again needs no BEEF).
    const off = try tokens.updated(a, r1, .disabled, &.{.{ .key = "since", .value = .{ .uint = 300 } }}, &.{});
    try testing.expectEqual(tokens.Status.disabled, tokens.statusOf(off).?);
    try testing.expectEqual(@as(u64, 300), off.getUint("since").?);
    try testing.expectEqualStrings("BEEF1", off.getBytes("deploy").?);
    rec = try tokens.withRow(a, tokens.rowsOf(rec), off);
    try testing.expectEqual(@as(usize, 2), tokens.rowsOf(rec).len);
    const json = try tokens.tokensJson(a, tokens.rowsOf(rec));
    // Newest first: aa_0 (300) before bb_0 (200).
    try testing.expect(std.mem.indexOf(u8, json, "\"aa_0\"").? < std.mem.indexOf(u8, json, "\"bb_0\"").?);
    try testing.expect(std.mem.indexOf(u8, json, "\"status\":\"disabled\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"status\":\"enabled\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "deploy") == null);
    try testing.expect(std.mem.indexOf(u8, json, "url") == null);
    try testing.expect(std.mem.indexOf(u8, json, "\"since\":300") != null);
    try testing.expect((try tokens.shown(a, off)).get("deploy") == null);
    try testing.expect(std.meta.stringToEnum(tokens.Status, "creating") == null and std.meta.stringToEnum(tokens.Status, "failed") == null);
}

test "the events: token-enabled {tokenId, beef, terms?, market?} (the defaults at the step); token-disabled {tokenId}" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const plain = try tokens.enabledEvent(a, "aa_0", "BEEF", null);
    try testing.expectEqualStrings("token-enabled", plain.getText("event").?);
    try testing.expectEqualStrings("aa_0", plain.getText("tokenId").?);
    try testing.expectEqualStrings("BEEF", plain.getBytes("beef").?);
    try testing.expectEqual(@as(usize, 3), plain.map.len);
    const df = (try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"terms\":{\"lpFeeBps\":30,\"validatorFeeBps\":5,\"commissionBps\":25},\"market\":{\"minCommissionBps\":1}}"))).ok;
    const with = try tokens.enabledEvent(a, "aa_0", "BEEF", df);
    try testing.expectEqual(@as(u64, 25), with.get("terms").?.getUint("commissionBps").?);
    try testing.expectEqual(@as(u64, 1), with.get("market").?.getUint("minCommissionBps").?);
    try testing.expect(with.get("kind") == null and with.get("app") == null);
    const only = (try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"market\":{\"minCommissionBps\":2}}"))).ok;
    const m = try tokens.enabledEvent(a, "aa_0", "BEEF", only);
    try testing.expect(m.get("terms") == null and m.get("market") != null);
    const off = try tokens.disabledEvent(a, "aa_0");
    try testing.expectEqualStrings("token-disabled", off.getText("event").?);
    try testing.expectEqualStrings("aa_0", off.getText("tokenId").?);
    try testing.expectEqual(@as(usize, 2), off.map.len);
}

test "answers: a body naming its request is an answer, not a request" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const msg = &w.store.hashCid(.tx, .{1} ** 32);
    const ans = try tokens.answer(a, "enable", msg, .null);
    try testing.expect(tokens.isAnswer(ans));
    try testing.expect(tokens.isAnswer(try tokens.refusal(a, "enable", msg, "bad-args", "no")));
    try testing.expect(!tokens.isAnswer(try dagjsonValue(a, "{\"fn\":\"enable\",\"args\":{\"tokenId\":\"x\"}}")));
}

test "the swap app's manifest: amm 0.5.0; the role admin gates configure (box amm/admin), claim open (box amm/claim); the reads incl. /admin; the pages; no manager" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try dagjson.decode(a, config_manifest);
    try testing.expectEqualStrings("amm", scbor.Value.str(m.get("name")).?);
    try testing.expectEqualStrings("0.7.0", scbor.Value.str(m.get("version")).?);
    // 0.5.0: the kernel's gate judges a route's function, so the box amm/admin's route names one
    // (`configure`, every fn in that box) and the role admin gates it; root is not listed (root passes
    // anything); claim is listed in no role.
    const roles = m.get("roles").?;
    try testing.expectEqual(@as(usize, 1), roles.map.len);
    const adm = roles.get("admin").?.array;
    try testing.expectEqual(@as(usize, 1), adm.len);
    try testing.expectEqualStrings("configure", scbor.Value.str(adm[0]).?);
    try testing.expect(roles.get("root") == null);
    try testing.expect(m.get("config") == null); // no token image: the host's images are its own
    try testing.expectEqualStrings("chain/1", scbor.Value.str(m.get("requires").?.array[0]).?);
    // Only its own program: no token programs in this tree.
    try testing.expectEqual(@as(usize, 1), m.get("programs").?.map.len);
    var seen: u8 = 0;
    for (m.get("routes").?.array) |r| {
        const t = scbor.Value.str(r.get("transport")) orelse "mailbox";
        const addr = scbor.Value.str(r.get("address")).?;
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "admin")) {
            try testing.expectEqualStrings("kernel.beef", scbor.Value.str(r.get("filters").?.array[0]).?);
            try testing.expectEqualStrings("config.configure", scbor.Value.str(r.get("handler")).?);
            seen |= 1;
        }
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "claim")) {
            try testing.expectEqualStrings("config.claim", scbor.Value.str(r.get("handler")).?);
            seen |= 2;
        }
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/admin")) {
            try testing.expectEqualStrings("admin", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen |= 8;
        }
        // 0.19.0: no listing requests (the box amm/requests and /requests are gone).
        try testing.expect(!std.mem.eql(u8, addr, "requests") and !std.mem.eql(u8, addr, "/requests"));
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/tokens")) seen |= 4;
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/")) seen |= 16;
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/defaults")) seen |= 32;
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/discovery")) {
            try testing.expectEqualStrings("discovery", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen |= 64;
        }
    }
    try testing.expectEqual(@as(u8, 1 | 2 | 4 | 8 | 16 | 32 | 64), seen);
    try testing.expectEqualStrings("config.admin", scbor.Value.str(m.get("filters").?.get("admin")).?);
    try testing.expect(m.get("filters").?.get("requests") == null);
    try testing.expectEqualStrings("config.discovery", scbor.Value.str(m.get("filters").?.get("discovery")).?);
    try testing.expectEqualStrings(tokens.admin_box, "amm/admin");
}

test "discovery: {on} → the record {on, since} and the event discovery-on / discovery-off; the read" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("{\"on\":false}", try discovery.json(a, null));
    try testing.expect(discovery.onArg(try dagjsonValue(a, "{\"on\":true}")).?);
    try testing.expect(!discovery.onArg(try dagjsonValue(a, "{\"on\":false}")).?);
    try testing.expect(discovery.onArg(try dagjsonValue(a, "{\"on\":1}")) == null);
    try testing.expect(discovery.onArg(null) == null);
    const on = try discovery.record(a, true, 100);
    try testing.expectEqualStrings("{\"on\":true,\"since\":100}", try discovery.json(a, on));
    try testing.expectEqualStrings("{\"on\":false,\"since\":200}", try discovery.json(a, try discovery.record(a, false, 200)));
    try testing.expectEqualStrings("discovery-on", (try discovery.event(a, true)).getText("event").?);
    try testing.expectEqualStrings("discovery-off", (try discovery.event(a, false)).getText("event").?);
    try testing.expectEqual(@as(usize, 1), (try discovery.event(a, true)).map.len);
    try testing.expectEqualStrings(discovery.head, "amm/discovery");
}

test "the claim: the first one recorded {claimant, since} and the event claimed {claimant: hex}; /admin; a claimed record names its admin" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("{}", try claim.json(a, null));
    try testing.expect(claim.claimantOf(null) == null);
    try testing.expect(claim.claimantOf(try discovery.record(a, true, 1)) == null);
    const key = [_]u8{0x02} ++ [_]u8{0xab} ** 32;
    const khex = "02" ++ "ab" ** 32;
    const rec = try claim.record(a, &key, 500);
    try testing.expectEqualSlices(u8, &key, claim.claimantOf(rec).?);
    try testing.expectEqualStrings("{\"claimant\":\"" ++ khex ++ "\",\"since\":500}", try claim.json(a, rec));
    const ev = try claim.event(a, &key);
    try testing.expectEqualStrings("claimed", ev.getText("event").?);
    try testing.expectEqualStrings(khex, ev.getText("claimant").?);
    try testing.expectEqual(@as(usize, 2), ev.map.len);
    try testing.expectEqualStrings(khex, (try claim.result(a, &key)).getText("claimant").?);
    try testing.expectEqualStrings(claim.head, "amm/claim");
    try testing.expectEqualStrings(claim.box, "amm/claim");
    // The answer to a claim is an answer (an own answer looped back runs nothing).
    try testing.expect(tokens.isAnswer(try tokens.answer(a, "claim", &w.store.hashCid(.tx, .{2} ** 32), try claim.result(a, &key))));
}
