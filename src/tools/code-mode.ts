import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { icd11Catalog } from "../spec/catalog";
import { createIcd11ApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    ICD11_CLIENT_ID: string;
    ICD11_CLIENT_SECRET: string;
    ICD11_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const apiFetch = createIcd11ApiFetch(env);

    const searchTool = createSearchTool({
        prefix: "icd11",
        catalog: icd11Catalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "icd11",
        // Verifiable provenance: icd11_execute results carry a _meta.citation.
        source: { id: "icd11", name: "WHO ICD-11", url: "https://icd.who.int" },
        catalog: icd11Catalog,
        apiFetch,
        doNamespace: env.ICD11_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
