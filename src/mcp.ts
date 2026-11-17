import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ClasseVivaClient } from "./classeviva.js";
import { registerTools, type ToolDefaults } from "./tools.js";

export const VERSION = "2.2.0";

function buildServer(getClient: () => ClasseVivaClient, defaults: ToolDefaults = {}): McpServer {
  const server = new McpServer(
    { name: "classeviva", version: VERSION },
    {
      instructions:
        "Accesso in sola lettura al registro elettronico ClasseViva (Spaggiari) dello studente: voti, agenda (compiti e verifiche), " +
        "argomenti delle lezioni, assenze (anche ore di assenza rispetto al limite del 25% con get_absence_hours), bacheca, note, materie, periodi, didattica, calendario, e lettura dei file allegati (get_file: didattica, circolari, compiti). Date in formato YYYY-MM-DD, fuso Europe/Rome. " +
        "ClasseViva fornisce solo l'anno scolastico in corso.",
    },
  );
  registerTools(server, getClient, defaults);
  return server;
}

/**
 * Gestisce una richiesta MCP (Streamable HTTP) in modalità stateless:
 * server + transport nuovi a ogni richiesta; la sessione ClasseViva resta nel client in cache.
 */
export async function handleMcp(req: Request, getClient: () => ClasseVivaClient, defaults: ToolDefaults = {}): Promise<Response> {
  const server = buildServer(getClient, defaults);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    queueMicrotask(() => { void transport.close(); void server.close(); });
  }
}
