import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !accountId) {
  console.error(
    "Error: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars are required"
  );
  process.exit(1);
}

const server = new McpServer({
  name: "cloudflare-r2",
  version: "1.0.0",
});

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}


function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}


async function cfFetch(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const data = (await res.json()) as {
    success?: boolean;
    errors?: Array<{ message: string }>;
  };

  if (!res.ok || !data.success) {
    const errorMsg =
      data.errors?.[0]?.message || `API error: ${res.statusText}`;
    throw new Error(errorMsg);
  }

  return data;
}

server.tool(
  "r2_list_buckets",
  "List all R2 buckets",
  {
    name_contains: z.string().optional(),
    per_page: z.number().optional(),
    cursor: z.string().optional(),
  },
  async (params) => {
    try {
      const searchParams = new URLSearchParams();
      if (params.name_contains) searchParams.append("name_contains", params.name_contains);
      if (params.per_page) searchParams.append("per_page", String(params.per_page));
      if (params.cursor) searchParams.append("cursor", params.cursor);

      const query = searchParams.toString();
      const path = `/accounts/${accountId}/r2/buckets${query ? `?${query}` : ""}`;
      const data = await cfFetch("GET", path);
      return json(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "r2_create_bucket",
  "Create a new R2 bucket",
  {
    name: z.string(),
    location_hint: z.string().optional(),
  },
  async (params) => {
    try {
      const path = `/accounts/${accountId}/r2/buckets`;
      const body: Record<string, unknown> = { name: params.name };
      if (params.location_hint) body.location_hint = params.location_hint;
      const data = await cfFetch("POST", path, body);
      return json(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "r2_get_bucket",
  "Get bucket details",
  {
    name: z.string(),
  },
  async (params) => {
    try {
      const path = `/accounts/${accountId}/r2/buckets/${params.name}`;
      const data = await cfFetch("GET", path);
      return json(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "r2_delete_bucket",
  "Delete an R2 bucket",
  {
    name: z.string(),
  },
  async (params) => {
    try {
      const path = `/accounts/${accountId}/r2/buckets/${params.name}`;
      const data = await cfFetch("DELETE", path);
      return json(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "r2_get_usage",
  "Get R2 storage usage summary",
  {},
  async () => {
    try {
      const path = `/accounts/${accountId}/r2/usage`;
      const data = await cfFetch("GET", path);
      return json(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "r2_status",
  "Show server config and connection info",
  {},
  async () => {
    try {
      return json({
        server: "cloudflare-r2",
        version: "1.0.0",
        accountId,
        tokenStatus: "configured",
      });
    } catch (e) {
      return err(e);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Cloudflare R2 MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
