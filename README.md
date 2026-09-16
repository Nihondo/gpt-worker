# gpt-worker

**This is an experimental project. Use at your own risk.**

**gpt-worker** is a developer workflow tool that pairs the web version of ChatGPT (Plus, Team, Pro) as your planning and review "brain" with a local coding agent (such as Claude Code, Antigravity, or Codex) or yourself as the execution "hands" to edit files, run tests, and manage Git.

It brings ChatGPT's advanced web reasoning into your daily coding loop without consuming any ChatGPT API tokens.

This tool was inspired by [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt). It is a compact development support tool that achieves integration between ChatGPT Web and a local bridge via a message hub on Cloudflare Workers, while streamlining its scope specifically to macOS and Google Chrome.
Special thanks to XiaoDuoYa for providing this brilliant idea.

```text
[ChatGPT Project] ──(MCP / HTTPS)──> [Cloudflare Worker (Shared Hub)] ──(WebSocket)──> [Local Environment (Bridge)]
```

---

## Key Features

- **Zero API Costs**: Powered by your existing ChatGPT web subscription (Plus, Team, Pro) with no per-token API charges.
- **One-Time Setup Hub**: Deploy the relay Cloudflare Worker and configure ChatGPT once. Every subsequent project is added instantly with a single local command.
- **Safe Read-Only Design**: ChatGPT only inspects files and generates plans. File modifications and command executions are always reviewed and run locally.
- **Automatic Secret Protection**: Sensitive files such as `.env`, private keys, `.ssh`, `.aws`, and Git-ignored paths are automatically hidden from ChatGPT, and every tool result is additionally scanned by an external secret scanner (betterleaks/gitleaks) before it reaches ChatGPT, with any finding masked in place.
- **Chrome Automation**: Automatically opens the ChatGPT Project in Chrome when a task is queued, and can submit messages in the background without stealing window focus.
- **Zero Extra Dependencies**: Built purely with standard Node.js built-ins. No bulky npm packages or heavy daemons to install.

---

## Prerequisites

