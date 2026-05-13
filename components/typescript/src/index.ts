import "dotenv/config";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createAgent, ToolMessage } from "langchain";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type WebSocket from "ws";
import { iife, writableIterator } from "./utils";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { CARTESIA_TTS_SYSTEM_PROMPT, CartesiaTTS } from "./cartesia";
import { AssemblyAISTT } from "./assemblyai/index";
import type { VoiceAgentEvent } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_DIR = path.join(__dirname, "../../web/dist");
const PORT = parseInt(process.env.PORT ?? "8000");

if (!existsSync(STATIC_DIR)) {
  console.error(
    `Web build not found at ${STATIC_DIR}.\n` +
      "Run 'make build-web' or 'make dev-ts' from the project root."
  );
  process.exit(1);
}

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use("/*", cors());

type OrderStatus = "new" | "preparing" | "ready" | "delivered";

interface KitchenOrder {
  id: string;
  items: string[];
  summary: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
}

interface SessionOrderState {
  items: { item: string; quantity: number }[];
  lastConfirmedOrderId?: string;
}

type KitchenClientMessage = {
  type: "update_order_status";
  orderId: string;
  status: OrderStatus;
};

type KitchenServerEvent =
  | { type: "orders_snapshot"; orders: KitchenOrder[]; ts: number }
  | { type: "order_created"; order: KitchenOrder; ts: number }
  | { type: "order_updated"; order: KitchenOrder; ts: number };

const orders = new Map<string, KitchenOrder>();
const kitchenSockets = new Set<WSContext<WebSocket>>();
const sessionOrderState = new Map<string, SessionOrderState>();

function getSessionOrderState(threadId: string): SessionOrderState {
  const existing = sessionOrderState.get(threadId);
  if (existing) return existing;

  const state: SessionOrderState = { items: [] };
  sessionOrderState.set(threadId, state);
  return state;
}

