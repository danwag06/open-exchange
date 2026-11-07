//! The swap app's decisions, natively (shruggr/open-exchange#1): the deploy check, the enable list's
//! rows and its read, the events, the defaults, the discovery record, and the swap app's manifest.
const std = @import("std");
const w = @import("chain");
const tokens = @import("src/tokens.zig");
const discovery = @import("src/discovery.zig");
const claim = @import("src/claim.zig");
const paid = @import("src/paid.zig");
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
    const dj = try tokens.defaultsJson(a, two, null);
    try testing.expect(std.mem.indexOf(u8, dj, "\"minCommissionBps\":3") != null and std.mem.indexOf(u8, dj, "\"lpFeeBps\":30") != null);
    try testing.expectEqualStrings("{\"enablePriceSats\":null}", try tokens.defaultsJson(a, null, null));
    try testing.expectEqualStrings("{\"enablePriceSats\":2500}", try tokens.defaultsJson(a, null, 2500));
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
    // iconUrl = the discovery icon route; no data URL, stored (none since 0.11.0) or read.
    try testing.expect(std.mem.indexOf(u8, json, "\"iconUrl\":\"/@discovery/1color/aa_0/icon\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"iconUrl\":\"/@discovery/1color/bb_0/icon\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "data:") == null);
    try testing.expect(tokens.find(tokens.rowsOf(rec), "bb_0").?.get("icon") == null);
    // A row stored before 0.11.0 with a data-URL icon reads without it.
    const old = try tokens.updated(a, off, .disabled, &.{.{ .key = "icon", .value = .{ .text = "data:image/png;base64,AA==" } }}, &.{});
    const oldJson = try tokens.tokensJson(a, &.{old});
    try testing.expect(std.mem.indexOf(u8, oldJson, "data:") == null and std.mem.indexOf(u8, oldJson, "\"iconUrl\"") != null);
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

test "terms: a token on the list → the event token-terms {tokenId, terms}; null = market only; unknown token or bad terms refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const tid = "ab" ** 32;
    const id = tid ++ "_0";
    const d: tokens.Deploy = .{ .token_id = id, .topic = "tm_color_" ++ id, .lookup = "ls_color_" ++ id };
    const rec = try tokens.withRow(a, &.{}, try tokens.enabledRow(a, d, 100, .{ .bytes = "BEEF" }));
    const rows = tokens.rowsOf(rec);
    const good = (try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":{\"lpFeeBps\":40,\"validatorFeeBps\":6,\"commissionBps\":2}}"))).ok;
    const ev = try tokens.termsEvent(a, good.token_id, good.terms);
    try testing.expectEqualStrings("token-terms", ev.getText("event").?);
    try testing.expectEqualStrings(id, ev.getText("tokenId").?);
    try testing.expectEqual(@as(u64, 40), ev.get("terms").?.getUint("lpFeeBps").?);
    try testing.expectEqual(@as(u64, 6), ev.get("terms").?.getUint("validatorFeeBps").?);
    try testing.expectEqual(@as(u64, 2), ev.get("terms").?.getUint("commissionBps").?);
    try testing.expectEqual(@as(usize, 3), ev.map.len);
    // Any id form names the listed token.
    const dotted = (try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ tid ++ ".0\",\"terms\":null}"))).ok;
    try testing.expectEqualStrings(id, dotted.token_id);
    const mo = try tokens.termsEvent(a, dotted.token_id, dotted.terms);
    try testing.expect(mo.get("terms").? == .null);
    // A disabled token is still on the list.
    const off = try tokens.withRow(a, rows, try tokens.updated(a, tokens.find(rows, id).?, .disabled, &.{}, &.{}));
    try testing.expect((try tokens.termsChange(a, tokens.rowsOf(off), try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":null}"))) == .ok);
    // Refused: a token not on the list, bad terms, no terms, other keys.
    const unknown = try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ "cd" ** 32 ++ "_0\",\"terms\":null}"));
    try testing.expect(unknown == .bad and std.mem.indexOf(u8, unknown.bad, "not on the list") != null);
    try testing.expect((try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":{\"lpFeeBps\":40}}"))) == .bad);
    try testing.expect((try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":{\"lpFeeBps\":40,\"validatorFeeBps\":6,\"commissionBps\":10001}}"))) == .bad);
    try testing.expect((try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\"}"))) == .bad);
    try testing.expect((try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":null,\"market\":null}"))) == .bad);
    try testing.expect((try tokens.termsChange(a, rows, null)) == .bad);
}

