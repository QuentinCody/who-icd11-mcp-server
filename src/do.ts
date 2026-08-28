import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class Icd11DataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        const obj = data as Record<string, unknown>;

        // Keyless tier: rows from WHO's MMS release file or the NLM mirror.
        if (obj.tier === "keyless_offline" && Array.isArray(obj.results)) {
            return {
                tableName: "mms_rows",
                indexes: [
                    "code",
                    "title",
                    "chapter_no",
                    "class_kind",
                    "entity_id",
                    "parent_entity_id",
                    "block_id",
                ],
            };
        }

        // ICD-11 entity response (single entity with @context, @id, title)
        if (obj["@context"] || obj["@id"]) {
            if (obj.title || obj.definition) {
                return {
                    tableName: "entity",
                    indexes: ["code", "title"],
                };
            }
        }

        // Search results (destinationEntities array from /entity/search or linearization/search)
        if (obj.destinationEntities && Array.isArray(obj.destinationEntities)) {
            return {
                tableName: "search_results",
                indexes: ["theCode", "title", "score"],
            };
        }

        // Linearization root or code lookup (has child array)
        if (obj.child && Array.isArray(obj.child)) {
            return {
                tableName: "linearization",
                indexes: ["code", "title"],
            };
        }

        // Autocode results
        if (obj.matchScore !== undefined || obj.foundationURI) {
            return {
                tableName: "autocode_results",
                indexes: ["matchScore", "theCode"],
            };
        }

        if (Array.isArray(data)) {
            const sample = data[0];
            if (sample && typeof sample === "object") {
                const s = sample as Record<string, unknown>;
                // Array of entities
                if (s["@id"] || s.title || s.theCode) {
                    return {
                        tableName: "entities",
                        indexes: ["theCode", "title"],
                    };
                }
            }
        }

        return undefined;
    }
}
