import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import type { McpServer } from "@bio-mcp/shared/mcp";
import { createIcd11ApiFetch, hasLiveCredentials } from "../lib/api-adapter";
import { buildIcd11Catalog } from "../spec/catalog";

interface CodeModeEnv {
    ICD11_CLIENT_ID?: string;
    ICD11_CLIENT_SECRET?: string;
    ICD11_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export { ICD11_KEYLESS_SOURCE, ICD11_CREDENTIALED_SOURCE, icd11Source } from "../lib/source-descriptor";
import { icd11Source } from "../lib/source-descriptor";
import { icd11Response } from "../lib/tool-result";

/**
 * Injection seam, matching `Icd11AdapterDeps`: it lets a test observe the
 * options this server actually hands the execute-tool factory. The citation
 * source is not readable from the object the factory returns, so without this
 * seam the descriptor above could be reverted to a wrong literal and no test
 * would notice.
 */
export interface Icd11CodeModeDeps {
    createExecuteTool?: typeof createExecuteTool;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
    deps: Icd11CodeModeDeps = {},
): void {
    const makeExecuteTool = deps.createExecuteTool ?? createExecuteTool;
    const apiFetch = createIcd11ApiFetch(env);
    const liveApi = hasLiveCredentials(env);
    // The catalog states which tier is actually live here, so a program is not
    // written against gated endpoints this deployment cannot reach.
    const catalog = buildIcd11Catalog(liveApi);
    const registrar = { tool: (...args: unknown[]) => {
        const [name, ...rest] = args;
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        const handler = rest.pop() as (args: unknown, extra: unknown) => Promise<Parameters<typeof icd11Response>[0] extends () => Promise<infer R> ? R : never>;
        for (const alias of [String(name), `mcp_${String(name)}`]) register(alias, ...rest, (args: unknown, extra: unknown) => icd11Response(() => handler(args, extra), env, alias, extra, args));
    } };

    const searchTool = createSearchTool({
        prefix: "icd11",
        catalog,
    });
    searchTool.register(registrar);

    const executeTool = makeExecuteTool({
        prefix: "icd11",
        // Verifiable provenance: icd11_execute results carry a _meta.citation.
        // The descriptor is chosen from THIS deployment's real credential state
        // and names every upstream that state can reach — see icd11Source above
        // for why it names the tier rather than a single origin.
        source: icd11Source(liveApi),
        catalog,
        apiFetch,
        maxInlineBytes: 30 * 1024,
        stagingThreshold: 30 * 1024,
        preserveApiErrors: true,
        timeout: 90_000,
        doNamespace: env.ICD11_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(registrar);
}