test "minLegSats (0.14.0): optional in the defaults and a token's terms, carried in the events and the /defaults read; not an integer refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const df = (try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"terms\":{\"lpFeeBps\":30,\"validatorFeeBps\":5,\"commissionBps\":25,\"minLegSats\":10000}}"))).ok;
    try testing.expectEqual(@as(u64, 10000), df.get("terms").?.getUint("minLegSats").?);
    try testing.expect(std.mem.indexOf(u8, try tokens.defaultsJson(a, df, null), "\"minLegSats\":10000") != null);
    const ev = try tokens.enabledEvent(a, "aa_0", "BEEF", df);
    try testing.expectEqual(@as(u64, 10000), ev.get("terms").?.getUint("minLegSats").?);
    try testing.expect((try tokens.withDefaults(a, null, try dagjsonValue(a, "{\"terms\":{\"lpFeeBps\":30,\"validatorFeeBps\":5,\"commissionBps\":25,\"minLegSats\":\"x\"}}"))) == .bad);
    const tid = "ab" ** 32;
    const id = tid ++ "_0";
    const d: tokens.Deploy = .{ .token_id = id, .topic = "tm_color_" ++ id, .lookup = "ls_color_" ++ id };
    const rows = tokens.rowsOf(try tokens.withRow(a, &.{}, try tokens.enabledRow(a, d, 100, .{ .bytes = "BEEF" })));
    const good = (try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":{\"lpFeeBps\":40,\"validatorFeeBps\":6,\"commissionBps\":2,\"minLegSats\":0}}"))).ok;
    const te = try tokens.termsEvent(a, good.token_id, good.terms);
    try testing.expectEqual(@as(u64, 0), te.get("terms").?.getUint("minLegSats").?);
    try testing.expect((try tokens.termsChange(a, rows, try dagjsonValue(a, "{\"tokenId\":\"" ++ id ++ "\",\"terms\":{\"lpFeeBps\":40,\"validatorFeeBps\":6,\"commissionBps\":2,\"minLeg\":1}}"))) == .bad);
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
    try testing.expectEqualStrings("0.17.1", scbor.Value.str(m.get("version")).?);
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
        // 0.15.3: the paid enable's payment to the wallet, from the instance itself.
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "pay")) {
            try testing.expectEqualStrings("kernel.beef", scbor.Value.str(r.get("filters").?.array[0]).?);
            try testing.expectEqualStrings("config.pay", scbor.Value.str(r.get("handler")).?);
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
        // 0.15.3: the paid enable — a BEEF submission: kernel.brc104, kernel.beef, enable-check; the handler enablePaid.
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/enable")) {
            const fs = r.get("filters").?.array;
            try testing.expectEqual(@as(usize, 3), fs.len);
            for ([_][]const u8{ "kernel.brc104", "kernel.beef", "enable-check" }, fs) |want, f| try testing.expectEqualStrings(want, scbor.Value.str(f).?);
            try testing.expectEqualStrings("config.enablePaid", scbor.Value.str(r.get("handler")).?);
            try testing.expect(r.get("price") == null); // the host sets it, from the admin's price
            seen |= 128;
        }
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/discovery")) {
            try testing.expectEqualStrings("discovery", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen |= 64;
        }
    }
    try testing.expectEqual(@as(u8, 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128), seen);
    try testing.expectEqualStrings("config.enableCheck", scbor.Value.str(m.get("filters").?.get("enable-check")).?);
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

