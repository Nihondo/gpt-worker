// CLI help is deliberately pure data + formatting. Keeping it free of command
// module imports means `gpt-worker help` is always available, even when local
// configuration or optional runtime prerequisites are broken.

export const COMMANDS = [
  ["init", "Provision this workspace; deploy the shared Worker on first use."],
  ["url", "Print the dashboard, OAuth server URL, and owner-token guidance."],
  ["workspaces", "List locally provisioned workspaces."],
  ["remove", "Remove a workspace registration (requires --yes)."],
  ["chat-url", "Set or inspect the ChatGPT Project URL."],
  ["chat", "Open, attach, or start a ChatGPT Project conversation."],
  ["show-config", "Show safe browser-facing configuration."],
  ["guidance", "View or update standing workspace guidance."],
  ["allow-read", "Allow one Git-ignored path to be read."],
  ["unallow-read", "Remove a Git-ignored read exception."],
  ["allow-list", "List Git-ignored read exceptions."],
  ["deny-read", "Explicitly deny reads for one path."],
  ["undeny-read", "Remove an explicit read denial."],
  ["deny-list", "List explicitly denied read paths."],
  ["start", "Start the local bridge (--always-allow disables the read gate)."],
  ["stop", "Stop the local bridge."],
  ["status", "Show local diagnostics and Worker/task status."],
  ["logs", "Show local bridge logs (-n <lines>, --all, or --path)."],
  ["queue", "List pending messages or discard one with --discard."],
  ["task", "Queue a goal for ChatGPT planning."],
  ["wait", "Wait for and acknowledge a ChatGPT reply."],
  ["report", "Report a completed implementation round."],
  ["handoff", "Hand an executing round to another local agent."],
  ["limits", "View or set the per-workspace message body limit."],
  ["state", "Print the active task as JSON."],
  ["rotate", "Rotate a workspace or hub credential."],
  ["complete", "Complete a review-only task."],
  ["continue", "Reopen a review-only task for implementation."],
  ["discard-task", "Block and clear the active task (requires --yes)."],
].map(([name, summary]) => ({ name, summary }));

export function commandNames() {
  return COMMANDS.map((command) => command.name);
}

export function formatHelp(name = null) {
  if (name) {
    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (!command) return null;
    return `Usage: gpt-worker ${command.name} [options]\n\n${command.summary}\n\nUse 'gpt-worker help' to list commands.\n`;
  }
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const rows = COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`).join("\n");
  return `Usage: gpt-worker <command> [options]\n\nCommands:\n${rows}\n\nUse 'gpt-worker help <command>' or 'gpt-worker <command> --help' for a command summary.\n`;
}
