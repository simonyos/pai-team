export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme" | "agent";
	name: string; // skill name, command/tool/flag name, prompt name, theme name, agent name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
