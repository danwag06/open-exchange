// open-exchange (shruggr/open-exchange#1): the swap app's program, Zig 0.16.0, wasm32-wasi.
//
//   config     the swap app's program (apps/swap/programs/config; skein-amm's amm-config 0.22.0,
//              moved here and changed, shruggr/skein#164): root's decisions as facts and events
//
// It links the AMM library, shruggr/skein-amm (a URL+hash dependency): its deploy reader
// (src/deploy.zig) and test fixtures, and through it the overlay engine's SDK modules (chain, sk,
// app, files, cbor, dagjson) and the 1Color module.
//
//   zig build          → zig-out/bin/config.wasm
//   zig build bin      written to apps/swap/bin/config.wasm (committed: nothing is built on a skein)
//   zig build test     the program's tests, natively
const std = @import("std");

const Mods = struct {
    chain: *std.Build.Module,
    color: *std.Build.Module,
    deploy: *std.Build.Module,
    sk: *std.Build.Module,
    app: *std.Build.Module,
    files: *std.Build.Module,
    cbor: *std.Build.Module,
    dagjson: *std.Build.Module,
    overlay_sk: *std.Build.Module,
    /// The SDK's wallet library (0.15.2: BRC-29 and the signer's wire frames, for the withdraw's payee key).
    wallet: *std.Build.Module,
};

fn mods(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) Mods {
    const amm = b.dependency("skein_amm", .{ .target = target, .optimize = optimize });
    const ov = amm.builder.dependency("skein_overlay", .{ .target = target, .optimize = optimize });
    const sdk = ov.builder.dependency("skein_sdk", .{ .target = target, .optimize = optimize });
    const cd = amm.builder.dependency("skein_1color", .{ .target = target, .optimize = optimize });
    const chain = sdk.module("chain");
    const color = cd.module("1color");
    const deploy = b.createModule(.{
        .root_source_file = amm.path("src/deploy.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "chain", .module = chain }, .{ .name = "1color", .module = color } },
    });
    return .{
        .chain = chain,
        .color = color,
        .deploy = deploy,
        .sk = sdk.module("sk"),
        .app = sdk.module("app"),
        .files = sdk.module("files"),
        .cbor = sdk.module("cbor"),
        .dagjson = sdk.module("dagjson"),
        .overlay_sk = ov.module("sk"),
        .wallet = sdk.module("wallet"),
    };
}

fn imports(b: *std.Build, m: Mods) []const std.Build.Module.Import {
    return b.allocator.dupe(std.Build.Module.Import, &.{
        .{ .name = "chain", .module = m.chain },
        .{ .name = "1color", .module = m.color },
        .{ .name = "deploy", .module = m.deploy },
        .{ .name = "sk", .module = m.sk },
        .{ .name = "app", .module = m.app },
        .{ .name = "files", .module = m.files },
        .{ .name = "sdk_cbor", .module = m.cbor },
        .{ .name = "dagjson", .module = m.dagjson },
        .{ .name = "overlay_sk", .module = m.overlay_sk },
        .{ .name = "wallet", .module = m.wallet },
    }) catch @panic("OOM");
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    _ = b.standardOptimizeOption(.{});

    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wm = mods(b, wasi, .ReleaseSafe);
    const exe = b.addExecutable(.{
        .name = "config",
        .root_module = b.createModule(.{
            .root_source_file = b.path("apps/swap/programs/config/src/main.zig"),
            .target = wasi,
            .optimize = .ReleaseSafe,
            .strip = true,
            .imports = imports(b, wm),
        }),
    });
    b.installArtifact(exe);
    const bin = b.addUpdateSourceFiles();
    bin.addCopyFileToSource(exe.getEmittedBin(), "apps/swap/bin/config.wasm");
    b.step("bin", "write the swap app's program into apps/swap/bin/").dependOn(&bin.step);

    const nm = mods(b, target, .Debug);
    const amm = b.dependency("skein_amm", .{ .target = target, .optimize = .Debug });
    const m = b.createModule(.{
        .root_source_file = b.path("apps/swap/programs/config/test.zig"),
        .target = target,
        .optimize = .Debug,
        .imports = imports(b, nm),
    });
    m.addImport("vectors", b.createModule(.{ .root_source_file = amm.path("src/fixtures/vectors.zig"), .target = target, .optimize = .Debug }));
    const wf = b.addWriteFiles();
    _ = wf.addCopyFile(b.path("apps/swap/etc/app.json"), "swap_app.json");
    m.addImport("swap_manifest", b.createModule(.{
        .root_source_file = wf.add("swap_manifest.zig", "pub const json = @embedFile(\"swap_app.json\");\n"),
        .target = target,
        .optimize = .Debug,
    }));
    const t = b.addTest(.{ .root_module = m, .name = "config" });
    b.step("test", "the swap program's tests, natively").dependOn(&b.addRunArtifact(t).step);
}
