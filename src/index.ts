import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerQueryData } from "./tools/query-data";
import { registerGetSchema } from "./tools/get-schema";
import { registerCodeMode } from "./tools/code-mode";
import { Icd11DataDO } from "./do";

export { Icd11DataDO };

// Workers Builds reconnection canary (2026-07-02): a no-op change to force a
// standalone-repo sync and confirm auto-deploy fires. Safe to remove.

interface Icd11Env {
    ICD11_CLIENT_ID: string;
    ICD11_CLIENT_SECRET: string;
    ICD11_DATA_DO: DurableObjectNamespace;
    MCP_OBJECT: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "who-icd11",
        version: "0.1.0",
    });

    async init() {
        const env = this.env as unknown as Icd11Env;
        registerQueryData(this.server, env);
        registerGetSchema(this.server, env);
        registerCodeMode(this.server, env);
    }
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
            return new Response("ok", {
                status: 200,
                headers: { "content-type": "text/plain" },
            });
        }

        if (url.pathname === "/mcp") {
            return MyMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
        }

        return new Response("Not found", { status: 404 });
    },
};
