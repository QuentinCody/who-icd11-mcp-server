import type { McpServer } from "@bio-mcp/shared/mcp";
import { icd11Response } from "../lib/tool-result";
import { z } from "zod";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";

interface SchemaEnv {
    ICD11_DATA_DO?: unknown;
}

export function registerGetSchema(server: McpServer, env?: SchemaEnv): void {
    const handler = createGetSchemaHandler("ICD11_DATA_DO", "icd11");

    for (const name of ["icd11_get_schema", "mcp_icd11_get_schema"]) server.registerTool(
        name,
        {
            title: "Get Staged Data Schema",
            description:
                "Get schema information for staged ICD-11 data. Shows table structures and row counts. " +
                "If called without a data_access_id, lists all staged datasets available in this session.",
            inputSchema: {
                data_access_id: z
                    .string()
                    .min(1)
                    .optional()
                    .describe(
                        "Data access ID for the staged dataset. If omitted, lists all staged datasets in this session.",
                    ),
            },
        },
        async (args, extra) => {
            const runtimeEnv =
                env || (extra as { env?: SchemaEnv })?.env || {};
            return icd11Response(() => handler(
                args as Record<string, unknown>,
                runtimeEnv as Record<string, unknown>,
                (extra as Record<string, unknown>),
            ), runtimeEnv, name, extra, args);
        },
    );
}
