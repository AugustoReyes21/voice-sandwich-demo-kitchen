import WebSocket from "ws";
import { writableIterator } from "../utils";
import type { AssemblyAISpeechModel, AssemblyAISTTMessage } from "./api-types";
import type { VoiceAgentEvent } from "../types";

interface AssemblyAISTTOptions {
  apiKey?: string;
  sampleRate?: number;
  formatTurns?: boolean;
  speechModel?: AssemblyAISpeechModel;
  endOfTurnConfidenceThreshold?: number;
  minEndOfTurnSilenceWhenConfident?: number;
  maxTurnSilence?: number;
}

export class AssemblyAISTT {
  apiKey: string;
  sampleRate: number;
  formatTurns: boolean;
  speechModel: AssemblyAISpeechModel;
  endOfTurnConfidenceThreshold: number;
  minEndOfTurnSilenceWhenConfident: number;
  maxTurnSilence: number;

  protected _bufferIterator = writableIterator<VoiceAgentEvent.STTEvent>();
  protected _connectionPromise: Promise<WebSocket> | null = null;
  protected _finalizedTurns = new Set<number>();
  protected get _connection(): Promise<WebSocket> {
    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    this._connectionPromise = new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        sample_rate: this.sampleRate.toString(),
        format_turns: this.formatTurns.toString().toLowerCase(),
        speech_model: this.speechModel,
        end_of_turn_confidence_threshold:
          this.endOfTurnConfidenceThreshold.toString(),
        min_end_of_turn_silence_when_confident:
          this.minEndOfTurnSilenceWhenConfident.toString(),
        max_turn_silence: this.maxTurnSilence.toString(),
      });

      const url = `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
      const ws = new WebSocket(url, {
        headers: { Authorization: this.apiKey },
      });

      ws.on("open", () => {
        resolve(ws);
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const message: AssemblyAISTTMessage = JSON.parse(data.toString());
          if (message.type === "Begin") {
            // no-op
          } else if (message.type === "Turn" && message.transcript) {
            if (message.end_of_turn) {
              if (!this._finalizedTurns.has(message.turn_order)) {
                this._finalizedTurns.add(message.turn_order);
                this._bufferIterator.push({
                  type: "stt_output",
                  transcript: message.transcript,
                  ts: Date.now(),
                });
              }
            } else if (!message.turn_is_formatted) {
              this._bufferIterator.push({
                type: "stt_chunk",
                transcript: message.transcript,
                ts: Date.now(),
              });
            }
          } else if (message.type === "Termination") {
            // no-op
          } else if (message.type === "Error") {
            throw new Error(message.error);
          }
        } catch (error) {
          // TODO: better catch json parsing error
          console.error(error);
        }
      });

      ws.on("error", (error) => {
        this._bufferIterator.cancel();
        reject(error);
      });

      ws.on("close", () => {
        this._connectionPromise = null;
      });
    });

    return this._connectionPromise;
  }

  constructor(options: AssemblyAISTTOptions) {
    this.apiKey = options.apiKey || process.env.ASSEMBLYAI_API_KEY || "";
    this.sampleRate = options.sampleRate || 16000;
    this.formatTurns = options.formatTurns ?? false;
    this.speechModel = options.speechModel ?? "universal-streaming-multilingual";
    this.endOfTurnConfidenceThreshold =
      options.endOfTurnConfidenceThreshold ?? 0.4;
    this.minEndOfTurnSilenceWhenConfident =
      options.minEndOfTurnSilenceWhenConfident ?? 160;
    this.maxTurnSilence = options.maxTurnSilence ?? 400;

    if (!this.apiKey) {
      throw new Error("AssemblyAI API key is required");
    }
  }

  async sendAudio(buffer: Uint8Array): Promise<void> {
    const conn = await this._connection;
    conn.send(buffer);
  }

  async *receiveEvents(): AsyncGenerator<VoiceAgentEvent.STTEvent> {
    yield* this._bufferIterator;
  }

  async close(): Promise<void> {
    if (this._connectionPromise) {
      const ws = await this._connectionPromise;
      ws.close();
    }
  }
}
