using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace WorldHub.Phase7
{
    public sealed class BridgeFailure : Exception
    {
        public string Code { get; }
        public BridgeFailure(string code, string message, Exception inner = null) : base(message, inner) { Code = code; }
    }

    // Only transport: no topics, application fields, ACK, release, retry or business dispatch.
    public sealed class HubBridge : IDisposable
    {
        private readonly ClientWebSocket socket = new ClientWebSocket();
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly SemaphoreSlim sendGate = new SemaphoreSlim(1, 1);
        private readonly Channel<ReceivedText> incoming = Channel.CreateBounded<ReceivedText>(new BoundedChannelOptions(128) { SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
        private readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
        private Task receiver;
        private long bufferedBytes;
        private int closing;
        public int MaxFrameBytes { get; }
        public long MaxBufferedBytes { get; }
        public string State => socket.State.ToString();
        private sealed class ReceivedText { public string Raw; public int Bytes; }

        public HubBridge(int maxFrameBytes = 4194304, long maxBufferedBytes = 8388608)
        {
            if (maxFrameBytes < 1 || maxBufferedBytes < maxFrameBytes) throw new ArgumentOutOfRangeException(nameof(maxFrameBytes));
            MaxFrameBytes = maxFrameBytes;
            MaxBufferedBytes = maxBufferedBytes;
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        }

        public async Task ConnectAsync(string url, int timeoutMs = 10000)
        {
            if (timeoutMs < 1) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(timeoutMs);
            try { await socket.ConnectAsync(new Uri(url), timeout.Token).ConfigureAwait(false); }
            catch (OperationCanceledException ex) { socket.Abort(); throw new BridgeFailure("CONNECT_TIMEOUT", "WebSocket connection deadline expired.", ex); }
            catch (Exception ex) { socket.Abort(); throw new BridgeFailure("CONNECT_FAILED", ex.Message, ex); }
            receiver = ReceiveLoopAsync();
        }

        public async Task SendRawAsync(string raw, int timeoutMs = 10000)
        {
            if (raw == null) throw new ArgumentNullException(nameof(raw));
            if (timeoutMs < 1) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
            byte[] bytes = utf8.GetBytes(raw);
            if (bytes.Length > MaxFrameBytes) throw new BridgeFailure("FRAME_TOO_LARGE", "Outgoing UTF-8 frame exceeds the configured byte limit.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(timeoutMs);
            bool held = false;
            try
            {
                await sendGate.WaitAsync(timeout.Token).ConfigureAwait(false); held = true;
                if (socket.State != WebSocketState.Open) throw new BridgeFailure("WS_CLOSED", "Cannot send while WebSocket is " + socket.State + ".");
                await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, timeout.Token).ConfigureAwait(false);
            }
            catch (BridgeFailure) { throw; }
            catch (OperationCanceledException ex) { throw new BridgeFailure("SEND_TIMEOUT", "WebSocket send deadline expired or connection closed.", ex); }
            catch (Exception ex) { throw new BridgeFailure("SEND_FAILED", ex.Message, ex); }
            finally { if (held) sendGate.Release(); }
        }

        public async Task<string> ReceiveRawAsync(int timeoutMs = 10000)
        {
            if (timeoutMs < 1) throw new ArgumentOutOfRangeException(nameof(timeoutMs));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            timeout.CancelAfter(timeoutMs);
            try
            {
                ReceivedText frame = await incoming.Reader.ReadAsync(timeout.Token).ConfigureAwait(false);
                Interlocked.Add(ref bufferedBytes, -frame.Bytes);
                return frame.Raw;
            }
            catch (OperationCanceledException ex) { throw new BridgeFailure(lifetime.IsCancellationRequested ? "WS_CLOSED" : "FRAME_TIMEOUT", "Frame wait deadline expired or connection closed.", ex); }
            catch (ChannelClosedException ex)
            {
                if (ex.InnerException is BridgeFailure failure) throw failure;
                throw new BridgeFailure("WS_CLOSED", "WebSocket receive stream closed.", ex.InnerException ?? ex);
            }
        }

        private async Task ReceiveLoopAsync()
        {
            Exception failure = null;
            try
            {
                byte[] chunk = new byte[16384];
                using var frame = new MemoryStream();
                CancellationTokenSource partial = null;
                try
                {
                    while (!lifetime.IsCancellationRequested)
                    {
                        WebSocketReceiveResult result = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), partial?.Token ?? lifetime.Token).ConfigureAwait(false);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            throw new BridgeFailure("WS_CLOSED", "Remote WebSocket close " + ((int?)result.CloseStatus)?.ToString() + ": " + result.CloseStatusDescription);
                        }
                        if (result.MessageType != WebSocketMessageType.Text) throw new BridgeFailure("FRAME_NOT_TEXT", "Hub binding accepts UTF-8 text frames only.");
                        if (frame.Length + result.Count > MaxFrameBytes) throw new BridgeFailure("FRAME_TOO_LARGE", "Incoming UTF-8 frame exceeds the configured byte limit.");
                        frame.Write(chunk, 0, result.Count);
                        if (!result.EndOfMessage)
                        {
                            if (partial == null) { partial = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); partial.CancelAfter(30000); }
                            continue;
                        }
                        partial?.Dispose(); partial = null;
                        int count = checked((int)frame.Length);
                        string raw = utf8.GetString(frame.GetBuffer(), 0, count);
                        frame.SetLength(0);
                        long bytes = Interlocked.Add(ref bufferedBytes, count);
                        if (bytes > MaxBufferedBytes || !incoming.Writer.TryWrite(new ReceivedText { Raw = raw, Bytes = count }))
                        {
                            Interlocked.Add(ref bufferedBytes, -count);
                            throw new BridgeFailure("RECEIVE_BUFFER_LIMIT", "Consumer exceeded the bounded receive queue; reconnect/recovery belongs to the program.");
                        }
                    }
                }
                finally { partial?.Dispose(); }
            }
            catch (BridgeFailure ex) { failure = ex; }
            catch (OperationCanceledException ex) { failure = new BridgeFailure(lifetime.IsCancellationRequested ? "WS_CLOSED" : "FRAME_TIMEOUT", "Connection closed or fragmented frame deadline expired.", ex); }
            catch (DecoderFallbackException ex) { failure = new BridgeFailure("FRAME_UTF8_INVALID", "Incoming frame is not valid UTF-8.", ex); }
            catch (Exception ex) { failure = new BridgeFailure("RECEIVE_FAILED", ex.Message, ex); }
            finally
            {
                incoming.Writer.TryComplete(failure);
                if (Volatile.Read(ref closing) == 0) socket.Abort();
            }
        }

        public async Task CloseAsync(int timeoutMs = 2000)
        {
            if (Interlocked.Exchange(ref closing, 1) != 0) return;
            using var timeout = new CancellationTokenSource(timeoutMs);
            bool held = false;
            try
            {
                await sendGate.WaitAsync(timeout.Token).ConfigureAwait(false); held = true;
                if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "program closed", timeout.Token).ConfigureAwait(false);
                if (receiver != null) await receiver.WaitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
            finally { if (held) sendGate.Release(); lifetime.Cancel(); socket.Abort(); incoming.Writer.TryComplete(); }
        }

        public void Dispose() { lifetime.Cancel(); socket.Abort(); socket.Dispose(); lifetime.Dispose(); }
    }
}