function parseOrderItems(orderSummary: string): string[] {
  return orderSummary
    .split(/\n|,|;/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function serializeOrder(order: KitchenOrder): KitchenOrder {
  return { ...order, items: [...order.items] };
}

function getOrdersSnapshot(): KitchenOrder[] {
  return [...orders.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map(serializeOrder);
}

function getVisibleKitchenOrdersSnapshot(): KitchenOrder[] {
  return getOrdersSnapshot().filter((order) => order.status !== "delivered");
}

function getLatestOrder(): KitchenOrder | undefined {
  return getOrdersSnapshot().at(-1);
}

function getStatusLabel(status: OrderStatus): string {
  const labels: Record<OrderStatus, string> = {
    new: "nuevo",
    preparing: "en preparacion",
    ready: "listo",
    delivered: "entregado",
  };

  return labels[status];
}

function formatOrderItems(items: { item: string; quantity: number }[]): string[] {
  return items.map(({ item, quantity }) => `${quantity} x ${item}`);
}

function broadcastKitchenEvent(event: KitchenServerEvent) {
  const payload = JSON.stringify(event);
  for (const ws of kitchenSockets) {
    ws.send(payload);
  }
}

function createKitchenOrder(orderSummary: string): KitchenOrder {
  const now = new Date().toISOString();
  const orderNumber = orders.size + 1;
  const order: KitchenOrder = {
    id: `ORD-${orderNumber.toString().padStart(3, "0")}`,
    items: parseOrderItems(orderSummary),
    summary: orderSummary,
    status: "new",
    createdAt: now,
    updatedAt: now,
  };

  if (order.items.length === 0) {
    order.items = [orderSummary];
  }

  orders.set(order.id, order);
  broadcastKitchenEvent({
    type: "order_created",
    order: serializeOrder(order),
    ts: Date.now(),
  });

  return order;
}

function updateOrderStatus(orderId: string, status: OrderStatus) {
  const order = orders.get(orderId);
  if (!order) return;

  order.status = status;
  order.updatedAt = new Date().toISOString();
  broadcastKitchenEvent({
    type: "order_updated",
    order: serializeOrder(order),
    ts: Date.now(),
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";

  const candidate = message as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof candidate.text === "string") {
    return candidate.text;
  }

  if (typeof candidate.content === "string") {
    return candidate.content;
  }

  if (Array.isArray(candidate.content)) {
    return candidate.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }

  return "";
}

function getMessageToolCalls(message: unknown) {
  if (!message || typeof message !== "object") return [];

  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls) ? toolCalls : [];
}

function createSessionTools(threadId: string) {
  const addToOrder = tool(
    async ({ item, quantity }) => {
      const state = getSessionOrderState(threadId);
      state.items.push({ item, quantity });
      return `Added ${quantity} x ${item} to the order.`;
    },
    {
      name: "add_to_order",
      description: "Add an item to the customer's sandwich order.",
      schema: z.object({
        item: z.string(),
        quantity: z.number(),
      }),
    }
  );

  const confirmOrder = tool(
    async ({ orderSummary }) => {
      const state = getSessionOrderState(threadId);
      const activeItems = formatOrderItems(state.items);
      const finalSummary =
        activeItems.length > 0 ? activeItems.join(", ") : orderSummary;
      const order = createKitchenOrder(finalSummary);

      state.items = [];
      state.lastConfirmedOrderId = order.id;

      return `Pedido ${order.id} confirmado y enviado a cocina: ${finalSummary}.`;
    },
    {
      name: "confirm_order",
      description: "Confirm the final order with the customer.",
      schema: z.object({
        orderSummary: z.string().describe("Summary of the order"),
      }),
    }
  );

  const getOrderStatus = tool(
    async ({ orderId }) => {
      const normalizedOrderId =
        typeof orderId === "string" && orderId.trim()
          ? orderId.trim().toUpperCase()
          : "";
      const state = getSessionOrderState(threadId);
      const order = normalizedOrderId
        ? orders.get(normalizedOrderId)
        : state.lastConfirmedOrderId
          ? orders.get(state.lastConfirmedOrderId)
          : getLatestOrder();

      if (!order) {
        return "No hay pedidos registrados en cocina todavia.";
      }

      if (order.status === "delivered") {
        return `Aca esta tu pedido ${order.id}. Lleva: ${order.items.join(", ")}.`;
      }

      return `El pedido ${order.id} esta ${getStatusLabel(order.status)}. Lleva: ${order.items.join(", ")}.`;
    },
    {
      name: "get_order_status",
      description:
        "Check the current kitchen status for a specific order ID, or the latest order if no ID is provided.",
      schema: z.object({
        orderId: z
          .string()
          .optional()
          .describe("Order ID, for example ORD-001. Leave empty for latest order."),
      }),
    }
  );

  return [addToOrder, confirmOrder, getOrderStatus];
}

const systemPrompt = `
Eres una asistente de voz profesional, clara y amable.
Responde en español por defecto, salvo que el usuario te pida otro idioma.
Tu trabajo principal es tomar pedidos para una tienda de sandwiches.
Usa add_to_order cuando el cliente agregue productos o ingredientes al pedido.
Usa confirm_order solo cuando el cliente confirme que el pedido esta listo para enviarse a cocina.
Despues de usar confirm_order, considera ese pedido cerrado. Si el cliente pide algo mas en la misma sesion, empieza un pedido nuevo y no incluyas productos ya enviados a cocina.
Usa get_order_status cuando el cliente pregunte por el estado de su pedido en cocina. Si no da identificador, consulta el pedido mas reciente.
Si get_order_status indica que el pedido fue entregado, responde diciendo "Aca esta tu pedido", el numero del pedido y lo que lleva.
Antes de confirmar, resume el pedido y pide una confirmacion breve si todavia no la recibiste.
Sé breve: responde en una o tres frases, y evita hablar demasiado.
Si necesitas más información, haz una sola pregunta clara.
No inventes datos. Si no sabes algo, dilo de forma profesional.

Para la voz, usa un estilo sereno, seguro y profesional. Evita sonar exagerada, infantil o demasiado casual.

${CARTESIA_TTS_SYSTEM_PROMPT}
`;

/**
 * Transform stream: Audio (Uint8Array) → Voice Events (VoiceAgentEvent)
 *
 * This function takes a stream of audio chunks and sends them to AssemblyAI for STT.
 *
 * It uses a producer-consumer pattern where:
 * - Producer: Reads audio chunks from audioStream and sends them to AssemblyAI
 * - Consumer: Receives transcription events from AssemblyAI and yields them
 *
 * @param audioStream - Async iterator of PCM audio bytes (16-bit, mono, 16kHz)
 * @returns Async generator yielding STT events (stt_chunk for partials, stt_output for final transcripts)
 */
async function* sttStream(
  audioStream: AsyncIterable<Uint8Array>
): AsyncGenerator<VoiceAgentEvent> {
  const stt = new AssemblyAISTT({ sampleRate: 16000 });
  const passthrough = writableIterator<VoiceAgentEvent>();

  /**
   * Promise that pumps audio chunks to AssemblyAI.
   *
   * This runs concurrently with the consumer, continuously reading audio
   * chunks from the input stream and forwarding them to AssemblyAI.
   * This allows transcription to begin before all audio has arrived.
   */
  const producer = iife(async () => {
    try {
      // Stream each audio chunk to AssemblyAI as it arrives
      for await (const audioChunk of audioStream) {
        await stt.sendAudio(audioChunk);
      }
    } catch (error) {
      passthrough.push({
        type: "pipeline_error",
        stage: "stt",
        message: getErrorMessage(error),
        ts: Date.now(),
      });
    } finally {
      // Signal to AssemblyAI that audio streaming is complete
      await stt.close().catch(() => undefined);
    }
  });

  /**
   * Promise that receives transcription events from AssemblyAI.
   *
   * This runs concurrently with the producer, listening for STT events
   * and pushing them into the passthrough iterator for downstream stages.
   */
  const consumer = iife(async () => {
    try {
      for await (const event of stt.receiveEvents()) {
        passthrough.push(event);
      }
    } catch (error) {
      passthrough.push({
        type: "pipeline_error",
        stage: "stt",
        message: getErrorMessage(error),
        ts: Date.now(),
      });
    }
  });

  try {
    // Yield events as they arrive from the consumer
    yield* passthrough;
  } finally {
    // Wait for the producer and consumer to complete when cleaning up
    await Promise.allSettled([producer, consumer]);
  }
}

/**
 * Transform stream: Voice Events → Voice Events (with Agent Responses)
 *
 * This function takes a stream of upstream voice agent events and processes them.
 * When an stt_output event arrives, it passes the transcript to the LangChain agent.
 * The agent streams back its response tokens as agent_chunk events.
 * Tool calls and results are also emitted as separate events.
 * All other upstream events are passed through unchanged.
 *
 * @param eventStream - An async iterator of upstream voice agent events
 * @returns Async generator yielding all upstream events plus agent_chunk, tool_call, and tool_result events
 */
async function* agentStream(
  eventStream: AsyncIterable<VoiceAgentEvent>
): AsyncGenerator<VoiceAgentEvent> {
  // Generate a unique thread ID for this conversation session
  // This allows the agent to maintain conversation context across multiple turns
  // using the checkpointer (MemorySaver) configured in the agent
  const threadId = uuidv4();
  const sessionAgent = createAgent({
    model: "openai:gpt-4o-mini",
    tools: createSessionTools(threadId),
    checkpointer: new MemorySaver(),
    systemPrompt: systemPrompt,
  });

  for await (const event of eventStream) {
    yield event;
    if (event.type === "stt_output") {
      try {
        const stream = await sessionAgent.stream(
          { messages: [new HumanMessage(event.transcript)] },
          {
            configurable: { thread_id: threadId },
            streamMode: "messages",
          }
        );

        for await (const [message] of stream) {
          if (!ToolMessage.isInstance(message)) {
            const text = getMessageText(message);
            if (text) {
              yield { type: "agent_chunk", text, ts: Date.now() };
            }

            for (const toolCall of getMessageToolCalls(message)) {
              yield {
                type: "tool_call",
                id: toolCall.id ?? uuidv4(),
                name: toolCall.name,
                args: toolCall.args,
                ts: Date.now(),
              };
            }
          }
          if (ToolMessage.isInstance(message)) {
            yield {
              type: "tool_result",
              toolCallId: message.tool_call_id ?? "",
              name: message.name ?? "unknown",
              result:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
              ts: Date.now(),
            };
          }
        }
      } catch (error) {
        yield {
          type: "pipeline_error",
          stage: "agent",
          message: getErrorMessage(error),
          ts: Date.now(),
        };
      }

      // Signal that the agent has finished responding for this turn
      yield { type: "agent_end", ts: Date.now() };
    }
  }
}

/**
 * Transform stream: Voice Events → Voice Events (with Audio)
 *
 * This function takes a stream of upstream voice agent events and processes them.
 * When agent_chunk events arrive, it sends the text to ElevenLabs for TTS synthesis.
 * Audio is streamed back as tts_chunk events as it's generated.
 * All upstream events are passed through unchanged.
 *
 * It uses a producer-consumer pattern where:
 * - Producer: Reads events from eventStream, passes them through, and sends agent text to ElevenLabs
 * - Consumer: Receives audio chunks from ElevenLabs and yields them as tts_chunk events
 *
 * @param eventStream - An async iterator of upstream voice agent events
 * @returns Async generator yielding all upstream events plus tts_chunk events for synthesized audio
 */
async function* ttsStream(
  eventStream: AsyncIterable<VoiceAgentEvent>
): AsyncGenerator<VoiceAgentEvent> {
  const tts = new CartesiaTTS({
    voiceId: "15d0c2e2-8d29-44c3-be23-d585d5f154a1",
    language: "es",
  });
  const passthrough = writableIterator<VoiceAgentEvent>();

  /**
   * Promise that reads events from the upstream stream and sends text to Cartesia.
   *
   * This runs concurrently with the consumer, continuously reading events
   * from the upstream stream and forwarding agent text to Cartesia for synthesis.
   * All events are passed through to the downstream via the passthrough iterator.
   * This allows audio generation to begin before the agent has finished generating.
   */
  const producer = iife(async () => {
    try {
      let buffer: string[] = [];
      for await (const event of eventStream) {
        // Pass through all events to downstream consumers
        passthrough.push(event);
        // Send agent text chunks to Cartesia for synthesis
        if (event.type === "agent_chunk") {
          buffer.push(event.text);
        }
        // Send all buffered text to Cartesia for synthesis
        if (event.type === "agent_end") {
          await tts.sendText(buffer.join(""));
          buffer = [];
        }
      }
    } catch (error) {
      passthrough.push({
        type: "pipeline_error",
        stage: "tts",
        message: getErrorMessage(error),
        ts: Date.now(),
      });
    } finally {
      // Signal to Cartesia that text sending is complete
      await tts.close().catch(() => undefined);
    }
  });

  /**
   * Promise that receives audio events from Cartesia.
   *
   * This runs concurrently with the producer, listening for TTS audio chunks
   * and pushing them into the passthrough iterator for downstream stages.
   */
  const consumer = iife(async () => {
    try {
      for await (const event of tts.receiveEvents()) {
        passthrough.push(event);
      }
    } catch (error) {
      passthrough.push({
        type: "pipeline_error",
        stage: "tts",
        message: getErrorMessage(error),
        ts: Date.now(),
      });
    }
  });

  try {
    // Yield events as they arrive from both producer (upstream) and consumer (TTS)
    yield* passthrough;
  } finally {
    // Wait for the producer and consumer to complete when cleaning up
    await Promise.allSettled([producer, consumer]);
  }
}

app.get(
  "/kitchen-ws",
  upgradeWebSocket(() => {
    return {
      onOpen(_, ws) {
        kitchenSockets.add(ws);
        ws.send(
          JSON.stringify({
            type: "orders_snapshot",
            orders: getVisibleKitchenOrdersSnapshot(),
            ts: Date.now(),
          } satisfies KitchenServerEvent)
        );
      },
      onMessage(event) {
        if (typeof event.data !== "string") return;

        try {
          const message = JSON.parse(event.data) as KitchenClientMessage;
          if (message.type === "update_order_status") {
            updateOrderStatus(message.orderId, message.status);
          }
        } catch (err) {
          console.error("Invalid kitchen message", err);
        }
      },
      onClose(_, ws) {
        kitchenSockets.delete(ws);
      },
    };
  })
);

app.get("/kitchen", (c) =>
  c.html(readFileSync(path.join(STATIC_DIR, "index.html"), "utf8"))
);

app.get("/*", serveStatic({ root: STATIC_DIR }));

app.get(
  "/ws",
  upgradeWebSocket(async () => {
    let currentSocket: WSContext<WebSocket> | undefined;

    // Create a writable stream for incoming WebSocket audio data
    const inputStream = writableIterator<Uint8Array>();

    // Define the voice processing pipeline as a chain of async generators
    // Audio -> STT events
    const transcriptEventStream = sttStream(inputStream);
    // STT events -> STT Events + Agent events
    const agentEventStream = agentStream(transcriptEventStream);
    // STT events + Agent events -> STT Events + Agent Events + TTS events
    const outputEventStream = ttsStream(agentEventStream);

    const flushPromise = iife(async () => {
      // Process all events from the pipeline, sending events back to the client
      for await (const event of outputEventStream) {
        currentSocket?.send(JSON.stringify(event));
      }
    });

    return {
      onOpen(_, ws) {
        currentSocket = ws;
      },
      onMessage(event) {
        // Push incoming audio data into the pipeline's input stream
        const data = event.data;
        if (Buffer.isBuffer(data)) {
          inputStream.push(new Uint8Array(data));
        } else if (data instanceof ArrayBuffer) {
          inputStream.push(new Uint8Array(data));
        }
      },
      async onClose() {
        // Signal end of stream when socket closes
        inputStream.cancel();
        await flushPromise;
      },
    };
  })
);

const server = serve({
  fetch: app.fetch,
  port: PORT,
});

injectWebSocket(server);

console.log(`Server is running on port ${PORT}`);
