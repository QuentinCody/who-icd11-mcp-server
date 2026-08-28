import type { SourceDescriptor } from "@bio-mcp/shared";
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

/**
 * Verifiable provenance for icd11_execute.
 *
 * A citation is issued ONCE per program, but this server has more than one
 * upstream per tier: the keyless tier answers from WHO's MMS release archive
 * (icdcdn.who.int) AND from the NLM Clinical Tables mirror
 * (clinicaltables.nlm.nih.gov), and one program may read from both. There is
 * no per-call seam to thread the answering upstream through — the factory reads
 * `options.source` once, after the whole program has run, and `ApiFetchFn`
 * receives no execution identity it could be keyed by.
 *
 * So the descriptor names the TIER and every upstream that tier can reach,
 * never one of them. A citation that says "one of these two" is true of every
 * result; a citation that says "icdcdn.who.int" is false of an NLM answer, and
 * a false origin is worse than a broad one. The exact answering upstream is
 * still machine-readable per call: every /offline response carries
 * `provenance.source` and `provenance.source_url`.
 *
 * `url` is deliberately absent for the same reason — no single URL is true of
 * every result these tiers return.
 */
export const ICD11_KEYLESS_SOURCE: SourceDescriptor = {
    id: "icd11-keyless",
    name:
        "WHO ICD-11 keyless tier — the MMS release archive (icdcdn.who.int) and the " +
        "NLM Clinical Tables ICD-11 mirror (clinicaltables.nlm.nih.gov). This deployment " +
        "holds no WHO credential, so no byte here came from the gated id.who.int API. " +
        "Which of the two upstreams answered a given call is in that call's provenance " +
        "block (provenance.source, provenance.source_url).",
};

/**
 * A credential unlocks the gated API but does NOT close the keyless paths: an
 * /offline/* call is still served from the release file or the NLM mirror, so a
 * credentialed deployment has three possible upstreams and the same rule holds.
 */
export const ICD11_CREDENTIALED_SOURCE: SourceDescriptor = {
    id: "icd11-credentialed",
    name:
        "WHO ICD-11 credentialed tier — the gated ICD-11 API (id.who.int), the MMS " +
        "release archive (icdcdn.who.int) and the NLM Clinical Tables ICD-11 mirror " +
        "(clinicaltables.nlm.nih.gov), all reachable from this deployment. Which one " +
        "answered a given call is in that call's provenance block for the keyless " +
        "paths, and in the response body for the gated API.",
};

/** The descriptor for THIS deployment's real credential state. */
export function icd11Source(liveApi: boolean): SourceDescriptor {
    return liveApi ? ICD11_CREDENTIALED_SOURCE : ICD11_KEYLESS_SOURCE;
}

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

    const searchTool = createSearchTool({
        prefix: "icd11",
        catalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = makeExecuteTool({
        prefix: "icd11",
        // Verifiable provenance: icd11_execute results carry a _meta.citation.
        // The descriptor is chosen from THIS deployment's real credential state
        // and names every upstream that state can reach — see icd11Source above
        // for why it names the tier rather than a single origin.
        source: icd11Source(liveApi),
        catalog,
        apiFetch,
        doNamespace: env.ICD11_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
