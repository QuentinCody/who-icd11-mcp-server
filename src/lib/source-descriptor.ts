import type { SourceDescriptor } from "@bio-mcp/shared";

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
