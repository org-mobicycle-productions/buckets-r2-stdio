import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { lookup } from "mime-types";
import { z } from "zod";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const accountId = process.env.CF_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY;
    const secretKey = process.env.R2_SECRET_KEY;

    if (!accountId || !accessKey || !secretKey) {
      throw new Error("Missing required env vars: CF_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY");
    }

    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
    });
  }
  return s3Client;
}

const server = new McpServer({
  name: "productions-r2-buckets",
  version: "1.0.0",
});

server.tool("list_buckets", "List all R2 buckets", {}, async () => {
  try {
    const client = getS3Client();
    const response = await client.send(new ListBucketsCommand({}));
    const buckets = (response.Buckets ?? []).map((b) => ({
      name: b.Name,
      creationDate: b.CreationDate?.toISOString(),
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify({ buckets }, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
  }
});

server.tool(
  "list_objects",
  "List objects in an R2 bucket with optional prefix filter",
  {
    bucket: z.string().describe("The R2 bucket name"),
    prefix: z.string().optional().describe("Optional prefix to filter objects"),
    maxKeys: z.number().optional().describe("Maximum number of keys to return"),
    continuationToken: z.string().optional().describe("Token for paginating results"),
  },
  async ({ bucket, prefix, maxKeys, continuationToken }) => {
    try {
      const client = getS3Client();
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken,
        })
      );
      const result = {
        objects: (response.Contents ?? []).map((obj) => ({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
          etag: obj.ETag,
        })),
        isTruncated: response.IsTruncated,
        nextContinuationToken: response.NextContinuationToken,
        keyCount: response.KeyCount,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "get_object",
  "Download an object from R2. Returns text for text/* types, base64 for binary.",
  {
    bucket: z.string().describe("The R2 bucket name"),
    key: z.string().describe("The object key (path)"),
  },
  async ({ bucket, key }) => {
    try {
      const client = getS3Client();
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const contentType = response.ContentType || lookup(key) || "application/octet-stream";
      const body = response.Body;

      if (!body) {
        return { content: [{ type: "text" as const, text: "Error: Empty response body" }], isError: true };
      }

      const bytes = await body.transformToByteArray();

      if (contentType.startsWith("text/") || contentType === "application/json" || contentType.includes("csv")) {
        const text = new TextDecoder().decode(bytes);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ key, contentType, size: response.ContentLength, content: text }, null, 2),
          }],
        };
      }

      const base64 = Buffer.from(bytes).toString("base64");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            key, contentType, size: response.ContentLength,
            encoding: "base64", content: base64,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "put_object",
  "Upload a file to an R2 bucket",
  {
    bucket: z.string().describe("The R2 bucket name"),
    key: z.string().describe("The object key (path)"),
    content: z.string().describe("The content to upload"),
    contentType: z.string().optional().describe("MIME type (auto-detected from key if not provided)"),
    isBase64: z.boolean().optional().describe("If true, decode content from base64 before uploading"),
  },
  async ({ bucket, key, content, contentType, isBase64 }) => {
    try {
      const client = getS3Client();
      const resolvedContentType = contentType || lookup(key) || "application/octet-stream";
      const body = isBase64 ? Buffer.from(content, "base64") : content;

      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: resolvedContentType })
      );
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, bucket, key, contentType: resolvedContentType }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "delete_object",
  "Delete an object from an R2 bucket",
  {
    bucket: z.string().describe("The R2 bucket name"),
    key: z.string().describe("The object key (path)"),
  },
  async ({ bucket, key }) => {
    try {
      const client = getS3Client();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, deleted: { bucket, key } }, null, 2) }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "head_object",
  "Get metadata for an R2 object (content type, size, last modified, etag)",
  {
    bucket: z.string().describe("The R2 bucket name"),
    key: z.string().describe("The object key (path)"),
  },
  async ({ bucket, key }) => {
    try {
      const client = getS3Client();
      const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            key,
            contentType: response.ContentType,
            contentLength: response.ContentLength,
            lastModified: response.LastModified?.toISOString(),
            etag: response.ETag,
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("productions-r2-buckets MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
