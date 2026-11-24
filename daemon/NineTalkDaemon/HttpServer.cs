using System.Net;
using System.Text;
using System.Text.Json;

namespace NineTalkDaemon;

/// <summary>
/// Local API for the web dashboard (contract: DAEMON_API.md) on http://localhost:47301/.
/// Only the dashboard origin may call it: requests carrying any other Origin are refused outright,
/// not just left without CORS headers, so another site cannot start a sync with a "simple" request.
/// </summary>
sealed class HttpServer : IDisposable
{
    public const int Port = 47301;
    public const string Version = "0.1.9";

    static readonly JsonSerializerOptions Json = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    readonly HttpListener listener = new();
    readonly FriendSync sync;
    readonly SendService sender;
    readonly HashSet<string> allowedOrigins;

    public HttpServer(FriendSync sync, SendService sender)
    {
        this.sync = sync;
        this.sender = sender;
        // localhost:3000 = web dev server, 127.0.0.1:47300 = the desktop app (desktop/main.js).
        var origins = Environment.GetEnvironmentVariable("NINETALK_ALLOWED_ORIGINS") ?? "http://localhost:3000,http://127.0.0.1:47300";
        allowedOrigins = new HashSet<string>(origins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        // A "localhost" prefix also makes http.sys reject other Host headers (DNS rebinding).
        listener.Prefixes.Add($"http://localhost:{Port}/");
    }

    public IReadOnlyCollection<string> AllowedOrigins => allowedOrigins;

    /// <summary>POST /shutdown: the desktop app asks for a normal exit (tray icon removed, KakaoTalk window restored).</summary>
    public event Action? ShutdownRequested;

    public void Start()
    {
        listener.Start();
        _ = Task.Run(AcceptLoop);
    }

    async Task AcceptLoop()
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = await listener.GetContextAsync(); }
            catch (Exception) when (!listener.IsListening) { return; }
            catch (HttpListenerException) { continue; }
            _ = Task.Run(() => Handle(ctx));
        }
    }

    async Task Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        var origin = req.Headers["Origin"];
        try
        {
            if (origin is not null && !allowedOrigins.Contains(origin))
            {
                await Send(res, null, 403, new { ok = false, error = "origin not allowed" });
                return;
            }

            if (req.HttpMethod == "OPTIONS")
            {
                if (origin is null) { await Send(res, null, 403, null); return; }
                res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                res.Headers["Access-Control-Allow-Headers"] = "Content-Type";
                res.Headers["Access-Control-Allow-Private-Network"] = "true";
                res.Headers["Access-Control-Max-Age"] = "600";
                await Send(res, origin, 204, null);
                return;
            }

            var path = req.Url?.AbsolutePath ?? "/";
            switch (req.HttpMethod, path)
            {
                case ("GET", "/status"):
                    if (sender.IsRunning)
                    {
                        await Send(res, origin, 200, new { status = "SendMessage", version = Version, images = true, files = true, current_sent_order = sender.Processed, last_error = (string?)null });
                        break;
                    }
                    var (status, count, error) = sync.Status();
                    // images / files: this PC program can send images and other files (POST /send "images", "files").
                    await Send(res, origin, 200, new { status, version = Version, images = true, files = true, current_sync_cnt = count, last_error = error });
                    break;

                case ("POST", "/send"):
                    await StartSend(req, res, origin);
                    break;

                case ("GET", "/send/result"):
                    var (jobId, state, results) = sender.Snapshot();
                    await Send(res, origin, 200, new
                    {
                        job_id = jobId,
                        state,
                        results = results.Select(r => r.Error is null
                            ? (object)new { id = r.Id, status = r.Status }
                            : new { id = r.Id, status = r.Status, error = r.Error }),
                    });
                    break;

                case ("POST", "/send/stop"):
                    sender.Stop();
                    await Send(res, origin, 202, new { ok = true });
                    break;

                case ("POST", "/shutdown"):
                    if (req.ContentType?.StartsWith("application/json") != true)
                    {
                        await Send(res, origin, 415, new { ok = false, error = "Content-Type must be application/json" });
                        break;
                    }
                    await Send(res, origin, 202, new { ok = true });
                    ShutdownRequested?.Invoke();
                    break;

                case ("POST", "/friends/synchronize"):
                    await Synchronize(req, res, origin);
                    break;

                case ("GET", "/friends"):
                    var (friends, summary) = sync.Result();
                    await Send(res, origin, 200, new
                    {
                        friend_list = friends.Select(f => new { name = f.Name, ocr_uncertain = f.Uncertain }),
                        duplicate_friend_list = friends.GroupBy(f => f.Name).Where(g => g.Count() > 1).Select(g => g.Key),
                        // Additions to the contract, for showing how complete the OCR read was:
                        // kakao_friend_count = "친구 N" in KakaoTalk, unreadable_count = rows whose name OCR missed.
                        kakao_friend_count = summary?.Expected,
                        unreadable_count = summary?.Unreadable ?? 0,
                    });
                    break;

                default:
                    await Send(res, origin, 404, new { ok = false, error = "not found" });
                    break;
            }
        }
        catch (Exception ex)
        {
            try { await Send(res, origin, 500, new { ok = false, error = ex.Message }); } catch { }
        }
    }

    async Task Synchronize(HttpListenerRequest req, HttpListenerResponse res, string? origin)
    {
        if (req.ContentType?.StartsWith("application/json") != true)
        {
            await Send(res, origin, 415, new { ok = false, error = "Content-Type must be application/json" });
            return;
        }
        using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
        var body = JsonSerializer.Deserialize<SyncRequest>(await reader.ReadToEndAsync(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        switch (body?.Mode)
        {
            case "Stop":
                sync.Stop();
                await Send(res, origin, 202, new { ok = true });
                return;
            case "Start-all":
            case "Start-search":
                var keyword = body.Mode == "Start-search" ? body.Option?.Trim() ?? "" : "";
                var refused = sync.TryStart(keyword);
                if (refused is null) await Send(res, origin, 202, new { ok = true });
                else await Send(res, origin, 409, new { ok = false, status = refused });
                return;
            default:
                await Send(res, origin, 400, new { ok = false, error = "unknown mode" });
                return;
        }
    }

    async Task StartSend(HttpListenerRequest req, HttpListenerResponse res, string? origin)
    {
        if (req.ContentType?.StartsWith("application/json") != true)
        {
            await Send(res, origin, 415, new { ok = false, error = "Content-Type must be application/json" });
            return;
        }
        using var reader = new StreamReader(req.InputStream, Encoding.UTF8);
        var body = JsonSerializer.Deserialize<SendRequest>(await reader.ReadToEndAsync(),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower });
        if (body?.Recipients is not { Count: > 0 } recipients || recipients.Any(r => string.IsNullOrWhiteSpace(r.Name)))
        {
            await Send(res, origin, 400, new { ok = false, error = "recipients required" });
            return;
        }
        // Refused up front, so broken data fails once instead of once per recipient.
        // WebP and HEIC photos cannot be pasted as pictures here (GDI+ cannot open them): they go as files.
        var sentImages = body.Images ?? new List<SendImage>();
        var asFiles = sentImages.Where(i => FileOnlyImageMimes.Contains(i.Mime ?? "")).ToList();
        var (images, imageError) = DecodeImages(sentImages.Where(i => !FileOnlyImageMimes.Contains(i.Mime ?? "")).ToList());
        if (imageError is not null)
        {
            await Send(res, origin, 400, new { ok = false, error = imageError });
            return;
        }
        var (files, fileError) = DecodeFiles(asFiles.Select((i, n) => i with { Name = string.IsNullOrWhiteSpace(i.Name) ? $"사진{n + 1}.{i.Mime!.Split('/')[1]}" : i.Name })
            .Concat(body.Files ?? new List<SendImage>()).ToList());
        if (fileError is not null)
        {
            await Send(res, origin, 400, new { ok = false, error = fileError });
            return;
        }
        if (images.Count + files.Count > MaxAttachments)
        {
            await Send(res, origin, 400, new { ok = false, error = $"at most {MaxAttachments} attachments" });
            return;
        }
        if (images.Count + files.Count == 0 && recipients.Any(r => string.IsNullOrWhiteSpace(r.Text)))
        {
            await Send(res, origin, 400, new { ok = false, error = "text or images required" });
            return;
        }
        var refused = sender.TryStart(body.JobId, recipients.Select(r => new SendService.Recipient(r.Id, r.Name!.Trim(), r.Text)).ToList(),
            SendService.Settings.From(body.IntervalMs, body.SpeedRate, body.SplitSendCount, body.SendMode),
            attachments: new SendService.Attachments(images, files, body.ImageFirst));
        if (refused is null) await Send(res, origin, 202, new { ok = true });
        else await Send(res, origin, 409, new { ok = false, status = refused });
    }

    const int MaxImages = 5, MaxImageBytes = 10 * 1024 * 1024, MaxAttachments = 5, MaxFileBytes = 20 * 1024 * 1024;
    /// <summary>Programs and scripts are never sent (the dashboard refuses them too).</summary>
    static readonly HashSet<string> BlockedExtensions = new(StringComparer.OrdinalIgnoreCase)
        { ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".js", ".jse", ".wsf", ".dll", ".lnk", ".app", ".pkg", ".dmg", ".sh" };

    /// <summary>
    /// Base64 files from POST /send. The name is what the recipient sees, so it is kept, but only as a plain
    /// file name: no folders, no characters Windows does not allow, no program types.
    /// </summary>
    static (List<SendService.SendFile> files, string? error) DecodeFiles(List<SendImage>? files)
    {
        var list = new List<SendService.SendFile>();
        if (files is not { Count: > 0 }) return (list, null);
        if (files.Count > MaxAttachments) return (list, $"at most {MaxAttachments} attachments");
        foreach (var file in files)
        {
            var name = Path.GetFileName((file.Name ?? "").Replace('/', '\\'));
            foreach (var bad in Path.GetInvalidFileNameChars()) name = name.Replace(bad, '_');
            name = name.Trim().TrimEnd('.', ' ');
            if (ReservedNames.Contains(name.Split('.')[0].Trim())) name = "_" + name;
            if (name.Length == 0 || name.Length > 150 || BlockedExtensions.Contains(Path.GetExtension(name))) return (list, "file name not allowed");
            byte[] data;
            try { data = Convert.FromBase64String(file.DataBase64 ?? ""); }
            catch (FormatException) { return (list, "file too large or empty"); }
            if (data.Length == 0 || data.Length > MaxFileBytes) return (list, "file too large or empty");
            list.Add(new SendService.SendFile(name, data));
        }
        return (list, null);
    }
    static readonly HashSet<string> ImageMimes = new(StringComparer.OrdinalIgnoreCase) { "image/png", "image/jpeg", "image/jpg", "image/gif", "image/bmp" };
    static readonly HashSet<string> FileOnlyImageMimes = new(StringComparer.OrdinalIgnoreCase) { "image/webp", "image/heic", "image/heif" };
    /// <summary>Device names Windows reserves: a file cannot be called CON.pdf or com1.hwp.</summary>
    static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
        { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
          "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" };

    /// <summary>Base64 images from POST /send, checked to be small images this PC can decode (no WebP/HEIC).</summary>
    static (List<byte[]> images, string? error) DecodeImages(List<SendImage>? images)
    {
        var list = new List<byte[]>();
        if (images is not { Count: > 0 }) return (list, null);
        if (images.Count > MaxImages) return (list, $"at most {MaxImages} images");
        foreach (var image in images)
        {
            if (!ImageMimes.Contains(image.Mime ?? "")) return (list, "unsupported image type");
            byte[] data;
            try { data = Convert.FromBase64String(image.DataBase64 ?? ""); }
            catch (FormatException) { return (list, "not a valid image"); }
            if (data.Length == 0 || data.Length > MaxImageBytes) return (list, "image too large or empty");
            if (!ClipboardImage.CanDecode(data)) return (list, "not a valid image");
            list.Add(data);
        }
        return (list, null);
    }

    sealed record SendRecipient(long Id, string? Name, string? Text);
    sealed record SendImage(string? Name, string? Mime, string? DataBase64);
    sealed record SendRequest(
        long JobId, List<SendRecipient>? Recipients, List<SendImage>? Images, List<SendImage>? Files, bool ImageFirst,
        int? SpeedRate, int? SplitSendCount, int? IntervalMs, string? SendMode);

    static async Task Send(HttpListenerResponse res, string? origin, int code, object? body)
    {
        // Refused or failed requests (not "busy", 409, which is an ordinary answer).
        if (code >= 400 && code != 409) ErrorLog.Add("요청", $"{code} {(body is null ? "" : JsonSerializer.Serialize(body, Json))}");
        res.StatusCode = code;
        if (origin is not null)
        {
            res.Headers["Access-Control-Allow-Origin"] = origin;
            res.Headers["Vary"] = "Origin";
        }
        if (body is not null)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(body, Json);
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            await res.OutputStream.WriteAsync(bytes);
        }
        res.Close();
    }

    public void Dispose()
    {
        if (listener.IsListening) listener.Stop();
        listener.Close();
    }

    sealed record SyncRequest(string? Mode, string? Option);
}
