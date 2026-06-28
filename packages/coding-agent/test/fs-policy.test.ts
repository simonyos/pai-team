import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	assertReadable,
	assertWritable,
	createDefaultFsPolicy,
	type FsPolicy,
	FsPolicyError,
	isInside,
	isReadDenied,
} from "../src/core/tools/fs-policy.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const policy: FsPolicy = {
	writableRoots: ["/work"],
	denyRead: [".git", ".env", "*.pem"],
	denyWrite: [".git", ".env", "*.pem"],
};

describe("isInside", () => {
	it("recognizes containment and rejects traversal/siblings", () => {
		expect(isInside("/work", "/work")).toBe(true);
		expect(isInside("/work/src/a.ts", "/work")).toBe(true);
		expect(isInside("/etc/passwd", "/work")).toBe(false);
		expect(isInside("/work2/a", "/work")).toBe(false); // prefix-but-not-nested
		expect(isInside("/work/../etc", "/work")).toBe(false);
	});
});

describe("assertWritable", () => {
	it("allows writes inside a writable root", () => {
		expect(() => assertWritable("/work/src/a.ts", policy)).not.toThrow();
	});

	it("blocks writes outside every writable root", () => {
		expect(() => assertWritable("/etc/passwd", policy)).toThrow(FsPolicyError);
		expect(() => assertWritable("/tmp/evil", policy)).toThrow(/outside the writable workspace/);
	});

	it("blocks protected paths even inside a writable root", () => {
		expect(() => assertWritable("/work/.git/config", policy)).toThrow(/protected path/);
		expect(() => assertWritable("/work/.env", policy)).toThrow(FsPolicyError);
		expect(() => assertWritable("/work/keys/server.pem", policy)).toThrow(FsPolicyError);
	});

	it("does not root-restrict when writableRoots is empty", () => {
		const open: FsPolicy = { writableRoots: [], denyRead: [], denyWrite: [".git"] };
		expect(() => assertWritable("/anywhere/file.ts", open)).not.toThrow();
		expect(() => assertWritable("/anywhere/.git/x", open)).toThrow(FsPolicyError);
	});
});

describe("assertReadable", () => {
	it("blocks reads of secret paths but allows ordinary files", () => {
		expect(() => assertReadable("/work/src/a.ts", policy)).not.toThrow();
		expect(() => assertReadable("/work/.env", policy)).toThrow(FsPolicyError);
		expect(() => assertReadable("/work/certs/key.pem", policy)).toThrow(/protected path/);
		expect(() => assertReadable("/home/me/.git/config", policy)).toThrow(FsPolicyError);
	});
});

describe("createDefaultFsPolicy", () => {
	it("confines writes to cwd + tmp and denies vcs/secrets", () => {
		const p = createDefaultFsPolicy("/work");
		expect(p.writableRoots).toContain("/work");
		expect(p.writableRoots.some((r) => r === tmpdir() || isInside(tmpdir(), r) || isInside(r, tmpdir()))).toBe(true);
		expect(p.denyWrite).toContain(".git");
		expect(() => assertWritable("/work/.git/objects/x", p)).toThrow(FsPolicyError);
		expect(() => assertWritable("/work/src/a.ts", p)).not.toThrow();
		expect(() => assertWritable("/etc/hosts", p)).toThrow(FsPolicyError);
	});
});

describe("review hardening", () => {
	const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

	it("matches deny rules according to filesystem case-sensitivity", () => {
		if (caseInsensitive) {
			expect(() => assertReadable("/work/.GIT/config", policy)).toThrow(FsPolicyError);
			expect(() => assertWritable("/work/SECRET.PEM", policy)).toThrow(FsPolicyError);
			expect(() => assertWritable("/work/.Env", policy)).toThrow(FsPolicyError);
		} else {
			// case-sensitive FS: upper/mixed-case variants are distinct files, not denied
			expect(() => assertReadable("/work/.GIT/config", policy)).not.toThrow();
			expect(() => assertWritable("/work/SECRET.PEM", policy)).not.toThrow();
		}
	});

	it("honors absolute deny rules that contain a glob", () => {
		const p: FsPolicy = { writableRoots: ["/work"], denyRead: [], denyWrite: ["/work/.git/*"] };
		expect(() => assertWritable("/work/.git/config", p)).toThrow(FsPolicyError);
		expect(() => assertWritable("/work/src/a.ts", p)).not.toThrow();
	});

	it("isReadDenied is the non-throwing form of assertReadable", () => {
		expect(isReadDenied("/work/.env", policy)).toBe(true);
		expect(isReadDenied("/work/certs/k.pem", policy)).toBe(true);
		expect(isReadDenied("/work/src/a.ts", policy)).toBe(false);
	});
});

describe("tool-level enforcement", () => {
	it("write tool blocks out-of-root paths and protected paths", async () => {
		const writes: string[] = [];
		const tool = createWriteTool("/work", {
			fsPolicy: policy,
			operations: { writeFile: async (p) => void writes.push(p), mkdir: async () => {} },
		});
		await expect(tool.execute("t1", { path: "/etc/passwd", content: "x" })).rejects.toThrow(/outside the writable/);
		await expect(tool.execute("t2", { path: ".env", content: "x" })).rejects.toThrow(/protected path/);
		expect(writes).toEqual([]);
		const res = await tool.execute("t3", { path: "src/ok.ts", content: "x" });
		expect(JSON.stringify(res.content)).toMatch(/Successfully wrote/);
		expect(writes).toEqual([join("/work", "src/ok.ts")]);
	});

	it("write tool is unrestricted when no policy is set (non-breaking)", async () => {
		const writes: string[] = [];
		const tool = createWriteTool("/work", {
			operations: { writeFile: async (p) => void writes.push(p), mkdir: async () => {} },
		});
		await tool.execute("t1", { path: "/anywhere/out.txt", content: "x" });
		expect(writes).toEqual(["/anywhere/out.txt"]);
	});

	it("edit tool blocks out-of-root paths before touching the filesystem", async () => {
		let accessed = false;
		const tool = createEditTool("/work", {
			fsPolicy: policy,
			operations: {
				access: async () => {
					accessed = true;
				},
				readFile: async () => Buffer.from("a"),
				writeFile: async () => {},
			},
		});
		await expect(
			tool.execute("t1", { path: "/etc/cron.d/x", edits: [{ oldText: "a", newText: "b" }] }),
		).rejects.toThrow(FsPolicyError);
		expect(accessed).toBe(false);
	});

	it("read tool blocks secret paths", async () => {
		const tool = createReadTool("/work", {
			fsPolicy: policy,
			operations: { access: async () => {}, readFile: async () => Buffer.from("secret") },
		});
		await expect(tool.execute("t1", { path: ".env" })).rejects.toThrow(/protected path/);
	});
});
