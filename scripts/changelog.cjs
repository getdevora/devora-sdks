// Public release notes deliberately omit private source commits and PR metadata.
module.exports = {
	getReleaseLine: async (changeset) => `- ${changeset.summary.trim()}`,
	getDependencyReleaseLine: async (_changesets, dependencies) =>
		dependencies.length
			? `- Updated dependencies:\n${dependencies.map(({ name, newVersion }) => `  - ${name}@${newVersion}`).join("\n")}`
			: "",
}
