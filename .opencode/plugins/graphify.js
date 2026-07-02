// graphify OpenCode plugin
// Registers /graphify slash command and injects a knowledge graph reminder before bash tool calls when the graph exists.
//
// IMPORTANT: keep the reminder string free of backticks and $(...) constructs.
// The hook prepends `echo "<reminder>" && <cmd>` to the user's bash command;
// backticks inside the double-quoted echo trigger bash command substitution,
// which both corrupts tool output and silently executes the very graphify
// command we are only suggesting. Plain words render fine in opencode's TUI.
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export const GraphifyPlugin = async ({ directory }) => {
  let reminded = false;
  let graphifySkillPath = null;

  // Resolve skill file from opencode's global skills directory
  const globalSkillsDir = resolve(process.env.HOME, ".config/opencode/skills/graphify/SKILL.md");
  const fallbackSkillsDir = resolve(process.env.HOME, ".claude/skills/graphify/SKILL.md");

  if (existsSync(globalSkillsDir)) {
    graphifySkillPath = globalSkillsDir;
  } else if (existsSync(fallbackSkillsDir)) {
    graphifySkillPath = fallbackSkillsDir;
  }

  return {
    "command.register": () => [
      {
        title: "Graphify - Build Knowledge Graph",
        value: "graphify",
        description: "Turn codebase into a navigable knowledge graph",
        slash: {
          name: "graphify",
          aliases: ["kg"],
        },
        onSelect: () => {
          // This triggers the slash command - the agent reads the skill file
        },
      },
    ],

    "tool.execute.before": async (input, output) => {
      // If this is a graphify command, inject the skill content as context
      if (input.command && input.command.startsWith("/graphify")) {
        if (graphifySkillPath && existsSync(graphifySkillPath)) {
          try {
            const skillContent = readFileSync(graphifySkillPath, "utf-8");
            // Prepend the skill instructions to the command
            output.args.command = `echo "LOADING GRAPHIFY SKILL: ${graphifySkillPath} && ${output.args.command}`;
            // Store skill content in a temp file for the agent to read
            const tempSkillPath = join(directory, ".graphify-skill-context.md");
            require("fs").writeFileSync(tempSkillPath, skillContent, "utf-8");
          } catch (e) {
            // Silently fail if skill file can't be read
          }
        }
      }

      if (reminded) return;
      if (!existsSync(join(directory, "graphify-out", "graph.json"))) return;

      if (input.tool === "bash") {
        output.args.command =
          'echo "[graphify] knowledge graph at graphify-out/. For focused questions, run graphify query with your question (scoped subgraph, usually much smaller than GRAPH_REPORT.md) instead of grepping raw files. Read GRAPH_REPORT.md only for broad architecture context." && ' +
          output.args.command;
        reminded = true;
      }
    },
  };
};