test "the paid enable (0.15.3): one BEEF with the deploy and the payment; enable-check refuses in order — off, no token id, on the list, no deploy, no payment named or not in it (402), under the price (402), replayed (409); else passes with the deploy's own Atomic BEEF; the row keeps the payment" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const raw = unhex(a, vec.token_deploy);
    const fund = unhex(a, vec.fund);
    const dtx = w.beef.txidOf(raw);
    const ptx = w.beef.txidOf(fund);
    const txid = try displayHex(a, dtx);
    const ptxid = try displayHex(a, ptx);
    var entries = [_]w.beef.Entry{ .{ .txid = dtx, .format = .raw, .raw = raw }, .{ .txid = ptx, .format = .raw, .raw = fund } };
    const bundle = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = &entries });
    const id = try std.fmt.allocPrint(a, "{s}_0", .{txid});
    const sats = (try paid.outputIn(a, bundle, ptx, 0)).?.satoshis;
    const q = try std.fmt.allocPrint(a, "?tokenId={s}&paymentTxid={s}&paymentVout=0&derivationPrefix=cHJl%2Bx%3D%3D&derivationSuffix=c3Vm", .{ id, ptxid });
    // The query: the token id in any form; the payment named, percent-decoded.
    try testing.expectEqualStrings(id, (try paid.queryTokenId(a, try std.fmt.allocPrint(a, "?x=1&tokenId={s}.0", .{txid}))).?);
    const named = (try paid.queryPayment(a, q)).?;
    try testing.expectEqualStrings("cHJl+x==", named.prefix);
    try testing.expectEqual(@as(u32, 0), named.vout);
    try testing.expect((try paid.queryPayment(a, try std.fmt.allocPrint(a, "?tokenId={s}", .{id}))) == null);
    // Off, whatever else.
    try testing.expectEqualStrings("ERR_PAID_ENABLE_OFF", (try paid.check(a, null, &.{}, q, bundle, false)).refused.code);
    // Passes: the deploy, the payment, the deploy's own Atomic BEEF (its subject the deploy).
    const ok = (try paid.check(a, sats, &.{}, q, bundle, false)).ok;
    try testing.expectEqualStrings(id, ok.deploy.token_id);
    try testing.expectEqualSlices(u8, &ptx, &ok.payment.txid);
    try testing.expect((try tokens.deployOf(a, id, ok.deploy_beef)) == .ok);
    try testing.expect((try tokens.deployOf(a, id, bundle)) == .refused); // the bundle's own subject is its last transaction
    // No token id; no BEEF; another token's id (its deploy is not in the BEEF).
    try testing.expectEqual(@as(u16, 400), (try paid.check(a, sats, &.{}, "?paymentTxid=00", bundle, false)).refused.status);
    try testing.expectEqualStrings("ERR_BAD_DEPLOY", (try paid.check(a, sats, &.{}, q, null, false)).refused.code);
    const other = try std.fmt.allocPrint(a, "?tokenId={s}_0&paymentTxid={s}&paymentVout=0&derivationPrefix=p&derivationSuffix=s", .{ "ab" ** 32, ptxid });
    try testing.expectEqualStrings("ERR_BAD_DEPLOY", (try paid.check(a, sats, &.{}, other, bundle, false)).refused.code);
    // On the list: 409 enabled; disabled by the admin: 409 disabled.
    const row = try tokens.enabledRow(a, ok.deploy, 7, .{ .bytes = ok.deploy_beef });
    try testing.expectEqualStrings("ERR_TOKEN_ENABLED", (try paid.check(a, sats, &.{row}, q, bundle, false)).refused.code);
    try testing.expectEqualStrings("ERR_TOKEN_DISABLED", (try paid.check(a, sats, &.{try tokens.updated(a, row, .disabled, &.{}, &.{})}, q, bundle, false)).refused.code);
    // No payment named; the named output not in the BEEF: 402 with the price.
    const none = (try paid.check(a, sats, &.{}, try std.fmt.allocPrint(a, "?tokenId={s}", .{id}), bundle, false)).refused;
    try testing.expectEqual(@as(u16, 402), none.status);
    try testing.expectEqualStrings("ERR_PAYMENT_REQUIRED", none.code);
    try testing.expectEqual(@as(?u64, sats), none.satoshis_required);
    const absent = try std.fmt.allocPrint(a, "?tokenId={s}&paymentTxid={s}&paymentVout=0&derivationPrefix=p&derivationSuffix=s", .{ id, "cd" ** 32 });
    try testing.expectEqualStrings("ERR_PAYMENT_REQUIRED", (try paid.check(a, sats, &.{}, absent, bundle, false)).refused.code);
    // Under the price: 402 too small; replayed: 409.
    const small = (try paid.check(a, sats + 1, &.{}, q, bundle, false)).refused;
    try testing.expectEqual(@as(u16, 402), small.status);
    try testing.expectEqualStrings("ERR_PAYMENT_TOO_SMALL", small.code);
    try testing.expectEqualStrings("ERR_PAYMENT_REPLAYED", (try paid.check(a, sats, &.{}, q, bundle, true)).refused.code);
    // The 402 answer carries satoshisRequired.
    const ans = try paid.rejectAnswer(a, none);
    try testing.expect(std.mem.indexOf(u8, ans.get("answer").?.getBytes("body").?, "\"satoshisRequired\"") != null);
    // The paid row: the enable's row and the payment; never the deploy in the read.
    const payer = [_]u8{0x02} ++ [_]u8{0x11} ** 32;
    const pr = try paid.paidRow(a, row, &payer, ptxid, sats);
    try testing.expectEqualStrings("02" ++ "11" ** 32, pr.getText("paidBy").?);
    const js = try tokens.tokensJson(a, &.{pr});
    try testing.expect(std.mem.indexOf(u8, js, "\"paymentTxid\"") != null and std.mem.indexOf(u8, js, "\"deploy\"") == null);
}

