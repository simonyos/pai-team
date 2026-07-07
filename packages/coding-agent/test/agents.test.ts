import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentDefinitions } from "../src/core/agents.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

let counter = 0;

describe("agent definitions", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let projectAgentsDir: string;
	let userAgentsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `agents-test-${Date.now()}-${counter++}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		projectAgentsDir = join(cwd, ".pi", "agents");
		userAgentsDir = join(agentDir, "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		mkdirSync(userAgentsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeAgent(dir: string, file: string, content: string): void {
		writeFileSync(join(dir, file), content);
	}

	function knownModels(): Model<Api>[] {
		return ModelRegistry.inMemory(AuthStorage.inMemory()).getAll();
	}

	it("parses a valid definition with frontmatter fields and body as systemPrompt", () => {
		writeAgent(
			projectAgentsDir,
			"reviewer.md",
			`---
name: reviewer
description: Reviews code changes.
tools: read, grep, bash
---
You are a code reviewer. Be thorough.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir });

		expect(agents).toHaveLength(1);
		expect(agents[0].name).toBe("reviewer");
		expect(agents[0].description).toBe("Reviews code changes.");
		expect(agents[0].tools).toEqual(["read", "grep", "bash"]);
		expect(agents[0].systemPrompt).toBe("You are a code reviewer. Be thorough.");
		expect(agents[0].source).toBe("project");
		expect(agents[0].sourceInfo?.scope).toBe("project");
		expect(diagnostics).toHaveLength(0);
	});

	it("skips a definition missing name and reports a diagnostic (does not throw)", () => {
		writeAgent(
			projectAgentsDir,
			"noname.md",
			`---
description: Missing a name.
---
Body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir });

		expect(agents).toHaveLength(0);
		expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("name is required"))).toBe(true);
	});

	it("skips a definition missing description and reports a diagnostic", () => {
		writeAgent(
			projectAgentsDir,
			"nodesc.md",
			`---
name: nodesc
---
Body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir });

		expect(agents).toHaveLength(0);
		expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("description is required"))).toBe(true);
	});

	it("warns and skips on malformed YAML without throwing, and still returns other agents", () => {
		writeAgent(
			projectAgentsDir,
			"broken.md",
			`---
name: broken
description: "unterminated
tools: [read
---
Body.`,
		);
		writeAgent(
			projectAgentsDir,
			"good.md",
			`---
name: good
description: A good agent.
---
Body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir });

		expect(agents.map((a) => a.name)).toEqual(["good"]);
		expect(diagnostics.some((d) => d.type === "warning" && d.path?.endsWith("broken.md"))).toBe(true);
	});

	it("warns about an unknown tool but keeps it in the definition", () => {
		writeAgent(
			projectAgentsDir,
			"custom.md",
			`---
name: custom
description: Uses a namespaced tool.
tools: read, mcp__server__do_thing
---
Body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir });

		expect(agents).toHaveLength(1);
		expect(agents[0].tools).toEqual(["read", "mcp__server__do_thing"]);
		expect(diagnostics.some((d) => d.type === "warning" && d.message.includes("mcp__server__do_thing"))).toBe(true);
	});

	it("warns about an unknown model but keeps the agent", () => {
		writeAgent(
			projectAgentsDir,
			"badmodel.md",
			`---
name: badmodel
description: References a missing model.
model: acme/does-not-exist
---
Body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir, knownModels: knownModels() });

		expect(agents).toHaveLength(1);
		expect(agents[0].model).toBe("acme/does-not-exist");
		expect(
			diagnostics.some((d) => d.type === "warning" && d.message.includes("does not match any known model")),
		).toBe(true);
	});

	it("does not warn when the model matches a known model", () => {
		const models = knownModels();
		expect(models.length).toBeGreaterThan(0);
		const reference = `${models[0].provider}/${models[0].id}`;
		writeAgent(
			projectAgentsDir,
			"goodmodel.md",
			`---
name: goodmodel
description: References a known model.
model: ${reference}
---
Body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir, knownModels: models });

		expect(agents).toHaveLength(1);
		expect(agents[0].model).toBe(reference);
		expect(diagnostics.some((d) => d.message.includes("known model"))).toBe(false);
	});

	it("dedupes by name with project overriding user, reporting a collision", () => {
		writeAgent(
			userAgentsDir,
			"shared.md",
			`---
name: shared
description: User version.
---
User body.`,
		);
		writeAgent(
			projectAgentsDir,
			"shared.md",
			`---
name: shared
description: Project version.
---
Project body.`,
		);

		const { agents, diagnostics } = loadAgentDefinitions({ cwd, agentDir });

		expect(agents).toHaveLength(1);
		expect(agents[0].description).toBe("Project version.");
		expect(agents[0].source).toBe("project");
		const collision = diagnostics.find((d) => d.type === "collision" && d.collision?.name === "shared");
		expect(collision?.collision?.resourceType).toBe("agent");
	});

	it("exposes loaded definitions via ResourceLoader.getAgentDefinitions()", async () => {
		writeAgent(
			projectAgentsDir,
			"planner.md",
			`---
name: planner
description: Plans work.
---
Plan carefully.`,
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { agents } = loader.getAgentDefinitions();
		expect(agents.some((a) => a.name === "planner" && a.systemPrompt === "Plan carefully.")).toBe(true);
	});
});
