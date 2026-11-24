# Privacy

Flow Explainer (`powermods-flow-explainer`) is a Claude Code mod that runs on your own machine. This statement covers what it collects, keeps and sends.

## What it collects

Nothing about you. The mod has no accounts, analytics or telemetry, and it collects no personal data.

## What it keeps on your machine

- **Flow files** that Claude writes for each flow you build, in `~/.claude/flow-explainer/flows/`.
- **Saved flows**, written when you press `s`, in `~/.claude/flow-explainer/saved/`. A saved flow holds the steps of the flow (titles, explanations, file paths, line numbers and short code excerpts), the step you were on, the project folder it was saved from, and a SHA-256 digest of each step's file so a later resume can tell what changed.

## What leaves your machine

Nothing, through the mod. It makes no network requests (`network.hosts` in `plugin.json` is empty) and starts no programs.

When you run `/flow`, `/flow-explain` or `/flow-resume`, or use the pane's keys, the mod sends a prompt to your current Claude Code session. Claude then reads your code with its normal tools to build the flow. That turn goes to Anthropic like any other turn in your session, on your own Claude plan or API key, under Anthropic's terms and privacy policy. The mod sends nothing to anyone else.

## Retention

Flow files and saved flows stay until you delete them. The mod deletes nothing on its own.

## How to delete your data

Delete the `~/.claude/flow-explainer` folder, or single files in it. Uninstalling the plugin doesn't delete that folder.

## Sharing

No data is sold or shared with anyone. The mod has no server of its own.

## Children

The mod is a developer tool and is not directed at people under 18.

## Contact

Questions or requests: open an issue at <https://github.com/netgfx/claude-flow-explainer/issues>.