test "the payment's own BEEF (0.15.4): cut from a bundle whose entries are not parents first — the payment and its ancestry only, the unrelated deploy dropped, written parents first, Atomic on the payment" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const pay = unhex(a, vec.pool_deploy); // spends the fixtures' deploy and funding
    const p1 = unhex(a, vec.fund);
    const p2 = unhex(a, vec.token_deploy);
    const other = unhex(a, vec.legacy_deploy0);
    const pt = w.beef.txidOf(pay);
    var entries = [_]w.beef.Entry{
        .{ .txid = pt, .format = .raw, .raw = pay },
        .{ .txid = w.beef.txidOf(other), .format = .raw, .raw = other },
        .{ .txid = w.beef.txidOf(p1), .format = .raw, .raw = p1 },
        .{ .txid = w.beef.txidOf(p2), .format = .raw, .raw = p2 },
    };
    const bundle = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = &entries });
    try testing.expect(!w.beef.parentsFirst(try w.beef.parse(a, bundle)));
    const cut = try w.beef.parse(a, try paid.cutFor(a, bundle, pt));
    try testing.expectEqualSlices(u8, &pt, &cut.atomic.?);
    try testing.expectEqual(@as(usize, 3), cut.entries.len);
    try testing.expect(cut.find(w.beef.txidOf(other)) == null);
    try testing.expect(w.beef.parentsFirst(cut));
    try testing.expectEqualSlices(u8, &pt, &cut.entries[2].txid);
}

test "price and withdraw (0.15.0): price {sats | null} → the record (0.15.3: no event); withdraw takes no args; the kept withdrawals and the answer (the payment's derivation and sender); the builder's fee" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqual(@as(?u64, 2500), (paid.priceArg(try dagjsonValue(a, "{\"sats\":2500}"))).ok);
    try testing.expectEqual(@as(?u64, null), (paid.priceArg(try dagjsonValue(a, "{\"sats\":null}"))).ok);
    try testing.expect(paid.priceArg(try dagjsonValue(a, "{\"sats\":0}")) == .bad);
    try testing.expect(paid.priceArg(try dagjsonValue(a, "{\"sats\":\"5\"}")) == .bad);
    try testing.expect(paid.priceArg(try dagjsonValue(a, "{}")) == .bad);
    try testing.expectEqual(@as(?u64, 2500), paid.priceOf(try paid.priceRecord(a, 2500)));
    try testing.expectEqual(@as(?u64, null), paid.priceOf(try paid.priceRecord(a, null)));
    try testing.expectEqual(@as(?u64, null), paid.priceOf(null));
    // withdraw takes no args (the payment goes to the message's sender).
    try testing.expect(paid.withdrawArgsProblem(null) == null);
    try testing.expect(paid.withdrawArgsProblem(try dagjsonValue(a, "{}")) == null);
    try testing.expect(paid.withdrawArgsProblem(try dagjsonValue(a, "{\"lockingScript\":\"76a9\"}")) != null);
    // The kept withdrawals: n counts from 1; the record keeps the BEEF as `beef`, the answer gives it as `tx`.
    const x1 = paid.Withdrawal{ .txid = "aa" ** 32, .sats = 1500, .at = 7, .prefix = "cHJl", .suffix = "c3Vm", .sender = "02" ++ "33" ** 32, .beef = "BEEF1" };
    const w1 = try paid.withWithdrawal(a, paid.withdrawalsOf(null), x1);
    const w2 = try paid.withWithdrawal(a, paid.withdrawalsOf(w1), .{ .txid = "bb" ** 32, .sats = 900, .at = 9, .prefix = "p2", .suffix = "s2", .sender = x1.sender, .beef = "BEEF2" });
    const ws2 = paid.withdrawalsOf(w2);
    try testing.expectEqual(@as(usize, 2), ws2.len);
    try testing.expectEqual(@as(u64, 1), ws2[0].getUint("n").?);
    try testing.expectEqual(@as(u64, 2), ws2[1].getUint("n").?);
    try testing.expectEqual(@as(u64, 0), ws2[0].getUint("outputIndex").?);
    try testing.expectEqualStrings("cHJl", ws2[0].getText("derivationPrefix").?);
    try testing.expectEqualStrings("c3Vm", ws2[0].getText("derivationSuffix").?);
    try testing.expectEqualStrings(x1.sender, ws2[0].getText("senderIdentityKey").?);
    try testing.expectEqualStrings("BEEF2", ws2[1].getBytes("beef").?);
    const ans = try paid.withdrawalValue(a, 1, x1, "tx");
    try testing.expectEqualStrings("BEEF1", ans.getBytes("tx").?);
    try testing.expect(ans.get("beef") == null);
    // The builder's fee (skein-sdk builder.zig estimateFeeFor at 100 sat/kB): one coin, a 25-byte script: 226 bytes → 23 sats.
    try testing.expectEqual(@as(u64, 23), paid.feeFor(1, 25, 100));
    try testing.expectEqual(@as(u64, 38), paid.feeFor(2, 25, 100));
}
