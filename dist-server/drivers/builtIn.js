import { BoxAgentDriver } from "./boxagent.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { GrokDriver } from "./grok.js";
import { CustomApiDriver } from "./custom.js";
import { ExternalCliDriver } from "./externalCli.js";
export const BUILT_IN_DRIVERS = [
    GrokDriver,
    ClaudeDriver,
    CodexDriver,
    BoxAgentDriver,
    CustomApiDriver,
    ExternalCliDriver,
];
