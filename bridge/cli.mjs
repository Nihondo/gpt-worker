#!/usr/bin/env node
// Compatibility facade and executable entry point for gpt-worker.
// Command implementations live in focused cli-*.mjs modules.

import { fixPermissions } from "./state.mjs";
import { EXIT_WORKER_UNREACHABLE, WorkerCallError, WorkerUnreachableError, parseArgs } from "./cli-runtime.mjs";
import { formatHelp } from "./cli-help.mjs";
import {
  cmdInit,
  cmdRemove,
  cmdRotate,
  cmdShowConfig,
  cmdUrl,
  cmdWorkspaces,
} from "./cli-provision.mjs";
import {
  cmdChat,
  cmdChatUrl,
  loadChatSettings,
  sharedChatSettings,
} from "./cli-browser.mjs";
import {
  cmdStart,
  cmdLogs,
  cmdStatus,
  cmdStop,
} from "./cli-daemon.mjs";
import {
  cmdAllowList,
  cmdAllowRead,
  cmdDenyList,
  cmdDenyRead,
  cmdGuidance,
  cmdLimits,
  cmdUnallowRead,
  cmdUndenyRead,
} from "./cli-settings.mjs";
import {
  buildExecutedBody,
  cmdComplete,
  cmdContinue,
  cmdDiscardTask,
  cmdHandoff,
  cmdQueue,
  cmdReport,
  cmdState,
  cmdTask,
  cmdWait,
  selectWaitMessages,
} from "./cli-task.mjs";

export { parseArgs };
export {
  cmdChatUrl,
  loadChatSettings,
  sharedChatSettings,
};
export { ensureRemoteSettingsBeforeKeepRemote } from "./cli-provision.mjs";
export { buildExecutedBody, selectWaitMessages };
export {
  buildChatOpenUrl,
  isChatGptUrl,
  workspaceChromeTabId,
  workspaceChatUrl,
  effectiveChatUrl,
  workspaceConversationUrl,
  safeBrowserConfig,
  withWorkspaceChromeTab,
  withoutWorkspaceChromeTab,
  withWorkspaceConversationUrl,
  withoutWorkspaceConversationUrl,
  withoutWorkspaceChatConversation,
  withWorkspaceChatUrl,
  withoutWorkspaceChatUrl,
  withoutWorkspaceChatSettings,
  withChatUrl,
  nudgeChatGpt,
} from "./chat-nudge.mjs";

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  const isHelpCommand = cmd === "help";
  const helpTarget = isHelpCommand ? args._[0] || null : args.help ? cmd : null;
  if (!cmd || isHelpCommand || helpTarget !== null) {
    const help = formatHelp(helpTarget);
    if (help) {
      process.stdout.write(help);
      return;
    }
    console.error(`Unknown command: ${helpTarget}`);
    process.stderr.write(formatHelp());
    process.exit(1);
  }

  fixPermissions();

  switch (cmd) {
    case "init":
      return cmdInit(args);
    case "url":
      return cmdUrl(args);
    case "workspaces":
      return cmdWorkspaces();
    case "remove":
      return cmdRemove(args);
    case "chat-url":
      return cmdChatUrl(args);
    case "chat":
      return cmdChat(args);
    case "show-config":
      return cmdShowConfig(args);
    case "guidance":
      return cmdGuidance(args);
    case "allow-read":
      return cmdAllowRead(args);
    case "unallow-read":
      return cmdUnallowRead(args);
    case "allow-list":
      return cmdAllowList(args);
    case "deny-read":
      return cmdDenyRead(args);
    case "undeny-read":
      return cmdUndenyRead(args);
    case "deny-list":
      return cmdDenyList(args);
    case "start":
      return cmdStart(args);
    case "stop":
      return cmdStop(args);
    case "status":
      return cmdStatus(args);
    case "logs":
      return cmdLogs(args);
    case "queue":
      return cmdQueue(args);
    case "task":
      return cmdTask(args);
    case "wait":
      return cmdWait(args);
    case "report":
      return cmdReport(args);
    case "handoff":
      return cmdHandoff(args);
    case "limits":
      return cmdLimits(args);
    case "state":
      return cmdState(args);
    case "rotate":
      return cmdRotate(args);
    case "complete":
      return cmdComplete(args);
    case "continue":
      return cmdContinue(args);
    case "discard-task":
      return cmdDiscardTask(args);
    default:
      console.error(`Unknown command: ${cmd}`);
      process.stderr.write(formatHelp());
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Failures the user can act on get a plain message, not a stack trace.
    // Anything else is unexpected, so it keeps the stack.
    if (err instanceof WorkerUnreachableError) {
      console.error(`${err.message}\nCheck your network, then: gpt-worker status`);
      process.exit(EXIT_WORKER_UNREACHABLE);
    }
    if (err instanceof WorkerCallError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
