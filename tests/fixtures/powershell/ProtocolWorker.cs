using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace WorldHub.Phase7
{
    // External test program. Its optional echo workflow is not part of HubBridge.
    public sealed class ProtocolWorker
    {
        private readonly HubBridge transport;
        private readonly string echoTopic;
        private readonly int timeoutMs;
        private readonly int maxCommandChars;
        private readonly JsonDocumentOptions jsonDocumentOptions;
        private readonly JsonSerializerOptions jsonSerializerOptions;
        private readonly StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false, 4096);
        private readonly StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 4096) { AutoFlush = true };
        private readonly SemaphoreSlim outputGate = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private int requestedClose;
        private int exitCode;

        private ProtocolWorker(string echoTopic, int timeoutMs, int maxFrameBytes)
        {
            this.echoTopic = echoTopic;
            this.timeoutMs = timeoutMs;
            maxCommandChars = checked(maxFrameBytes * 2 + 4096);
            // Raw transport is byte bounded; diagnostic parsing must not invent a 64-level body schema.
            jsonDocumentOptions = new JsonDocumentOptions { MaxDepth = maxFrameBytes };
            jsonSerializerOptions = new JsonSerializerOptions { MaxDepth = maxFrameBytes };
            transport = new HubBridge(maxFrameBytes, Math.Max((long)maxFrameBytes * 2, 8388608));
        }

        public static async Task<int> RunAsync(string url, string bridge, string credential, string token, string echoTopic, string version, int timeoutMs = 10000, int maxFrameBytes = 4194304)
        {
            var worker = new ProtocolWorker(echoTopic, timeoutMs, maxFrameBytes);
            try
            {
                await worker.transport.ConnectAsync(url, timeoutMs).ConfigureAwait(false);
                var hello = new Dictionary<string, object> { ["type"] = "hello", ["wire"] = "0.1", ["bridge"] = bridge };
                if (!string.IsNullOrEmpty(credential)) hello["credential"] = credential;
                if (!string.IsNullOrEmpty(token)) hello["token"] = token;
                await worker.transport.SendRawAsync(JsonSerializer.Serialize(hello), timeoutMs).ConfigureAwait(false);
                string raw = await worker.transport.ReceiveRawAsync(timeoutMs).ConfigureAwait(false);
                JsonElement welcome = await worker.FrameAsync(raw).ConfigureAwait(false);
                string type = Field(welcome, "type");
                if (type == "denied" || type == "error") throw Failure(welcome);
                if (type != "welcome") throw new BridgeFailure("WELCOME_REQUIRED", "Expected welcome after hello.");
                if (!string.IsNullOrEmpty(echoTopic)) await worker.SubscribeEchoAsync().ConfigureAwait(false);
                await worker.EmitAsync(new { @event = "ready", language = "powershell", pid = Environment.ProcessId, version, welcome }).ConfigureAwait(false);
                Task receive = worker.ReceiveAsync();
                Task stdin = worker.InputAsync();
                await Task.WhenAny(receive, stdin).ConfigureAwait(false);
                worker.lifetime.Cancel();
                await worker.transport.CloseAsync().ConfigureAwait(false);
                await receive.ConfigureAwait(false);
                // Some platforms do not cancel a read already blocked on the standard-input pipe.
                // Keep process shutdown bounded; the reader owns no protocol/output after cancellation.
                try { await stdin.WaitAsync(TimeSpan.FromMilliseconds(1000)).ConfigureAwait(false); }
                catch (TimeoutException) { }
                return worker.exitCode;
            }
            catch (Exception ex)
            {
                await worker.FatalAsync(ex).ConfigureAwait(false);
                return 2;
            }
            finally
            {
                worker.lifetime.Cancel();
                await worker.transport.CloseAsync().ConfigureAwait(false);
                worker.transport.Dispose();
            }
        }

        private async Task EmitAsync(object value)
        {
            await EmitLineAsync(JsonSerializer.Serialize(value, jsonSerializerOptions)).ConfigureAwait(false);
        }

        private async Task EmitLineAsync(string line)
        {
            await outputGate.WaitAsync().ConfigureAwait(false);
            try { await output.WriteLineAsync(line).ConfigureAwait(false); }
            finally { outputGate.Release(); }
        }

        private static string Field(JsonElement value, string name)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out JsonElement field) || field.ValueKind != JsonValueKind.String) return null;
            try { return field.GetString(); }
            catch (InvalidOperationException) { return null; }
            catch (JsonException) { return null; }
        }
        private static BridgeFailure Failure(JsonElement frame) => new BridgeFailure(Field(frame, "code") ?? "HUB_REJECTED", Field(frame, "message") ?? "Hub rejected the frame.");

        // Preserve JSON string escapes and numeric lexemes, while keeping stdout as one NDJSON line.
        // This runs only after JsonDocument validates the complete raw JSON text.
        private static string CompactJsonForNdjson(string raw)
        {
            var compact = new StringBuilder(raw.Length);
            bool inString = false, escaped = false;
            foreach (char character in raw)
            {
                if (inString)
                {
                    compact.Append(character);
                    if (escaped) escaped = false;
                    else if (character == '\\') escaped = true;
                    else if (character == '"') inString = false;
                }
                else
                {
                    if (character == ' ' || character == '\t' || character == '\r' || character == '\n') continue;
                    compact.Append(character);
                    if (character == '"') inString = true;
                }
            }
            return compact.ToString();
        }

        private async Task EmitFrameAsync(string raw)
        {
            // JsonElement reserialization attempts to decode lone escaped surrogates and can throw.
            // The frame field remains a validated raw JSON value; raw remains the exact original text.
            await EmitLineAsync("{\"event\":\"frame\",\"frame\":" + CompactJsonForNdjson(raw) + ",\"raw\":" + JsonSerializer.Serialize(raw, jsonSerializerOptions) + "}").ConfigureAwait(false);
        }

        private string EchoResponse(JsonElement frame, JsonElement body)
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { MaxDepth = transport.MaxFrameBytes }))
            {
                writer.WriteStartObject();
                writer.WriteString("type", "respond");
                writer.WritePropertyName("requestSeq"); writer.WriteRawValue(frame.GetProperty("seq").GetRawText(), skipInputValidation: true);
                writer.WritePropertyName("body"); writer.WriteStartObject();
                writer.WriteString("fixture", "phase7");
                writer.WritePropertyName("steps"); writer.WriteStartArray();
                if (body.TryGetProperty("steps", out JsonElement previous) && previous.ValueKind == JsonValueKind.Array)
                    foreach (JsonElement step in previous.EnumerateArray()) writer.WriteRawValue(step.GetRawText(), skipInputValidation: true);
                writer.WriteStringValue("powershell"); writer.WriteEndArray();
                if (body.TryGetProperty("runId", out JsonElement runId)) { writer.WritePropertyName("runId"); writer.WriteRawValue(runId.GetRawText(), skipInputValidation: true); }
                if (body.TryGetProperty("payload", out JsonElement payload)) { writer.WritePropertyName("payload"); writer.WriteRawValue(payload.GetRawText(), skipInputValidation: true); }
                writer.WriteEndObject();
                writer.WriteString("requestToken", Guid.NewGuid().ToString());
                writer.WriteEndObject();
            }
            return Encoding.UTF8.GetString(buffer.ToArray());
        }

        private async Task<JsonElement> FrameAsync(string raw)
        {
            using JsonDocument document = JsonDocument.Parse(raw, jsonDocumentOptions);
            JsonElement frame = document.RootElement.Clone();
            await EmitFrameAsync(raw).ConfigureAwait(false);
            if (!string.IsNullOrEmpty(echoTopic) && Field(frame, "type") == "delivery" && Field(frame, "operation") == "request" && Field(frame, "topic") == echoTopic)
            {
                if (frame.TryGetProperty("body", out JsonElement body) && Field(body, "fixture") == "phase7")
                {
                    await transport.SendRawAsync(EchoResponse(frame, body), timeoutMs).ConfigureAwait(false);
                }
            }
            return frame;
        }

        private async Task SubscribeEchoAsync()
        {
            string token = Guid.NewGuid().ToString();
            await transport.SendRawAsync(JsonSerializer.Serialize(new { type = "subscribe", token, filters = new[] { echoTopic }, from = "now", operations = new[] { "request" } }), timeoutMs).ConfigureAwait(false);
            string subscription = null;
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                int remaining = Math.Max(1, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
                JsonElement frame = await FrameAsync(await transport.ReceiveRawAsync(remaining).ConfigureAwait(false)).ConfigureAwait(false);
                string type = Field(frame, "type");
                if (type == "denied" || type == "error") throw Failure(frame);
                if (type == "subscribed" && Field(frame, "token") == token) subscription = Field(frame, "subscription");
                if (type == "caught_up" && subscription != null && Field(frame, "subscription") == subscription) return;
            }
            throw new BridgeFailure("SUBSCRIBE_TIMEOUT", "Echo subscription barrier deadline expired.");
        }

        private async Task ReceiveAsync()
        {
            try
            {
                while (!lifetime.IsCancellationRequested)
                {
                    string raw;
                    try { raw = await transport.ReceiveRawAsync(1000).ConfigureAwait(false); }
                    catch (BridgeFailure ex) when (ex.Code == "FRAME_TIMEOUT") { continue; }
                    await FrameAsync(raw).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                if (Volatile.Read(ref requestedClose) == 0 && !lifetime.IsCancellationRequested) await FatalAsync(ex).ConfigureAwait(false);
            }
            finally { lifetime.Cancel(); }
        }

        private async Task FatalAsync(Exception ex)
        {
            Interlocked.Exchange(ref exitCode, 2);
            var failure = ex as BridgeFailure;
            await EmitAsync(new { @event = "error", error = new { code = failure?.Code ?? "WORKER_FAILED", message = ex.Message } }).ConfigureAwait(false);
        }

        private async Task InputAsync()
        {
            try
            {
                var pending = new StringBuilder();
                char[] buffer = new char[4096];
                while (!lifetime.IsCancellationRequested)
                {
                    int count = await input.ReadAsync(buffer.AsMemory(), lifetime.Token).ConfigureAwait(false);
                    if (count == 0)
                    {
                        if (pending.Length > 0 && await CommandAsync(pending.ToString()).ConfigureAwait(false)) return;
                        Interlocked.Exchange(ref requestedClose, 1);
                        return;
                    }
                    for (int i = 0; i < count; i++)
                    {
                        if (buffer[i] == '\n')
                        {
                            string line = pending.ToString().TrimEnd('\r'); pending.Clear();
                            if (line.Length > 0 && await CommandAsync(line).ConfigureAwait(false)) return;
                        }
                        else
                        {
                            pending.Append(buffer[i]);
                            if (pending.Length > maxCommandChars) throw new BridgeFailure("COMMAND_TOO_LARGE", "NDJSON command exceeds the configured bounded input limit.");
                        }
                    }
                }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            catch (Exception ex) { await FatalAsync(ex).ConfigureAwait(false); }
            finally { lifetime.Cancel(); }
        }

        private async Task<bool> CommandAsync(string line)
        {
            object id = null;
            try
            {
                using JsonDocument document = JsonDocument.Parse(line, jsonDocumentOptions);
                JsonElement command = document.RootElement;
                if (command.ValueKind == JsonValueKind.Object && command.TryGetProperty("id", out JsonElement fieldId)) id = fieldId.Clone();
                string action = command.ValueKind == JsonValueKind.String ? "send" : Field(command, "action");
                if (action == "close")
                {
                    Interlocked.Exchange(ref requestedClose, 1);
                    await transport.CloseAsync().ConfigureAwait(false);
                    await EmitAsync(new { id, ok = true }).ConfigureAwait(false);
                    return true;
                }
                if (action != "send") throw new BridgeFailure("COMMAND_UNKNOWN", "Expected action send or close.");
                string raw;
                if (command.ValueKind == JsonValueKind.String) raw = command.GetString();
                else if (command.TryGetProperty("raw", out JsonElement rawValue) && rawValue.ValueKind == JsonValueKind.String) raw = rawValue.GetString();
                else if (command.TryGetProperty("frame", out JsonElement frame) && frame.ValueKind == JsonValueKind.Object) raw = frame.GetRawText();
                else throw new BridgeFailure("COMMAND_INVALID", "send requires a frame object or raw string.");
                await transport.SendRawAsync(raw, timeoutMs).ConfigureAwait(false);
                await EmitAsync(new { id, ok = true }).ConfigureAwait(false);
                return false;
            }
            catch (Exception ex)
            {
                var failure = ex as BridgeFailure;
                await EmitAsync(new { id, ok = false, error = new { code = failure?.Code ?? "COMMAND_INVALID", message = ex.Message } }).ConfigureAwait(false);
                if (failure?.Code == "WS_CLOSED" || failure?.Code == "SEND_FAILED" || failure?.Code == "SEND_TIMEOUT")
                {
                    await FatalAsync(ex).ConfigureAwait(false);
                    return true;
                }
                return false;
            }
        }
    }
}
