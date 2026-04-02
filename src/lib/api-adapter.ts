import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { icd11Fetch } from "./http";

interface Icd11Env {
    ICD11_CLIENT_ID: string;
    ICD11_CLIENT_SECRET: string;
}

/**
 * Create an ApiFetchFn for ICD-11 Code Mode execution.
 * Delegates all requests to icd11Fetch which handles OAuth automatically.
 */
export function createIcd11ApiFetch(env: Icd11Env): ApiFetchFn {
    return async (request) => {
        let path = request.path;

        // Build query string from params if present
        if (request.params && Object.keys(request.params).length > 0) {
            const qs = new URLSearchParams();
            for (const [key, value] of Object.entries(request.params)) {
                if (value !== undefined && value !== null) {
                    qs.set(key, String(value));
                }
            }
            const qsStr = qs.toString();
            if (qsStr) {
                path = `${path}${path.includes("?") ? "&" : "?"}${qsStr}`;
            }
        }

        const response = await icd11Fetch(path, env);

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(
                `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
            ) as Error & { status: number; data: unknown };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }

        const data = await response.json();
        return { status: response.status, data };
    };
}