- **OS**: macOS (for automated Chrome integration)
- **Node.js**: v22 or higher (install with `brew install node` if not present)
- **Google Chrome**: Browser used to run ChatGPT
- **ChatGPT Subscription**: Plus, Team, or Pro (with Developer mode and Projects enabled)
- **Cloudflare Account**: Free tier is sufficient (used to deploy the relay Worker)
- **A secret scanner**: [betterleaks](https://github.com/betterleaks/betterleaks) (recommended) or [gitleaks](https://github.com/gitleaks/gitleaks) as a compatible fallback — required so the local bridge can mask secrets before they reach ChatGPT; `gpt-worker start` refuses to run without one.
  ```bash
  brew install betterleaks   # or: brew install gitleaks
  ```

---

## Initial Setup (One-Time)

Setup takes 5 steps. Once completed, the same configuration is reused across all your projects.

### Step 1: Clone the Repository & Link the Command

1. Clone the repository into any working directory:
   ```bash
   git clone https://github.com/Nihondo/gpt-worker.git
   cd gpt-worker
   ```

2. Create a symlink in a directory that is in your `PATH` (such as Homebrew's bin):
   ```bash
   # Link into Homebrew's bin directory (/opt/homebrew/bin on Apple Silicon):
   ln -s "$(pwd)/bin/gpt-worker" "$(brew --prefix)/bin/gpt-worker"
   ```
   > **Tip**: On Apple Silicon Macs, you can link directly to `/opt/homebrew/bin/gpt-worker` (or `/usr/local/bin` on Intel Macs). Using `$(brew --prefix)/bin` automatically resolves the correct path for your system. Any directory in your `PATH` (e.g. `~/.local/bin`) works as well.

### Step 2: Register the Skill for Your Agent (SKILL.md)

Link `SKILL.md` into your coding agent's skills directory so the agent can discover and operate `gpt-worker`:

```bash
# Example: For Claude Code
mkdir -p ~/.claude/skills/gpt-worker
ln -s "$(pwd)/SKILL.md" ~/.claude/skills/gpt-worker/SKILL.md

# Example: For Codex
mkdir -p ~/.codex/skills/gpt-worker
ln -s "$(pwd)/SKILL.md" ~/.codex/skills/gpt-worker/SKILL.md

# Example: For Antigravity
mkdir -p ~/.agents/skills/gpt-worker
ln -s "$(pwd)/SKILL.md" ~/.agents/skills/gpt-worker/SKILL.md
```

### Step 3: Initialize & Deploy the Worker

Run `init` targeting your first project directory:

```bash
gpt-worker init -w /path/to/your-project
```

- On the first run, a browser window opens for Cloudflare login.
- Once authenticated, the Cloudflare Worker deploys automatically.
- Note the `Server URL` printed in the terminal (you can check it anytime with `gpt-worker url`).

### Step 4: Configure ChatGPT

1. **Enable Developer Mode**:
   - In ChatGPT, click your profile (bottom-left) → **Settings** → **Developer mode** and toggle it ON.
2. **Add MCP Connector**:
   - Go to **Settings** → **Connectors** (or Developer mode settings) and add a new connector.
   - **Name**: `gpt-worker` (fixed — do not rename)
   - **Server URL**: The URL printed by `gpt-worker url`
   - **Authentication**: Select `OAuth`. When the consent page appears, enter the owner token printed by `gpt-worker url` to approve it.
   - **Choose a connector URL**:
     - **Shared connector (recommended)**: `gpt-worker url` prints `/mcp`. Register it once to use every registered workspace. ChatGPT selects a workspace with `list_workspaces` and supplies its `workspace_id` to later tool calls.
     - **Dedicated workspace connector**: `gpt-worker url -w /path/to/your-project` prints `/mcp/<workspace_id>`. Register it as a separate connector when it should access only that workspace. It does not provide `list_workspaces`, and its tool calls do not need a `workspace_id`.
3. **Create a ChatGPT Project**:
   - In ChatGPT's left sidebar, create a **New Project** (e.g., `Coding Assistant`).
   - We recommend enabling **Project-only memory** in the project settings.
4. **Set Project Instructions**:
   - Paste this single line into the project's **Instructions** field.
     ```text
     Use the gpt-worker connector. It supplies its own operating instructions — follow them for every round.
     ```
   - The full operating protocol is delivered by the connector itself: in its `initialize` response, through the `operating_instructions` tool, and again with each task it hands you via `next_task`. There is nothing else to paste, and nothing to re-paste when gpt-worker is updated.
   - Leaving the field empty also works — the line above only helps ChatGPT on the very first turn of a brand-new conversation.
   - The protocol text itself lives in [worker/src/instructions.md](worker/src/instructions.md) if you want to read it.

### Step 5: Register the Project URL & Enable Chrome Auto-Submit

1. Save your ChatGPT Project URL (from the browser address bar `https://chatgpt.com/g/...`) into the CLI:
   ```bash
   gpt-worker chat-url "https://chatgpt.com/g/g-p-.../project"
   ```
   When configured, Chrome will prepare and, when Apple Events is enabled, submit task prompts automatically.

2. **Allow Chrome Background Submission (One-Time Setup)**:
   To enable background prompt typing and submission without stealing window focus, enable Apple Events scripting in Chrome:
   - In Chrome's menu bar, click **View** → **Developer** → check **Allow JavaScript from Apple Events**.
   - **Relaunch Chrome completely** (`Cmd + Q` to quit, then reopen).
   > **Note**: If this setting is not enabled, the prompt will be placed into the composer, but you will need to press Enter manually.

### Start a New Chat or Recover a Conversation

Each workspace can retain a ChatGPT conversation URL as its durable handoff target; a Chrome tab ID is only a short-lived optimization. If that tab ID is unavailable, gpt-worker first looks for the saved conversation URL, then opens that URL in a replacement tab when necessary. Use these commands when a conversation becomes too long or browser automation opened the wrong profile:

```bash
# Make the next task/report start a fresh ChatGPT conversation in the same Project.
# This does not cancel Worker tasks or change the configured Project URL.
gpt-worker chat new -w .

# Attach the workspace to a conversation you opened manually in the configured Project.
gpt-worker chat attach "https://chatgpt.com/g/g-p-.../c/..." -w .

# Show the configured Project and attached conversation.
gpt-worker chat status -w .
```

---

## Daily Usage (Workflow Cycle)

> **💡 Routine work only requires prompting your agent**  
> Once `SKILL.md` is installed, simply tell your agent (Claude Code, Codex, Antigravity, etc.) to "**plan this with gpt-worker**" or "**run this with ChatGPT review**". The agent will execute the CLI commands below autonomously in the background.  
> In most cases, **you do not need to run commands manually**.  
> (The manual steps below remain fully available if you wish to run commands directly or inspect what is happening.)

Development follows an iterative cycle: **"Task (`task`) → Wait (`wait`) → Edit & Test → Report (`report`) → Review (`wait`)"**.

```text
[You / Local Agent]                             [ChatGPT]
        │                                           │
        │── 1. gpt-worker task "<goal>" ───────────>│
        │                                           │ (Inspects repo & drafts plan)
        │<── 2. gpt-worker wait (Receive PLAN) ─────│
        │                                           │
   (Edit code & run tests locally)                  │
        │                                           │
        │── 3. gpt-worker report ──────────────────>│
        │                                           │ (Reviews diff & verifies tests)
        │<── 4. gpt-worker wait (DONE or next step) │
```

### 1. Start the Bridge Process
Before starting work, ensure the local bridge process is running for your workspace:

```bash
gpt-worker start -w .
gpt-worker status -w .
```

### 2. Queue a Task (`task`)
Describe your goal in natural language:

```bash
gpt-worker task "Fix the validation error styling on the login page" -w .
```
Chrome opens your ChatGPT Project, and the task prompt is automatically entered and submitted (requires the Chrome "Allow JavaScript from Apple Events" setting described above).

### 3. Wait for the Plan (`wait`)
ChatGPT inspects workspace files and prepares a plan:

```bash
gpt-worker wait -w .
```
When received, the plan is printed in the terminal. Review it to ensure it is sound and safe.

### 4. Execute Changes & Run Tests
Your local agent (Claude Code, Antigravity, etc.) or you modify the code and run your test suite locally.

### 5. Report Results (`report`)
Report modified file counts and test results back to ChatGPT:

```bash
gpt-worker report --changed 2 --tests "All 8 tests passing" -w .
```

### 6. Receive Review Results (`wait`)
Run `wait` again to receive ChatGPT's evaluation:

```bash
gpt-worker wait -w .
```
If ChatGPT determines the goal is achieved (`DONE`), you are finished! If there are follow-up instructions, repeat from step 4.

### 7. Stop the Bridge Process
When finished, stop the local bridge process:

```bash
gpt-worker stop -w .
```

---

## Common Tasks & Recipes

### Adding Another Project
No need to redeploy the Worker or reconfigure ChatGPT. Simply run `init` in the new directory:

```bash
gpt-worker init -w /path/to/another-project
```

### Setting Project-Specific Guidelines (`guidance`)
Set standing rules for ChatGPT (e.g., "Always use Vitest", "Enforce strict TypeScript"):

```bash
# Set standing guidance
gpt-worker guidance "Always write tests in Vitest. Prefer functional components." -w .

# View current guidance
gpt-worker guidance -w .

# Clear guidance
gpt-worker guidance --clear -w .
```

### Allowing a Specific Git-Ignored File to Be Read
Files listed in `.gitignore` are hidden from ChatGPT by default. You can explicitly allow direct reads for a specific file:

```bash
# Allow one exact file
gpt-worker allow-read config/test-fixture.json -w .

# List allowed files
gpt-worker allow-list -w .

# Revoke permission
gpt-worker deny-read config/test-fixture.json -w .
```
*Note*: Sensitive files (like `.env` or private keys) remain protected and cannot be unblocked.

### Inspecting Configuration
Inspect configured Project URLs and auto-submit preferences:

```bash
gpt-worker show-config -w .
```

### Listing Registered Workspaces
List all workspaces registered on this machine and their bridge statuses:

```bash
gpt-worker workspaces
```

### Resuming After a Timeout
The default timeout for `wait` is 15 minutes. If a timeout occurs, you can resume waiting without re-submitting the task:

```bash
# Check current task state
gpt-worker state -w .

# Resume waiting
gpt-worker wait -w .
```

### Updating & Redeploying
When you update gpt-worker via `git pull`, redeploy the Cloudflare Worker if the update includes changes to the Worker code (`worker/`):

```bash
# 1. Navigate to the gpt-worker repository and pull the latest changes
cd /path/to/gpt-worker
git pull

# 2. Redeploy the Cloudflare Worker
npm run deploy

# 3. Restart any running local bridge processes
gpt-worker stop -w /path/to/your-project
gpt-worker start -w /path/to/your-project
```
> **Note**:
> - Redeploying preserves your Worker URL and existing authentication tokens, so you do not need to reconfigure ChatGPT connectors.
> - If an update only modifies local bridge code (`bridge/`), Worker redeployment is not strictly necessary, but running `npm run deploy` is always safe.
> - ChatGPT caches a connector's `initialize` response at registration time, so an update to the operating instructions only reaches an already-registered connector once you remove and re-add it. You don't need to do this for every deploy: the same instructions are also delivered with every task via `next_task` and through the `operating_instructions` tool, so a round works correctly either way.

### Deregistering a Workspace
To remove a project and purge its records from the local machine and remote Worker:

```bash
gpt-worker remove -w /path/to/project --yes
```

---

## Troubleshooting & Safety

### Chrome Auto-Submit Not Working
To allow background script execution in an existing tab:

1. In Chrome, open **View** → **Developer** → check **Allow JavaScript from Apple Events**.
2. **Relaunch Chrome completely**.
3. Any existing text or draft in the input box (including connector mentions) is cleared and overwritten with the new prompt to prioritize uninterrupted background execution.

### Safety Guarantees
- **Plan Review**: Always verify the plan generated by ChatGPT before execution. Check for unwanted file deletions or unexpected external commands.
- **Secret Blocking**: `.env`, private keys, `.ssh`, and `.aws` are always blocked from ChatGPT read requests.
- **Time-Bounded Access**: ChatGPT can only inspect workspace files while an active task is running.

---

## Command Reference

| Command | Description |
|---|---|
| `gpt-worker init -w <dir>` | Register workspace (deploys Worker on first run) |
| `gpt-worker url [-w <dir>]` | Display the Server URL and authentication token (`-w` displays a connector URL dedicated to that workspace) |
| `gpt-worker start -w <dir>` | Start the local bridge process |
| `gpt-worker stop -w <dir>` | Stop the local bridge process |
| `gpt-worker status -w <dir>` | Check bridge process status and active task |
| `gpt-worker task "<goal>" -w <dir>` | Queue a new task for ChatGPT |
| `gpt-worker wait -w <dir>` | Wait for ChatGPT response (PLAN / DONE / instructions) |
| `gpt-worker report -w <dir>` | Submit execution metrics and test results to ChatGPT |
| `gpt-worker guidance "<text>" -w <dir>` | Set project-specific instructions |
| `gpt-worker chat-url "<url>" -w <dir>` | Save or inspect ChatGPT Project URL |
| `gpt-worker chat <new\|attach\|status> ... -w <dir>` | Start a fresh chat, attach a manually opened conversation, or inspect chat recovery state |
| `gpt-worker show-config [-w <dir>]` | Display browser settings without credentials |
| `gpt-worker allow-read <file> -w <dir>` | Allow reading a specific Git-ignored file |
| `gpt-worker allow-list -w <dir>` | List allowed Git-ignored files |
| `gpt-worker deny-read <file> -w <dir>` | Revoke reading permission for a file |
| `gpt-worker state -w <dir>` | Display active task checkpoint in JSON |
| `gpt-worker workspaces` | List all registered workspaces |
| `gpt-worker remove -w <dir> --yes` | Deregister workspace and purge records |

---

## Development

To run tests or deploy updates to gpt-worker itself:

```bash
npm run check    # Run syntax checks
npm test         # Run test suites
npm run verify   # Run check and tests
npm run dry-run  # Dry-run Worker deployment
npm run deploy   # Deploy Cloudflare Worker updates
```

---

## Acknowledgments

This project was heavily inspired by **[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)**, which pioneered the approach of using ChatGPT's web subscription as the reasoning brain for coding agents. Special thanks to XiaoDuoYa for this innovative concept and open-source contribution.

---

## License

[MIT](LICENSE) © 2026 Nihondo
