//! The claim (Open Exchange 0.5.0, David 2026-11-02: "The end user, the one connecting with their
//! wallet, is the one who is able to configure and enable. The host is the host."), pure: main.zig
//! wires the VM.
//!
//! swap is born owned by the host's key (root). An install cannot know the user's key ahead of time,
//! so the first wallet to claim on Settings is that user: its claim is recorded here as a fact and
//! emitted as the event `claimed`; the Open Exchange host reacts by granting it the role `amm.admin`
//! (the role that gates the box `amm/admin`'s functions). The claimant is not root.
//!
//! - **The record**, the root of the head `amm/claim`: `{kind: "amm-claim", claimant: <key bytes>,
//!   since}`. No record: unclaimed.
//! - **The message** `{fn: "claim"}` in the box `amm/claim` (open: any sender): the first one writes
//!   the record and emits `{event: "claimed", claimant: <key hex>}`; a later one is refused (no
//!   write, no event).
//! - **The read** `/admin`: `{claimant: <hex>, since}`, or `{}` unclaimed.
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const head = "amm/claim";
pub const kind = "amm-claim";
/// The claim's box: `amm/claim` (the manifest's mailbox route `claim`, gated by no role).
pub const box = "amm/claim";

/// A key's lowercase hex.
pub fn hex(a: Allocator, key: []const u8) ![]const u8 {
    const out = try a.alloc(u8, key.len * 2);
    const digits = "0123456789abcdef";
    for (key, 0..) |b, i| {
        out[2 * i] = digits[b >> 4];
        out[2 * i + 1] = digits[b & 15];
    }
    return out;
}

/// The claimant's key bytes in a record, or null (no record, or not a claim record).
pub fn claimantOf(rec: ?Value) ?[]const u8 {
    const r = rec orelse return null;
    if (!eql(u8, r.getText("kind") orelse "", kind)) return null;
    return r.getBytes("claimant");
}

/// The record: `{kind, claimant, since}`.
pub fn record(a: Allocator, claimant: []const u8, at: u64) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = kind } },
        .{ .key = "claimant", .value = .{ .bytes = claimant } },
        .{ .key = "since", .value = .{ .uint = at } },
    }) };
}

/// The event: `{event: "claimed", claimant: <hex>}`.
pub fn event(a: Allocator, claimant: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "event", .value = .{ .text = "claimed" } },
        .{ .key = "claimant", .value = .{ .text = try hex(a, claimant) } },
    }) };
}

/// The answer's result: `{claimant: <hex>}`.
pub fn result(a: Allocator, claimant: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "claimant", .value = .{ .text = try hex(a, claimant) } }}) };
}

/// The `/admin` answer's JSON: `{"claimant":"<hex>","since":<ms>}`, or `{}` unclaimed.
pub fn json(a: Allocator, rec: ?Value) ![]const u8 {
    const k = claimantOf(rec) orelse return a.dupe(u8, "{}");
    const h = try hex(a, k);
    if (rec.?.getUint("since")) |s| return std.fmt.allocPrint(a, "{{\"claimant\":\"{s}\",\"since\":{d}}}", .{ h, s });
    return std.fmt.allocPrint(a, "{{\"claimant\":\"{s}\"}}", .{h});
}
